import type { FileHandle } from '@glassgrid/core';
import { fixtureCsv } from '../../src/testing/fixture';
import { runScenario, type ScenarioStep } from '../../src/testing/scenario';
import { createWorkerEngine, isAbandoned, type WorkerEngine, type WorkerEngineInfo, type WorkerEngineOptions } from '../../src/web';
import { runBench, type BenchResult } from './bench';

/*
 * Test and bench page for the engine worker. Playwright (e2e/*.spec.ts)
 * calls these functions with page.evaluate; each starts its own worker so
 * the cases do not share state.
 */

interface Outcome<T> {
  ok: boolean;
  value?: T;
  code?: string;
  message?: string;
}

async function outcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    return { ok: false, ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) };
  }
}

function fixtureFile(rows: number, name = 'fixture.csv'): File {
  return new File([fixtureCsv(rows)], name, { type: 'text/csv', lastModified: Date.UTC(2026, 9, 1) });
}

async function withEngine<T>(options: WorkerEngineOptions, body: (engine: WorkerEngine, info: WorkerEngineInfo) => Promise<T>): Promise<T> {
  const engine = createWorkerEngine(options);
  try {
    return await body(engine, await engine.ready);
  } finally {
    engine.terminate();
  }
}

const api = {
  /** Start a worker and report what DuckDB-WASM runs as. */
  info: () => withEngine({}, (_engine, info) => Promise.resolve({ ...info, crossOriginIsolated: globalThis.crossOriginIsolated })),

  /** The shared engine scenario on a File (a Blob built here) in a real Web Worker. */
  scenario: (rows: number) =>
    withEngine({}, async (engine, info) => {
      const source = await engine.registerFile(fixtureFile(rows));
      const steps: ScenarioStep[] = await runScenario(engine, source.handle, rows);
      return { info, source: { fileName: source.fileName, sizeBytes: source.sizeBytes }, steps };
    }),

  /** A sample dataset over HTTP (range requests), and an origin that is not allowed. */
  urlSource: (path: string) =>
    withEngine({}, async (engine) => {
      const source = await engine.registerUrl(path);
      const { table } = await engine.open(source.handle);
      const count = await engine.count(table.id);
      const page = await engine.pageFetcher(table.id)(0, 5);
      const refused = await outcome(engine.registerUrl('https://example.com/data.csv'));
      return {
        fileName: source.fileName,
        sizeBytes: source.sizeBytes,
        fingerprint: table.fingerprint,
        rowCount: count.rowCount,
        firstIds: [...(page.table.getChild('id') ?? [])].map(Number),
        refused,
      };
    }),

  /** Files over the size cap are refused before DuckDB sees them. */
  tooLarge: () =>
    withEngine({ maxSourceBytes: 1000 }, async (engine) => outcome(engine.registerFile(fixtureFile(1000)))),

  /** A query past the memory limit fails with out_of_memory and the friendly message; the engine keeps working. */
  outOfMemory: (rows: number) =>
    withEngine({ memoryLimitBytes: 128 * 1024 * 1024 }, async (engine) => {
      const source = await engine.registerFile(fixtureFile(rows, 'big.csv'));
      const { table } = await engine.open(source.handle, { parquet: 'never' });
      const failed = await outcome(
        engine.pageFetcher(table.id, { viewId: 'grid', sort: [{ column: 'category', direction: 'asc' }, { column: 'amount', direction: 'desc' }] })(rows - 1000, 1000),
      );
      const after = await outcome(engine.count(table.id));
      return { failed, after: after.ok ? after.value?.rowCount : after };
    }),

  /** An abort reaches DuckDB-WASM between its steps (cooperative interrupt). */
  abort: (rows: number) =>
    withEngine({}, async (engine) => {
      const source = await engine.registerFile(fixtureFile(rows));
      const { table } = await engine.open(source.handle, { parquet: 'never' });
      const controller = new AbortController();
      const started = performance.now();
      const pending = engine.profile(table.id, { signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      const result = await pending.then(
        () => 'resolved',
        (error: unknown) => (isAbandoned(error) ? 'abandoned' : `failed: ${String(error)}`),
      );
      const rejectedAfterMs = performance.now() - started;
      const count = await engine.count(table.id);
      return { result, rejectedAfterMs, rowCount: count.rowCount };
    }),

  /** Re-registering the same File gives the same fingerprint (name, size, lastModified, edge hash). */
  fingerprint: () =>
    withEngine({}, async (engine) => {
      const file = fixtureFile(5000);
      const a = await engine.open((await engine.registerFile(file)).handle);
      const b = await engine.open((await engine.registerFile(file)).handle);
      const changed = new File([fixtureCsv(5001)], file.name, { lastModified: file.lastModified });
      const c = await engine.open((await engine.registerFile(changed)).handle);
      return { same: a.table.fingerprint.key === b.table.fingerprint.key, differs: a.table.fingerprint.key !== c.table.fingerprint.key };
    }),

  /** The OPFS cache round trip in one worker (`write`), and in a fresh one (`read`, then `clean`). */
  cache: async () => {
    const written = await withEngine({}, (engine) => engine.cacheSelfTest('write'));
    const reread = await withEngine({}, async (engine) => ({ read: await engine.cacheSelfTest('read'), clean: await engine.cacheSelfTest('clean') }));
    return { written, ...reread };
  },

  /** The M4 browser bench (see bench.ts). */
  bench: (csvPath: string, parquetPath: string | null, runs: number): Promise<BenchResult> => runBench(csvPath, parquetPath, runs),
};

declare global {
  var gg: typeof api;
}
globalThis.gg = api;
const status = document.getElementById('status');
if (status) status.textContent = 'ready';
export type { FileHandle };
