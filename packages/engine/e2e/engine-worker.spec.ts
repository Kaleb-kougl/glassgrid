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
