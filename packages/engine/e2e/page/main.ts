import { LIVE_FLIGHTS_HANDLE, type FileHandle, type LiveState } from '@glassgrid/core';
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

  /**
   * Parquet through the signed extension served from this origin (the web
   * demo's /duckdb-extensions, apps/web/public): LOAD before the lock,
   * `read_parquet` over HTTP, and the CSV-to-Parquet cache in OPFS (COPY …
   * (FORMAT parquet) through a sync access handle), read back by a new worker.
   */
  parquet: async (path: string, rows: number) => {
    const options = { extensionRepository: `${location.origin}/duckdb-extensions` };
    const csv = fixtureFile(rows, 'to-parquet.csv');
    const first = await withEngine(options, async (engine, info) => {
      const source = await engine.registerUrl(path);
      const { table } = await engine.open(source.handle);
      const count = await engine.count(table.id);
      const page = await engine.pageFetcher(table.id, { sort: [{ column: 'amount', direction: 'desc' }] })(0, 3);
      const bar = await engine.aggregate(table.id, { mark: 'bar', x: { column: 'category' } }, { viewId: 'chart:bar' });
      const bars = [...(bar.table.getChild('y') ?? [])].map(Number);
      const opened = await engine.open((await engine.registerFile(csv)).handle, { parquet: 'never' });
      const converted = await engine.ensureParquetCache(opened.table.id);
      const afterConvert = await engine.count(opened.table.id);
      return {
        info,
        sample: { fileName: source.fileName, sizeBytes: source.sizeBytes, columns: table.columns, rowCount: count.rowCount, firstAmounts: [...(page.table.getChild('amount') ?? [])].map(Number), barTotal: bars.reduce((a, b) => a + b, 0) },
        cache: { sizeBytes: converted.sizeBytes, usingParquetCache: converted.table.usingParquetCache, rowCount: afterConvert.rowCount },
      };
    });
    // A new worker (as after a reload) opens the same file from the cached copy. One worker at a time:
    // an OPFS sync access handle locks its file (two tabs on one cached copy: see docs/m4-engine-portability.md).
    const reread = await withEngine(options, async (engine) => {
      const again = await engine.open((await engine.registerFile(csv)).handle);
      const counted = await engine.count(again.table.id);
      await engine.closeTable(again.table.id);
      await engine.clearCache('all');
      return { usingParquetCache: again.table.usingParquetCache, rowCount: counted.rowCount };
    });
    return { ...first, cache: { ...first.cache, reread } };
  },

  /**
   * Live flights in the worker (docs/live-flights-l2.md): replay the
   * 30-minute fixture over HTTP through the served Parquet extension into
   * flight_states, then poll this server's stand-in for /api/flights, and
   * pause it as a hidden page would.
   */
  liveFlights: () =>
    withEngine(
      {
        extensionRepository: `${location.origin}/duckdb-extensions`,
        live: { url: `${location.origin}/api/flights`, fixtures: { 'flights-bay-30min': `${location.origin}/samples/flights/flights-bay-30min.parquet` } },
      },
      async (engine) => {
        const live = engine.live;
        const waitFor = (predicate: (state: LiveState) => boolean) =>
          new Promise<LiveState>((resolve) => {
            const stop = live.onState((state) => {
              if (predicate(state)) {
                stop();
                resolve(state);
              }
            });
          });
        const started = performance.now();
        const ended = waitFor((state) => state.feed?.ended === true);
        await live.start({ kind: 'replay', fixture: 'flights-bay-30min', intervalMs: 1_000, speed: 120, retentionMs: null });
        const replay = await ended;
        const replayMs = performance.now() - started;

        const polled = waitFor((state) => state.feed?.kind === 'live' && state.feed.status === 'live');
        // The replay ended, so the feed is stopped: starting (not setSource, which only chooses) switches to live.
        const switched = await live.start({ kind: 'live' });
        const afterPoll = await polled;
        await live.setVisible(false);
        const hidden = await live.state();
        await live.setVisible(true);
        const shown = await live.state();
        const stopped = await live.stop();
        return { replay, replayMs, switchedRows: switched.rowCount, afterPoll, hidden, shown, stopped };
      },
    ),

  /**
   * L4: the day fixture loaded whole, then the 30-minute one, then the day again (twice round), each followed by
   * the queries a flights workspace makes (views, a count, a histogram, a cube, the map). Reports the feed's state
   * and DuckDB's memory and attached databases after each step, so a store that is not freed on a switch shows.
   */
  archiveSwitches: () =>
    withEngine(
      {
        extensionRepository: `${location.origin}/duckdb-extensions`,
        live: {
          fixtures: {
            'flights-bay-30min': `${location.origin}/samples/flights/flights-bay-30min.parquet`,
            'flights-bay-day': `${location.origin}/samples/flights/flights-bay-day.parquet`,
          },
        },
      },
      async (engine) => {
        const live = engine.live;
        const settled = (fixture: string) =>
          new Promise<LiveState>((resolve) => {
            const check = (state: LiveState) => {
              const source = state.source;
              if (source?.kind !== 'archive' || source.fixture !== fixture || state.feed === null) return false;
              return state.feed.status === 'live' || state.feed.status === 'backoff';
            };
            const stop = live.onState((state) => {
              if (check(state)) {
                stop();
                resolve(state);
              }
            });
            void live.state().then((state) => {
              if (check(state)) {
                stop();
                resolve(state);
              }
            });
          });
        const steps: { fixture: string; status: string; rows: number; error: string | null; ms: number; memoryMb: number | null; databases: number | null }[] = [];
        for (const fixture of ['flights-bay-day', 'flights-bay-30min', 'flights-bay-day', 'flights-bay-30min', 'flights-bay-day'] as const) {
          const started = performance.now();
          const done = settled(fixture);
          await live.start({ kind: 'archive', fixture });
          const state = await done;
          const ms = performance.now() - started;
          if (state.feed?.status === 'live') {
            const { table } = await engine.open(LIVE_FLIGHTS_HANDLE);
            await engine.profile(table.id);
            await engine.count(table.id, { filters: [{ kind: 'range', column: 'lat', min: 37.3, max: 38 }] });
            const spec = { mark: 'histogram' as const, x: { column: 'altBaroFt', bin: 1000 }, filters: [] };
            await engine.aggregate(table.id, spec);
            await engine.prepareCrossfilter(table.id, { dimension: { column: 'altBaroFt', bin: { kind: 'width', width: 1000 } }, targets: [{ kind: 'aggregate', spec: { mark: 'bar', x: { column: 'category' }, filters: [] } }, { kind: 'count', filters: [] }] });
            await engine.mapQuery(table.id, { spec: { kind: 'map' }, query: 'latest', dataClockMs: state.lastBatch?.dataClockMs ?? 0 });
            // The grid under the map's viewport filter: its first page, then (after the filter settled) a deep page.
            // Before the L4 review fix these built filtered row-number indexes (a copy of every matching row in the
            // store's database), and closing the live table while one built left ~650 MB with DuckDB-WASM, so the
            // next "Load full day" ran out of memory.
            const pages = engine.pageFetcher(table.id, { viewId: 'grid', filters: [{ kind: 'range', column: 'lon', min: -122.9, max: -121.6 }] });
            await pages(0, 1000);
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            await pages(20_000, 1000);
            // As the app does when its flights workspace is undone: a newer filter's index starts building, then
            // the live table is closed and the source switched while it builds.
            const next = engine.pageFetcher(table.id, { viewId: 'grid', filters: [{ kind: 'range', column: 'lon', min: -122.8, max: -121.7 }] });
            await next(0, 1000);
            await new Promise((resolve) => setTimeout(resolve, 1_600));
            void next(30_000, 1000).catch(() => undefined);
            await new Promise((resolve) => setTimeout(resolve, 100));
            await engine.closeTable(table.id);
          }
          const stats = await engine.cacheStats();
          steps.push({ fixture, status: state.feed?.status ?? 'none', rows: state.rowCount, error: state.feed?.error ?? null, ms, memoryMb: stats.live ? Math.round(stats.live.memoryBytes / 1024 ** 2) : null, databases: stats.live?.databases ?? null });
        }
        return steps;
      },
    ),

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
