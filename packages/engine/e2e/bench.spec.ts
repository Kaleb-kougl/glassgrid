import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, totalmem } from 'node:os';
import { basename, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/*
 * The M4 browser bench (opt-in): the shared workload in DuckDB-WASM's
 * engine worker, over the synthetic dataset as a picked File (and its
 * Parquet copy as a sample URL when DuckDB-WASM can read Parquet).
 *
 *   GLASSGRID_M4_BENCH_CSV=../../tools/datasets/out/synthetic-1m-seed42.csv \
 *   GLASSGRID_M4_BENCH_PARQUET=../../tools/datasets/out/synthetic-1m-seed42.parquet \
 *     pnpm --filter @glassgrid/engine bench:web
 *
 * GLASSGRID_M4_RUNS (default 3); writes e2e-results/m4-engine-bench-web-<platform>-<arch>.json.
 */
const CSV = process.env['GLASSGRID_M4_BENCH_CSV'] ?? '';
const PARQUET = process.env['GLASSGRID_M4_BENCH_PARQUET'];
const RUNS = Number(process.env['GLASSGRID_M4_RUNS'] ?? 3);
const LABEL = process.env['GLASSGRID_BENCH_LABEL'] ?? '';

test('M4 browser bench', async ({ page }) => {
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[page] ${message.text()}`);
  });
  await page.goto('/index.html');
  await expect(page.locator('#status')).toHaveText('ready');
  const result = await page.evaluate(
    ({ csv, parquet, runs }) => globalThis.gg.bench(csv, parquet, runs),
    { csv: `/${basename(CSV)}`, parquet: PARQUET ? `/${basename(PARQUET)}` : null, runs: RUNS },
  );
  const out = {
    label: LABEL,
    files: { csv: basename(CSV), parquet: PARQUET ? basename(PARQUET) : null },
    runs: RUNS,
    machine: { platform: platform(), arch: arch(), cpus: cpus().length, cpu: cpus()[0]?.model ?? '', memoryGb: Math.round(totalmem() / 1024 ** 3) },
    ...result,
  };
  await mkdir(resolve('e2e-results'), { recursive: true });
  const target = resolve('e2e-results', `m4-engine-bench-web${LABEL ? `-${LABEL}` : ''}-${platform()}-${arch()}.json`);
  await writeFile(target, `${JSON.stringify(out, null, 2)}\n`);
  console.info(`m4 web bench -> ${target}`);
  console.info(JSON.stringify({ startMs: result.startMs, csv: result.csv.median, parquet: 'median' in result.parquet ? result.parquet.median : result.parquet }, null, 1));
  expect(result.csv.runs).toHaveLength(RUNS);
});
