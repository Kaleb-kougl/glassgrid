import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import type { Table } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import { tableIdForFile, toFileHandle, type AggregateSpecInput } from '@glassgrid/core';
import { PortEngineClient, type EnginePort } from './client/port-client';
import type { DuckDriver } from './driver';
import { createNativeDriver } from './native/driver';
import { QueryService } from './query-service';
import { EngineSession } from './session';
import { medians, runWorkload, type WorkloadTimings } from './testing/m4-bench';
import { createNodeWasmDriver } from './wasm/node';

/*
 * M4 engine bench and driver parity (opt-in), in Node: the shared workload
 * (src/testing/m4-bench.ts) through PortEngineClient and an EngineSession
 * over a MessageChannel, on native DuckDB and on DuckDB-WASM (Node runtime),
 * plus a cell-by-cell comparison of what both drivers answer.
 *
 *   GLASSGRID_M4_BENCH_CSV=../../tools/datasets/out/synthetic-1m-seed42.csv \
 *   GLASSGRID_M4_BENCH_PARQUET=<same data as Parquet, optional> \
 *     pnpm --filter @glassgrid/engine exec vitest run --project native src/m4-bench.test.ts
 *
 * GLASSGRID_M4_RUNS (default 3) cold runs per driver and source;
 * GLASSGRID_BENCH_LABEL tags the JSON in e2e-results/.
 */
const CSV = process.env['GLASSGRID_M4_BENCH_CSV'];
const PARQUET = process.env['GLASSGRID_M4_BENCH_PARQUET'];
const RUNS = Number(process.env['GLASSGRID_M4_RUNS'] ?? 3);
const LABEL = process.env['GLASSGRID_BENCH_LABEL'] ?? '';

async function client(driver: DuckDriver, cacheDir: string) {
  const service = await QueryService.create(driver, { cacheDir });
  const { port1, port2 } = new MessageChannel();
  const session = new EngineSession(Promise.resolve(service), (message) => port1.postMessage(message));
  port1.on('message', (data: unknown) => session.handle(data));
  const engine = new PortEngineClient();
  engine.adoptPort(port2 as unknown as EnginePort);
  return {
    service,
    engine,
    register(path: string) {
      const file = toFileHandle(crypto.randomUUID());
      service.registerFile(file, path);
      return file;
    },
    close() {
      engine.dispose();
      session.dispose();
      port1.close();
      service.close();
    },
  };
}

function cells(table: Table): string {
  return JSON.stringify(table.toArray(), (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
}

describe.skipIf(!CSV)('M4 bench: native vs DuckDB-WASM (Node)', () => {
  it('times the workload and compares answers', { timeout: 60 * 60_000 }, async () => {
    const csv = resolve(CSV ?? '');
    const cacheDir = resolve('e2e-results', 'm4-bench-cache', 'parquet');
    const drivers: Record<string, () => Promise<DuckDriver>> = {
      native: () => Promise.resolve(createNativeDriver()),
      wasm: async () => {
        const roots = [dirname(csv), resolve('e2e-results'), ...(PARQUET ? [dirname(resolve(PARQUET))] : [])];
        const driver = await createNodeWasmDriver({ allowedRoots: roots, memoryLimitBytes: 3 * 1024 ** 3 });
        await driver.start();
        return driver;
      },
    };
    const sources: Array<[string, string]> = [['csv', csv], ...(PARQUET ? ([['parquet', resolve(PARQUET)]] as Array<[string, string]>) : [])];
    const results: Record<string, Record<string, { runs: WorkloadTimings[]; median: WorkloadTimings } | { skipped: string }>> = {};
    const answers: Record<string, Record<string, string>> = {};

    for (const [name, make] of Object.entries(drivers)) {
      results[name] = {};
      answers[name] = {};
      for (const [source, path] of sources) {
        const runs: WorkloadTimings[] = [];
        for (let run = 0; run < RUNS; run += 1) {
          const driver = await make();
          if (source === 'parquet' && !driver.capabilities.parquet) break;
          const c = await client(driver, join(cacheDir, `${name}-${run}`));
          try {
            runs.push(await runWorkload(c.engine, c.register(path)));
          } finally {
            c.close();
          }
        }
        results[name][source] = runs.length > 0 ? { runs, median: medians(runs) } : { skipped: 'no Parquet support in this driver' };
      }

      // Answers to compare across drivers (one warm table).
      const c = await client(await make(), join(cacheDir, `${name}-answers`));
      try {
        const file = c.register(csv);
        const table = tableIdForFile(file);
        const handle = await c.engine.open(file, { parquet: 'never' });
        answers[name]['columns'] = JSON.stringify(handle.table.columns);
        const profile = await c.engine.profile(table);
        answers[name]['profile'] = JSON.stringify(profile.columns.map(({ distinctCount: _d, ...rest }) => rest));
        answers[name]['distinct'] = JSON.stringify(profile.columns.map((column) => [column.name, column.distinctCount]));
        answers[name]['first page'] = cells((await c.engine.pageFetcher(table)(0, 200)).table);
        answers[name]['sorted page'] = cells((await c.engine.pageFetcher(table, { sort: [{ column: 'amount', direction: 'desc' }] })(0, 200)).table);
        const specs: Record<string, AggregateSpecInput> = {
          bar: { mark: 'bar', x: { column: 'region' } },
          'bar sum': { mark: 'bar', x: { column: 'status' }, y: { column: 'amount', aggregate: 'sum' } },
          heatmap: { mark: 'heatmap', x: { column: 'longitude', bin: 'auto' }, y: { column: 'latitude', bin: 'auto' } },
          histogram: { mark: 'histogram', x: { column: 'discount_pct', bin: 'auto' } },
          line: { mark: 'line', x: { column: 'event_time', timeUnit: 'day' }, pixelWidth: 600 },
        };
        for (const [label, spec] of Object.entries(specs)) answers[name][label] = cells((await c.engine.aggregate(table, spec)).table);
      } finally {
        c.close();
      }
    }

    const nativeAnswers = answers['native'] ?? {};
    const wasmAnswers = answers['wasm'] ?? {};
    const parity = Object.fromEntries(Object.keys(nativeAnswers).map((key) => [key, nativeAnswers[key] === wasmAnswers[key]]));
    const out = {
      label: LABEL,
      csv,
      parquet: PARQUET ?? null,
      runs: RUNS,
      duckdb: { native: (await createNativeDriver().start()), wasm: await (await drivers['wasm']?.())?.start() },
      machine: { platform: platform(), arch: arch(), cpus: cpus().length, cpu: cpus()[0]?.model ?? '', memoryGb: Math.round(totalmem() / 1024 ** 3) },
      results,
      parity,
      differences: Object.fromEntries(
        Object.keys(parity)
          .filter((key) => !parity[key])
          .map((key) => [key, { native: (nativeAnswers[key] ?? '').slice(0, 2000), wasm: (wasmAnswers[key] ?? '').slice(0, 2000) }]),
      ),
    };
    await mkdir(resolve('e2e-results'), { recursive: true });
    const target = resolve('e2e-results', `m4-engine-bench-node${LABEL ? `-${LABEL}` : ''}-${platform()}-${arch()}.json`);
    await writeFile(target, `${JSON.stringify(out, null, 2)}\n`);
    console.info(`m4 bench -> ${target}`);
    console.info(JSON.stringify({ medians: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([s, r]) => [s, 'median' in r ? r.median : r]))])), parity }, null, 1));
    expect(Object.keys(results)).toEqual(['native', 'wasm']);
  });
});
