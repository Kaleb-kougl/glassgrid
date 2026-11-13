import { expect, test, type Page } from '@playwright/test';

/*
 * The engine on DuckDB-WASM in a real Web Worker (Chromium): the shared
 * scenario (src/testing/scenario.ts, also run in Node against native DuckDB
 * and DuckDB-WASM), data sources, the size cap, out-of-memory, aborts and
 * fingerprints. Each case starts its own worker.
 */

async function ready(page: Page): Promise<void> {
  await page.goto('/index.html');
  await expect(page.locator('#status')).toHaveText('ready');
}

test.beforeEach(async ({ page }) => {
  page.on('response', (response) => {
    if (response.status() >= 400) console.error(`[http] ${response.status()} ${response.url()}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[page] ${message.text()}`);
  });
  await ready(page);
});

test('starts DuckDB-WASM in a worker: version, single-threaded EH build, capabilities', async ({ page }) => {
  const info = await page.evaluate(() => globalThis.gg.info());
  console.info(JSON.stringify(info));
  expect(info.duckdbVersion).toMatch(/^v1\.\d+\.\d+/);
  // GLASSGRID_COI=1 serves the page with COOP/COEP (e2e/serve.ts): the page is then cross-origin isolated,
  // but the engine still runs DuckDB-WASM's single-threaded build (see docs/m4-engine-portability.md).
  const isolated = process.env['GLASSGRID_COI'] === '1';
  expect(info.capabilities).toMatchObject({ interrupt: 'cooperative', progress: false, cache: 'opfs', crossOriginIsolated: isolated });
  expect(info.crossOriginIsolated).toBe(isolated);
});

test('runs the shared engine scenario on a File, like native DuckDB does', async ({ page }) => {
  const result = await page.evaluate((rows) => globalThis.gg.scenario(rows), 20_000);
  console.info(result.steps.map((step) => `${step.name} ${step.ms} ms`).join(', '));
  expect(result.source).toMatchObject({ fileName: 'fixture.csv' });
  expect(result.steps.map((step) => step.name)).toEqual([
    'open',
    'first page',
    'profile',
    'sorted first page',
    'sorted deep page',
    'filtered page and count',
    'aggregate per mark',
    'cross-filter: cube answers equal plain answers',
    'setColumnTypes',
    'abort',
    'closeTable',
  ]);
});

test('reads a sample dataset over HTTP and refuses other origins', async ({ page }) => {
  const result = await page.evaluate(() => globalThis.gg.urlSource('/fixture-2000.csv'));
  expect(result).toMatchObject({ fileName: 'fixture-2000.csv', rowCount: 2000, firstIds: [1, 2, 3, 4, 5] });
  expect(result.fingerprint.sizeBytes).toBe(result.sizeBytes);
  expect(result.refused).toMatchObject({ ok: false, code: 'not_allowed' });
});

test('refuses files over the size cap with a message pointing to the desktop app', async ({ page }) => {
  const result = await page.evaluate(() => globalThis.gg.tooLarge());
  expect(result).toMatchObject({ ok: false, code: 'too_large', message: expect.stringContaining('desktop app') });
});

test('reports running out of memory as out_of_memory and keeps working', async ({ page }) => {
  const result = await page.evaluate((rows) => globalThis.gg.outOfMemory(rows), 1_500_000);
  console.info(JSON.stringify(result));
  expect(result.failed).toMatchObject({ ok: false, code: 'out_of_memory', message: expect.stringMatching(/^This file is too large for the web demo/) });
  expect(result.after).toBe(1_500_000);
});

test('aborts a running query between DuckDB steps', async ({ page }) => {
  const result = await page.evaluate((rows) => globalThis.gg.abort(rows), 400_000);
  console.info(JSON.stringify(result));
  expect(result).toMatchObject({ result: 'abandoned', rowCount: 400_000 });
});

test('fingerprints browser files by name, size, lastModified and edge bytes', async ({ page }) => {
  expect(await page.evaluate(() => globalThis.gg.fingerprint())).toEqual({ same: true, differs: true });
});

test('keeps cache files in OPFS: DuckDB writes a temp file, it is renamed, and a new worker reads it', async ({ page }) => {
  const result = await page.evaluate(() => globalThis.gg.cache());
  console.info(JSON.stringify(result));
  expect(result.written).toMatchObject({ ok: true, detail: { listed: ['rows.csv'], rows: [[10000, 49995000, 'row 9999']] } });
  expect(result.read).toMatchObject({ ok: true, detail: { listed: ['rows.csv'], rows: [[10000, 49995000, 'row 9999']] } });
  expect(result.clean).toMatchObject({ ok: true });
  expect((result.clean.detail['listed'] as string[]).includes('selftest')).toBe(false);
});

test('loads the signed Parquet extension from this origin: read_parquet over HTTP, and the OPFS Parquet cache', async ({ page }) => {
  const result = await page.evaluate(({ path, rows }) => globalThis.gg.parquet(path, rows), { path: '/fixture-2000.parquet', rows: 20_000 });
  console.info(JSON.stringify(result));
  expect(result.info.capabilities.parquet).toBe(true);
  expect(result.info.extensionErrors).toEqual([]);
  expect(result.sample).toMatchObject({ fileName: 'fixture-2000.parquet', rowCount: 2000, barTotal: 2000 });
  expect(result.sample.columns.map((column: { name: string }) => column.name)).toEqual(['id', 'category', 'amount', 'created_on']);
  expect(result.sample.firstAmounts).toHaveLength(3);
  expect(result.sample.firstAmounts[0]).toBeGreaterThanOrEqual(result.sample.firstAmounts[1] ?? Infinity);
  expect(result.cache).toMatchObject({ usingParquetCache: true, rowCount: 20_000, reread: { usingParquetCache: true, rowCount: 20_000 } });
  expect(result.cache.sizeBytes).toBeGreaterThan(0);
});

test('live flights: a fixture replayed over HTTP into flight_states, then the live endpoint polled and paused', async ({ page }) => {
  const result = await page.evaluate(() => globalThis.gg.liveFlights());
  console.info(JSON.stringify({ replayMs: Math.round(result.replayMs), replay: result.replay.lastBatch, afterPoll: result.afterPoll.feed }));
  // The whole fixture, nothing dropped or doubled (the exact cell-by-cell check is the Vitest replay gate).
  expect(result.replay).toMatchObject({ rowCount: 71_595, ingestError: null, feed: { kind: 'replay', status: 'stopped', ended: true, failures: 0 } });
  // Switching to live empties the table; one poll brings the endpoint's two aircraft.
  expect(result.switchedRows).toBe(0);
  expect(result.afterPoll).toMatchObject({ rowCount: 2, feed: { kind: 'live', status: 'live', failures: 0, license: 'ODbL-1.0' }, lastBatch: { received: 2, inserted: 2 } });
  expect(result.hidden.feed).toMatchObject({ paused: true, nextAttemptAt: null });
  expect(result.shown.feed).toMatchObject({ paused: false });
  expect(result.stopped.feed).toMatchObject({ status: 'stopped' });
});

test('live flights (L4): the day loaded whole, then the half hour, then the day again: each store is freed on the switch', async ({ page }) => {
  test.setTimeout(240_000);
  const steps = await page.evaluate(() => globalThis.gg.archiveSwitches());
  console.info(JSON.stringify(steps));
  // Every load succeeds, the second and third day too (they ran out of memory when a store's database stayed attached).
  expect(steps.map((step) => [step.fixture, step.status, step.rows, step.error])).toEqual([
    ['flights-bay-day', 'live', 1_456_777, null],
    ['flights-bay-30min', 'live', 71_595, null],
    ['flights-bay-day', 'live', 1_456_777, null],
    ['flights-bay-30min', 'live', 71_595, null],
    ['flights-bay-day', 'live', 1_456_777, null],
  ]);
  // One store attached at a time, and a day's memory is freed with it: the half hour's store alone is small (~20
  // MB; it was ~680 MB when a filtered grid index built as the live table closed), and the days do not pile up.
  const days = steps.filter((step) => step.fixture === 'flights-bay-day');
  const halves = steps.filter((step) => step.fixture === 'flights-bay-30min');
  expect(new Set(steps.map((step) => step.databases)).size).toBe(1);
  for (const half of halves) expect(half.memoryMb ?? Infinity).toBeLessThan(100);
  for (const day of days) expect(day.memoryMb ?? Infinity).toBeLessThan(400);
});
