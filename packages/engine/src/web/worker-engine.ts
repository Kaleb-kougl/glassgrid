import { toFileHandle, type FileHandle } from '@glassgrid/core';
import { EngineRequestError, PortEngineClient } from '../client/port-client';
import type { EngineClientApi } from '../client/types';
import type { Source, WorkerCapabilities, WorkerInit, WorkerReply } from '../worker/protocol';
import { DEFAULT_DUCKDB_BUNDLES } from './bundles';

/*
 * The web demo's engine client: the same API as the desktop renderer's
 * EngineClient (EngineClientApi), backed by a dedicated Web Worker that runs
 * the shared engine on DuckDB-WASM (worker/engine-worker.ts).
 *
 *   const engine = createWorkerEngine();
 *   const { handle } = await engine.registerFile(file);      // a picked or dropped File
 *   const { table } = await engine.open(handle);              // then exactly as on the desktop
 *   const page = await engine.pageFetcher(table.id, { sort })(0, 1000);
 *
 * The page plays Electron main's part: it registers data sources (a `File`,
 * or a sample dataset URL on an allowed origin) and gets opaque file
 * handles back. If the worker dies (a WebAssembly trap such as running out
 * of memory), the client starts a new one, registers the same sources under
 * the same handles, rejects in-flight requests with `engine_restarted` and
 * fires `onRestarted`, like an engine restart on the desktop.
 */

export interface WorkerEngineOptions extends Omit<WorkerInit, 'kind' | 'bundles'> {
  /** URLs of `duckdb-eh.wasm` and `duckdb-mvp.wasm` (default: bundled with the app by Vite). */
  bundles?: WorkerInit['bundles'];
  /** How to start the worker (default: the bundled engine worker, as an ES module worker). */
  createWorker?: () => Worker;
  /** Restarts allowed within a minute before the client gives up (default 3). */
  maxRestarts?: number;
  /**
   * `eager` (default) starts the worker at once. `lazy` waits for `start()`
   * or the first thing that needs the engine (a registration or a request),
   * so a page that never opens data never downloads DuckDB-WASM.
   */
  start?: 'eager' | 'lazy';
}

export interface RegisteredSource {
  handle: FileHandle;
  fileName: string;
  sizeBytes: number;
}

export interface WorkerEngineInfo {
  duckdbVersion: string;
  capabilities: WorkerCapabilities;
  /** Extensions that failed to load (e.g. `parquet: ...` when the extension repository is unreachable). */
  extensionErrors: string[];
}

/** `EngineClientApi` plus what the browser needs: sources, start-up info and shutdown. */
export interface WorkerEngine extends EngineClientApi {
  /** Resolves once DuckDB-WASM is running (again after a restart). With `start: 'lazy'`, it waits for the start. */
  readonly ready: Promise<WorkerEngineInfo>;
  /** True once the worker was started (always, unless `start: 'lazy'` and nothing needed it yet). */
  readonly started: boolean;
  /** Start the worker now if it is not running yet (lazy engines: warm up on a hint of intent). Idempotent. */
  start(): void;
  /** Register a picked or dropped file; open it with `open(handle)`. Files over `maxSourceBytes` are refused (`too_large`). */
  registerFile(file: File): Promise<RegisteredSource>;
  /** Register a sample dataset (CSV or Parquet) by URL; only `allowedOrigins` (default: this origin). */
  registerUrl(url: string, options?: { name?: string }): Promise<RegisteredSource>;
  /** Diagnostics: the OPFS cache round trip (see CacheSelfTestSchema). */
  cacheSelfTest(mode: 'write' | 'read' | 'clean'): Promise<{ ok: boolean; detail: Record<string, unknown> }>;
  /** Stop the worker for good. */
  terminate(): void;
}

function defaultWorker(): Worker {
  return new Worker(new URL('../worker/engine-worker.ts', import.meta.url), { type: 'module', name: 'glassgrid-engine' });
}

interface PendingSource {
  resolve: (value: RegisteredSource) => void;
  reject: (error: Error) => void;
}

class WorkerEngineClient extends PortEngineClient implements WorkerEngine {
  private worker: Worker | null = null;
  private readonly init: WorkerInit;
  private readonly sources = new Map<FileHandle, Source>();
  private readonly registering = new Map<string, PendingSource>();
  private readonly selfTests = new Map<string, (result: { ok: boolean; detail: Record<string, unknown> }) => void>();
  private readonly restarts: number[] = [];
  private nextRegistration = 0;
  private resolveReady: (info: WorkerEngineInfo) => void = () => undefined;
  private rejectReady: (error: Error) => void = () => undefined;
  ready: Promise<WorkerEngineInfo>;
  private terminated = false;
  started = false;

  constructor(private readonly options: WorkerEngineOptions) {
    super((message) => this.onWorkerMessage(message));
    const { bundles, createWorker: _createWorker, maxRestarts: _maxRestarts, ...rest } = options;
    this.init = { kind: 'gg:init', bundles: bundles ?? DEFAULT_DUCKDB_BUNDLES, ...rest };
    this.ready = this.newReady();
    if (options.start !== 'lazy') this.start();
  }

  start(): void {
    if (this.started || this.terminated) return;
    this.started = true;
    this.spawn();
  }

  protected override onPortWanted(): void {
    this.start();
  }

  registerFile(file: File): Promise<RegisteredSource> {
    return this.register({ kind: 'file', file });
  }

  registerUrl(url: string, options: { name?: string } = {}): Promise<RegisteredSource> {
    const absolute = new URL(url, globalThis.location.href).href;
    return this.register({ kind: 'url', url: absolute, ...(options.name === undefined ? {} : { name: options.name }) });
  }

  cacheSelfTest(mode: 'write' | 'read' | 'clean'): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
    this.start();
    const worker = this.worker;
    if (!worker) return Promise.reject(new EngineRequestError('engine_unavailable', 'The engine is not running'));
    this.nextRegistration += 1;
    const requestId = `selftest-${this.nextRegistration}`;
    return new Promise((resolve) => {
      this.selfTests.set(requestId, resolve);
      worker.postMessage({ kind: 'gg:cacheSelfTest', requestId, mode });
    });
  }

  terminate(): void {
    this.terminated = true;
    this.worker?.terminate();
    this.worker = null;
    this.disconnect(new EngineRequestError('disposed', 'The engine was stopped'));
    for (const pending of this.registering.values()) pending.reject(new EngineRequestError('disposed', 'The engine was stopped'));
    this.registering.clear();
  }

  override dispose(): void {
    this.terminate();
    super.dispose();
  }

  private newReady(): Promise<WorkerEngineInfo> {
    const ready = new Promise<WorkerEngineInfo>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    ready.catch(() => undefined);
    return ready;
  }

  private spawn(): void {
    const worker = (this.options.createWorker ?? defaultWorker)();
    this.worker = worker;
    worker.onerror = (event) => {
      event.preventDefault();
      this.restart(`The engine worker failed: ${event.message}`);
    };
    worker.postMessage(this.init);
    // Sources registered before a restart come back under the same handles, so table ids stay valid.
    for (const [handle, source] of this.sources) worker.postMessage({ kind: 'gg:registerSource', requestId: `replay-${handle}`, handle, source });
    this.adoptPort(worker);
  }

  private restart(reason: string): void {
    if (this.terminated) return;
    const now = Date.now();
    while (this.restarts.length > 0 && now - (this.restarts[0] ?? now) > 60_000) this.restarts.shift();
    this.worker?.terminate();
    this.worker = null;
    if (this.restarts.length >= (this.options.maxRestarts ?? 3)) {
      this.rejectReady(new EngineRequestError('engine_unavailable', reason));
      this.disconnect(new EngineRequestError('engine_unavailable', reason));
      return;
    }
    this.restarts.push(now);
    this.ready = this.newReady();
    this.spawn();
  }

  private register(source: Source): Promise<RegisteredSource> {
    this.start();
    const worker = this.worker;
    if (!worker) return Promise.reject(new EngineRequestError('engine_unavailable', 'The engine is not running'));
    const handle = toFileHandle(crypto.randomUUID());
    this.nextRegistration += 1;
    const requestId = `src-${this.nextRegistration}`;
    return new Promise<RegisteredSource>((resolve, reject) => {
      this.registering.set(requestId, {
        resolve: (value) => {
          this.sources.set(handle, source);
          resolve(value);
        },
        reject,
      });
      worker.postMessage({ kind: 'gg:registerSource', requestId, handle, source });
    });
  }

  private onWorkerMessage(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null || !('kind' in raw) || typeof raw.kind !== 'string' || !raw.kind.startsWith('gg:')) return false;
    const message = raw as WorkerReply;
    switch (message.kind) {
      case 'gg:ready':
        this.resolveReady({ duckdbVersion: message.duckdbVersion, capabilities: message.capabilities, extensionErrors: message.extensionErrors });
        break;
      case 'gg:fatal':
        this.restart(message.message);
        break;
      case 'gg:sourceRegistered': {
        const pending = this.registering.get(message.requestId);
        this.registering.delete(message.requestId);
        pending?.resolve({ handle: message.handle as FileHandle, fileName: message.fileName, sizeBytes: message.sizeBytes });
        break;
      }
      case 'gg:cacheSelfTest':
        this.selfTests.get(message.requestId)?.({ ok: message.ok, detail: message.detail });
        this.selfTests.delete(message.requestId);
        break;
      case 'gg:registerFailed': {
        const pending = this.registering.get(message.requestId);
        this.registering.delete(message.requestId);
        pending?.reject(new EngineRequestError(message.code, message.message));
        break;
      }
    }
    return true;
  }
}

/** Start the web demo's engine (a Web Worker running DuckDB-WASM) and return its client. */
export function createWorkerEngine(options: WorkerEngineOptions = {}): WorkerEngine {
  return new WorkerEngineClient(options);
}
