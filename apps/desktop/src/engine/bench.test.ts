import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TableId } from '@glassgrid/core';
import type { QueryService, RowsOptions } from './query-service';
import { createHarness, writeFixtureCsv } from './test-support';

/*
 * Engine timings without Electron. Opt-in:
 *
 *   GLASSGRID_BENCH_ROWS=10000000 pnpm --filter @glassgrid/desktop exec vitest run src/engine/bench.test.ts
 *
 * Writes e2e-results/engine-bench-<rows>-<platform>-<arch>.json. Set
 * GLASSGRID_BENCH_LABEL to tag the file (e.g. `before`). See
 * docs/m2-engine-notes.md for what each timing means.
 */
const ROWS = Number(process.env['GLASSGRID_BENCH_ROWS'] ?? 0);
const LABEL = process.env['GLASSGRID_BENCH_LABEL'] ?? '';

/** Deterministic PRNG (mulberry32) so every run requests the same pages. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (ms: number) => Math.round(ms * 10) / 10;

interface FlingResult {
  /** Requests sent, one every `intervalMs`. */
  requests: number;
  /** Superseded requests (all but the last `keep`) that were aborted. */
  aborted: number;
  /** Aborted requests that still resolved (finished before the abort landed). */
  completedBeforeAbort: number;
  /** abort() -> promise rejected, per superseded request. */
  interruptMedianMs: number;
  interruptMaxMs: number;
  /** Last request sent -> every one of the last `keep` pages resolved. */
  lastPagesMs: number;
  /** First request sent -> last page resolved. */
  totalMs: number;
}

/**
 * The grid's fling: `count` page requests over one second at random offsets;
 * the grid keeps only the `keep` most recent ones and aborts the rest as new
 * ones arrive.
 */
async function fling(
  service: QueryService,
  table: TableId,
  rows: number,
  query: Omit<RowsOptions, 'offset' | 'limit'>,
  seed: number,
  count = 30,
  keep = 3,
  intervalMs = 1000 / 30,
): Promise<FlingResult> {
  const random = prng(seed);
  const pages = Math.max(1, Math.floor(rows / 1000));
  const started = performance.now();
  const flights: Array<{
    controller: AbortController;
    promise: Promise<'ok' | 'aborted'>;
    abortedAt?: number;
    settledAt?: number;
    outcome?: 'ok' | 'aborted';
  }> = [];
  let lastSentAt = 0;
  for (let i = 0; i < count; i += 1) {
    const controller = new AbortController();
    const offset = Math.floor(random() * pages) * 1000;
    const flight: (typeof flights)[number] = {
      controller,
      promise: service
        .rows(table, { ...query, offset, limit: 1000 }, { signal: controller.signal, viewId: 'bench-grid' })
        .then(
          () => 'ok' as const,
          (error: unknown) => {
            if (!controller.signal.aborted) throw error;
            return 'aborted' as const;
          },
        ),
    };
    void flight.promise.then((outcome) => {
      flight.outcome = outcome;
      flight.settledAt = performance.now();
    });
    flights.push(flight);
    lastSentAt = performance.now();
    const stale = flights[i - keep];
    if (stale) {
      stale.abortedAt = performance.now();
      stale.controller.abort();
    }
    if (i < count - 1) await sleep(intervalMs);
  }
  await Promise.all(flights.map((flight) => flight.promise));
  await sleep(0);
  const superseded = flights.slice(0, count - keep);
  const interrupts = superseded
    .filter((flight) => flight.outcome === 'aborted' && flight.abortedAt !== undefined && flight.settledAt !== undefined)
    .map((flight) => (flight.settledAt ?? 0) - (flight.abortedAt ?? 0))
    .sort((a, b) => a - b);
  const last = flights.slice(-keep);
  expect(last.every((flight) => flight.outcome === 'ok')).toBe(true);
  const lastDone = Math.max(...last.map((flight) => flight.settledAt ?? 0));
  return {
    requests: count,
    aborted: superseded.length,
    completedBeforeAbort: superseded.filter((flight) => flight.outcome === 'ok').length,
    interruptMedianMs: round(interrupts[Math.floor(interrupts.length / 2)] ?? 0),
    interruptMaxMs: round(interrupts.at(-1) ?? 0),
    lastPagesMs: round(lastDone - lastSentAt),
    totalMs: round(lastDone - started),
  };
}

describe.skipIf(!(ROWS > 0))('engine benchmark', () => {
  it(`times the data path over ${ROWS} rows`, { timeout: 60 * 60_000 }, async () => {
    const h = await createHarness();
    const timings: Record<string, number> = {};
    const flings: Record<string, FlingResult> = {};
    const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      const result = await fn();
      timings[label] = round(performance.now() - started);
      return result;
    };
    try {
      const path = join(h.dir, 'bench.csv');
      await time('generateCsv', () => writeFixtureCsv(path, ROWS));
      const { file, table } = h.register(path);
      const sort = [{ column: 'amount', direction: 'desc' as const }];
      const otherSort = [{ column: 'created_on', direction: 'asc' as const }];
      const where = { sql: '"category" IN ($1, $2)', params: ['alpha', 'echo'] };
      const deep = Math.max(0, ROWS - 100_000);
      const mid = Math.floor(ROWS / 2 / 1000) * 1000;

      // --- CSV, no Parquet cache: the worst case before any background work.
      let service = h.service;
      await time('csv.open', () => service.open(file, { parquet: 'never' }));
      await time('csv.firstPage', () => service.rows(table, { offset: 0, limit: 1000 }));
      await time('csv.deepPage', () => service.rows(table, { offset: deep, limit: 1000 }));
      await time('csv.profile', () => service.profile(table));
      await time('csv.count', () => service.clearCache('results').then(() => service.count(table)));
      await time('csv.sortedFirstPage', () => service.rows(table, { offset: 0, limit: 1000, sort }, { viewId: 'grid' }));
      await time('csv.sortedSecondPage', () => service.rows(table, { offset: 1000, limit: 1000, sort }, { viewId: 'grid' }));
      await time('csv.sortedDeepPage', () => service.rows(table, { offset: deep, limit: 1000, sort }, { viewId: 'grid' }));
      await time('csv.sortedMidPage', () => service.rows(table, { offset: mid, limit: 1000, sort }, { viewId: 'grid' }));
      await time('csv.filteredSortedFirstPage', () =>
        service.rows(table, { offset: 0, limit: 1000, sort, where }, { viewId: 'grid' }),
      );
      await time('csv.filteredSortedDeepPage', () =>
        service.rows(table, { offset: Math.floor((ROWS * 0.4) / 1000) * 1000 - 50_000, limit: 1000, sort, where }, { viewId: 'grid' }),
      );
      await time('csv.cachedPage', () => service.rows(table, { offset: 0, limit: 1000, sort }, { viewId: 'grid' }));
      await service.clearCache('results');
      flings['csv.unsorted'] = await fling(service, table, ROWS, {}, 1);
      flings['csv.sorted'] = await fling(service, table, ROWS, { sort }, 2);
      flings['csv.sortedColdIndex'] = await fling(service, table, ROWS, { sort: otherSort }, 3);

      // --- CSV with the default `auto` Parquet mode, cache empty: deep and sorted pages right after open.
      service = await h.restart();
      service.registerFile(file, path);
      await service.clearCache('all');
      await time('auto.open', () => service.open(file));
      await time('auto.deepPage', () => service.rows(table, { offset: deep, limit: 1000 }));
      await time('auto.deepPage2', () => service.rows(table, { offset: mid, limit: 1000 }));
      await time('auto.sortedFirstPage', () => service.rows(table, { offset: 0, limit: 1000, sort }, { viewId: 'grid' }));
      await time('auto.sortedSecondPage', () => service.rows(table, { offset: 1000, limit: 1000, sort }, { viewId: 'grid' }));
      await time('auto.sortedDeepPage', () => service.rows(table, { offset: deep, limit: 1000, sort }, { viewId: 'grid' }));
      await time('auto.sortedMidPage', () => service.rows(table, { offset: mid, limit: 1000, sort }, { viewId: 'grid' }));

      // --- Same, but the grid flings through unsorted pages the moment the file opens.
      service = await h.restart();
      service.registerFile(file, path);
      await service.clearCache('all');
      await service.open(file);
      flings['auto.unsortedRightAfterOpen'] = await fling(service, table, ROWS, {}, 4);
      await time('auto.deepPageAfterFling', () => service.rows(table, { offset: deep - 7000, limit: 1000 }));

      // --- Parquet cache.
      service = await h.restart();
      service.registerFile(file, path);
      await service.clearCache('all');
      service.registerFile(file, path);
      await service.open(file, { parquet: 'never' });
      const converted = await time('parquet.convert', () => service.ensureParquetCache(table));
      expect(converted.table.usingParquetCache).toBe(true);

      service = await h.restart();
      service.registerFile(file, path);
      const reopened = await time('parquet.open', () => service.open(file));
      expect(reopened.usingParquetCache).toBe(true);
      await time('parquet.firstPage', () => service.rows(table, { offset: 0, limit: 1000 }));
      await time('parquet.deepPage', () => service.rows(table, { offset: deep, limit: 1000 }));
      await time('parquet.profile', () => service.profile(table));
      await time('parquet.sortedFirstPage', () => service.rows(table, { offset: 0, limit: 1000, sort }, { viewId: 'grid' }));
      await time('parquet.sortedSecondPage', () =>
        service.rows(table, { offset: 1000, limit: 1000, sort }, { viewId: 'grid' }),
      );
      await time('parquet.sortedDeepPage', () => service.rows(table, { offset: deep, limit: 1000, sort }, { viewId: 'grid' }));
      await time('parquet.sortedMidPage', () => service.rows(table, { offset: mid, limit: 1000, sort }, { viewId: 'grid' }));
      await time('parquet.filteredSortedFirstPage', () =>
        service.rows(table, { offset: 0, limit: 1000, sort, where }, { viewId: 'grid' }),
      );
      await service.clearCache('results');
      flings['parquet.unsorted'] = await fling(service, table, ROWS, {}, 1);
      flings['parquet.sorted'] = await fling(service, table, ROWS, { sort }, 2);
      flings['parquet.sortedColdIndex'] = await fling(service, table, ROWS, { sort: otherSort }, 3);

      const report = {
        benchmark: 'engine',
        label: LABEL,
        recordedAt: new Date().toISOString(),
        rows: ROWS,
        csvBytes: converted.table.fingerprint.sizeBytes,
        parquetBytes: converted.sizeBytes,
        machine: {
          platform: platform(),
          arch: arch(),
          cpuModel: cpus()[0]?.model ?? 'unknown',
          cpuCount: cpus().length,
          totalMemBytes: totalmem(),
          uvThreadpoolSize: process.env['UV_THREADPOOL_SIZE'] ?? '4 (default)',
        },
        timingsMs: timings,
        flings,
      };
      const outDir = resolve(import.meta.dirname, '../../e2e-results');
      await mkdir(outDir, { recursive: true });
      const suffix = LABEL ? `-${LABEL}` : '';
      await writeFile(
        join(outDir, `engine-bench-${ROWS}-${platform()}-${arch()}${suffix}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      console.info(JSON.stringify(report, null, 2));
    } finally {
      await h.dispose();
    }
  });
});
