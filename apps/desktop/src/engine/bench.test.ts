import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHarness, writeFixtureCsv } from './test-support';

/*
 * Engine timings without Electron, for the M1 baseline. Opt-in:
 *
 *   GLASSGRID_BENCH_ROWS=10000000 pnpm --filter @glassgrid/desktop exec vitest run src/engine/bench.test.ts
 *
 * Writes e2e-results/engine-bench-<rows>-<platform>-<arch>.json.
 */
const ROWS = Number(process.env['GLASSGRID_BENCH_ROWS'] ?? 0);

describe.skipIf(!(ROWS > 0))('engine benchmark', () => {
  it(`times the data path over ${ROWS} rows`, { timeout: 30 * 60_000 }, async () => {
    const h = await createHarness();
    const timings: Record<string, number> = {};
    const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      const result = await fn();
      timings[label] = Math.round((performance.now() - started) * 10) / 10;
      return result;
    };
    try {
      const path = join(h.dir, 'bench.csv');
      await time('generateCsv', () => writeFixtureCsv(path, ROWS));
      const { file, table } = h.register(path);
      const sort = [{ column: 'amount', direction: 'desc' as const }];
      const deep = Math.max(0, ROWS - 100_000);

      await time('csv.open', () => h.service.open(file, { parquet: 'never' }));
      await time('csv.firstPage', () => h.service.rows(table, { offset: 0, limit: 1000 }));
      await time('csv.deepPage', () => h.service.rows(table, { offset: deep, limit: 1000 }));
      await time('csv.profile', () => h.service.profile(table));
      await time('csv.count', () => h.service.clearCache('results').then(() => h.service.count(table)));
      await time('csv.sortedFirstPage', () => h.service.rows(table, { offset: 0, limit: 1000, sort }));
      await time('csv.sortedDeepPage', () => h.service.rows(table, { offset: deep, limit: 1000, sort }));
      await time('csv.cachedPage', () => h.service.rows(table, { offset: 0, limit: 1000, sort }));

      const converted = await time('parquet.convert', () => h.service.ensureParquetCache(table));
      expect(converted.table.usingParquetCache).toBe(true);

      const service = await h.restart();
      service.registerFile(file, path);
      const reopened = await time('parquet.open', () => service.open(file));
      expect(reopened.usingParquetCache).toBe(true);
      await time('parquet.firstPage', () => service.rows(table, { offset: 0, limit: 1000 }));
      await time('parquet.deepPage', () => service.rows(table, { offset: deep, limit: 1000 }));
      await time('parquet.profile', () => service.profile(table));
      await time('parquet.sortedFirstPage', () => service.rows(table, { offset: 0, limit: 1000, sort }));
      await time('parquet.sortedDeepPage', () => service.rows(table, { offset: deep, limit: 1000, sort }));

      const report = {
        benchmark: 'engine',
        recordedAt: new Date().toISOString(),
        rows: ROWS,
        csvBytes: converted.table.fingerprint.sizeBytes,
        parquetBytes: converted.sizeBytes,
        machine: { platform: platform(), arch: arch(), cpuModel: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length },
        timingsMs: timings,
      };
      const outDir = resolve(import.meta.dirname, '../../e2e-results');
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, `engine-bench-${ROWS}-${platform()}-${arch()}.json`), `${JSON.stringify(report, null, 2)}\n`);
      console.info(report);
    } finally {
      await h.dispose();
    }
  });
});
