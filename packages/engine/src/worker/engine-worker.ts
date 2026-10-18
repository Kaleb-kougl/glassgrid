/*
 * The web demo's engine: a dedicated Web Worker that runs the shared engine
 * (QueryService + EngineSession, exactly as Electron's utility process
 * does) on DuckDB-WASM's synchronous build, in this same thread.
 *
 * - The page talks to it with the engine protocol (packages/core) over
 *   postMessage, plus `gg:` control messages (worker/protocol.ts) for
 *   start-up and data sources. Arrow IPC results travel as transferred
 *   ArrayBuffers.
 * - Threads: the EH (exception-handling) single-thread build, or MVP where
 *   WebAssembly exceptions are missing. DuckDB-WASM's multithreaded COI
 *   build needs cross-origin isolation and pthread workers, which the
 *   synchronous bindings do not support; see docs/m4-engine-portability.md.
 */
import { config as zodConfig } from 'zod';
import type { EngineResponse } from '@glassgrid/core';
import { errorMessage } from '../errors';
import { QueryService } from '../query-service';
import { EngineSession } from '../session';
import type { WasmBindings } from '../wasm/bindings';
import { WasmDriver } from '../wasm/driver';
import { BrowserFiles, CACHE_ROOT, SOURCE_ROOT, TEMP_ROOT } from './browser-files';
import { WorkerControlSchema, isControlMessage, type RegisterSource, type WorkerInit, type WorkerReply } from './protocol';
import type { DuckDriver } from '../driver';

interface BlockingModule {
  createDuckDB(
    bundles: { mvp: { mainModule: string; mainWorker: string }; eh?: { mainModule: string; mainWorker: string } },
    logger: unknown,
    runtime: unknown,
  ): Promise<WasmBindings & { instantiate(): Promise<unknown> }>;
  VoidLogger: new () => unknown;
  BROWSER_RUNTIME: unknown;
}

// The web demo's CSP refuses 'unsafe-eval' in this worker too: Zod's interpreted parsers, and no
// `new Function` probe (which the browser would report as a violation even though Zod catches it).
zodConfig({ jitless: true });

export const WEB_OUT_OF_MEMORY_MESSAGE = 'This file is too large for the web demo. Open it in the Glassgrid desktop app';
const DEFAULT_MAX_SOURCE_BYTES = 1024 ** 3;
const DEFAULT_WEB_AUTO_CONVERT_BYTES = 64 * 1024 ** 2;
const DEFAULT_WEB_CACHE_BYTES = 2 * 1024 ** 3;

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
  crossOriginIsolated?: boolean;
  location: { origin: string };
  navigator: { storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } };
};

function post(message: WorkerReply): void {
  scope.postMessage(message);
}

/** Engine responses: Arrow bytes are copied out of the result cache and transferred. */
function send(message: EngineResponse): void {
  if ((message.kind === 'arrow' || message.kind === 'aggregate') && message.ipc.byteLength > 0) {
    // The engine keeps `ipc` in its result cache, so transfer a copy (one memcpy, no structured clone).
    const ipc = message.ipc.slice();
    scope.postMessage({ ...message, ipc }, [ipc.buffer]);
    return;
  }
  scope.postMessage(message);
}

interface Started {
  service: QueryService;
  files: BrowserFiles;
  driver: DuckDriver;
  init: WorkerInit;
}

let started: Promise<Started> | null = null;
let session: EngineSession | null = null;
/** Engine requests that arrived before `gg:init`. */
const early: unknown[] = [];

async function start(init: WorkerInit): Promise<Started> {
  const duckdb = (await import('@duckdb/duckdb-wasm/blocking')) as unknown as BlockingModule;
  const bindings = await duckdb.createDuckDB(
    { mvp: { mainModule: init.bundles.mvp, mainWorker: '' }, eh: { mainModule: init.bundles.eh, mainWorker: '' } },
    new duckdb.VoidLogger(),
    duckdb.BROWSER_RUNTIME,
  );
  await bindings.instantiate();
  // The cache needs OPFS *and* sync access handles in workers (Chrome 102, Firefox 111, Safari 15.2);
  // without either (older browsers, some private modes) the engine runs without a cache (`cache: 'none'`).
  const opfs = hasSyncAccessHandles() ? ((await scope.navigator.storage?.getDirectory?.().catch(() => null)) ?? null) : null;
  const files = new BrowserFiles(bindings, opfs);
  const repository = init.extensionRepository;
  const driver = new WasmDriver({
    bindings,
    files,
    allowedRoots: [`${SOURCE_ROOT}/`, `${CACHE_ROOT}/`],
    ...(init.memoryLimitBytes === undefined ? {} : { memoryLimitBytes: init.memoryLimitBytes }),
    ...(repository === undefined ? {} : { extensions: { repository, load: init.extensions ?? ['parquet'] } }),
    outOfMemoryMessage: WEB_OUT_OF_MEMORY_MESSAGE,
    beforeStatement: files.prepare,
    afterStatement: files.finish,
    onFatal: (message) => post({ kind: 'gg:fatal', message }),
  });
  const service = await QueryService.create(driver, {
    cacheDir: CACHE_ROOT,
    tempDir: TEMP_ROOT,
    autoConvertMinBytes: files.hasCache ? (init.autoConvertMinBytes ?? DEFAULT_WEB_AUTO_CONVERT_BYTES) : Number.MAX_SAFE_INTEGER,
    parquetCacheMaxBytes: init.parquetCacheMaxBytes ?? DEFAULT_WEB_CACHE_BYTES,
  });
  const capabilities = driver.capabilities;
  post({
    kind: 'gg:ready',
    duckdbVersion: service.duckdbVersion,
    capabilities: {
      interrupt: capabilities.interrupt,
      progress: capabilities.progress,
      parquet: capabilities.parquet,
      cache: files.hasCache ? 'opfs' : 'none',
      crossOriginIsolated: scope.crossOriginIsolated === true,
    },
    extensionErrors: driver.extensionErrors,
  });
  return { service, files, driver, init };
}

function hasSyncAccessHandles(): boolean {
  const handle = (globalThis as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle;
  return handle !== undefined && 'createSyncAccessHandle' in handle.prototype;
}

/** See CacheSelfTestSchema. */
async function cacheSelfTest(requestId: string, mode: 'write' | 'read' | 'clean'): Promise<void> {
  const detail: Record<string, unknown> = { mode };
  try {
    if (!started) throw new Error('The engine has not been started');
    const { files, driver } = await started;
    const folder = `${CACHE_ROOT}/selftest`;
    const final = `${folder}/rows.csv`;
    if (mode === 'clean') {
      await files.remove(folder);
      detail['listed'] = await files.readdir(CACHE_ROOT);
      post({ kind: 'gg:cacheSelfTest', requestId, ok: true, detail });
      return;
    }
    const db = await driver.createDatabase({ allowedPaths: [], allowedDirectories: [CACHE_ROOT], tempDirectory: TEMP_ROOT, memoryLimitBytes: 0 });
    const connection = await db.connect();
    try {
      if (mode === 'write') {
        await files.mkdir(folder);
        const temp = `${final}.${Date.now()}.partial`;
        await connection.run(`COPY (SELECT range AS i, 'row ' || range AS s FROM range(10000)) TO '${temp}' (FORMAT csv, HEADER, USE_TMP_FILE false)`);
        detail['tempListed'] = await files.readdir(folder);
        detail['tempSize'] = (await files.stat(temp)).sizeBytes;
        detail['tempRead'] = (await connection.query(`SELECT count(*) FROM read_csv('${temp}')`)).rows.map((row) => row.map(Number));
        await files.rename(temp, final);
      }
      detail['listed'] = await files.readdir(folder);
      detail['stat'] = await files.stat(final);
      const result = await connection.query(`SELECT count(*) AS n, sum(i) AS total, max(s) AS last FROM read_csv('${final}')`);
      detail['rows'] = JSON.parse(JSON.stringify(result.rows, (_key, value: unknown) => (typeof value === 'bigint' ? Number(value) : value))) as unknown;
    } finally {
      connection.close();
      await db.close();
    }
    post({ kind: 'gg:cacheSelfTest', requestId, ok: true, detail });
  } catch (error) {
    post({ kind: 'gg:cacheSelfTest', requestId, ok: false, detail: { ...detail, error: errorMessage(error) } });
  }
}

async function registerSource(message: RegisterSource): Promise<void> {
  const { requestId, handle, source } = message;
  try {
    if (!started) throw new Error('The engine has not been started');
    const { service, files, init } = await started;
    const maxBytes = init.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
    if (source.kind === 'url') {
      const origins = init.allowedOrigins ?? [scope.location.origin];
      if (!origins.includes(new URL(source.url).origin)) {
        post({ kind: 'gg:registerFailed', requestId, code: 'not_allowed', message: `Sample data may only come from ${origins.join(', ')}` });
        return;
      }
    } else if (source.file.size > maxBytes) {
      post({ kind: 'gg:registerFailed', requestId, code: 'too_large', message: tooLarge(source.file.size, maxBytes) });
      return;
    }
    const registered = await files.registerSource(handle, source);
    if (registered.sizeBytes > maxBytes) {
      post({ kind: 'gg:registerFailed', requestId, code: 'too_large', message: tooLarge(registered.sizeBytes, maxBytes) });
      return;
    }
    service.registerFile(handle, registered.path);
    post({ kind: 'gg:sourceRegistered', requestId, handle, fileName: registered.fileName, sizeBytes: registered.sizeBytes });
  } catch (error) {
    post({ kind: 'gg:registerFailed', requestId, code: 'io_failed', message: errorMessage(error) });
  }
}

function tooLarge(sizeBytes: number, maxBytes: number): string {
  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `This file is ${gb(sizeBytes)}; the web demo opens files up to ${gb(maxBytes)}. Open it in the Glassgrid desktop app`;
}

scope.onmessage = (event: MessageEvent) => {
  const data: unknown = event.data;
  if (isControlMessage(data)) {
    const parsed = WorkerControlSchema.safeParse(data);
    if (!parsed.success) {
      console.error('[engine-worker] dropped malformed control message', parsed.error.issues);
      return;
    }
    const control = parsed.data;
    if (control.kind === 'gg:init') {
      if (started) return;
      started = start(control);
      started.catch((error: unknown) => post({ kind: 'gg:fatal', message: `DuckDB-WASM failed to start: ${errorMessage(error)}` }));
      session = new EngineSession(
        started.then(({ service }) => service),
        send,
      );
      for (const request of early.splice(0)) session.handle(request);
      return;
    }
    if (control.kind === 'gg:cacheSelfTest') void cacheSelfTest(control.requestId, control.mode);
    else void registerSource(control);
    return;
  }
  if (session) session.handle(data);
  else early.push(data);
};

self.addEventListener('unhandledrejection', (event) => {
  console.error('[engine-worker] unhandled rejection', (event).reason);
});
