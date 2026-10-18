import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectEngineWithParquet, expectNoProblems, shownRows, watchProblems } from './support';

/*
 * The web demo in Chromium, on the production build served with the
 * production headers (e2e/serve.ts reads vercel.json): the start screen,
 * the samples it offers, a picked CSV, a dropped CSV, a picked Parquet file
 * with nested types (the engine worker re-encodes those as text, which must
 * not need code generation under the header CSP), and the gallery. Any
 * console error, CSP violation, error toast or failed request fails.
 */

const FIXTURES = resolve(import.meta.dirname, 'fixtures');

async function openStart(page: Page) {
  const problems = await watchProblems(page);
  const response = await page.goto('/');
  return { problems, headers: response?.headers() ?? {} };
}

test('/ shows the start screen with the production headers and the three samples; DuckDB-WASM starts with Parquet', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const { problems, headers } = await openStart(page);

  // The header policy (what the engine worker runs under) and the <meta> copy.
  expect(headers['content-security-policy']).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['content-security-policy']).not.toMatch(/(^|\s)'unsafe-eval'/);
  expect(headers['x-content-type-options']).toBe('nosniff');
  const meta = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(meta).toContain("connect-src 'self'");
  expect(meta).not.toContain('frame-ancestors');

  const app = page.getByTestId('app');
  await expect(app).toHaveAttribute('data-platform', 'web');
  await expect(page.locator('html')).toHaveAttribute('data-gg-theme', 'dark');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByText('The file is read in this browser and never uploaded.')).toBeVisible();
  for (const id of ['taxi', 'retail', 'sensors']) await expect(page.getByTestId(`sample-${id}`)).toBeVisible();
  await expectEngineWithParquet(problems);

  // A sample from the start screen puts its shareable link in the address bar.
  await page.getByTestId('sample-sensors').click();
  await expect(page.getByTestId('file-name')).toHaveText('sensor-readings-2025-09.parquet');
  await expect(page.locator('section.gg-chart-card')).toHaveCount(4);
  await expect.poll(() => new URL(page.url()).searchParams.get('sample')).toBe('sensors');
  // Undo goes back to the start screen (the workspace load is one entry); the link goes with it.
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('sample')).toBeNull();
  await expectNoProblems(page, problems);
});

test('/ opens a picked CSV through <input type=file>: real rows, a chart, cross-filter, undo', async ({ page }) => {
  const { problems } = await openStart(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('open-csv-empty').click();
  const csv = ['city,trips,fare', ...Array.from({ length: 300 }, (_, i) => `${['Oslo', 'Lima', 'Pune', 'Kobe'][i % 4]},${i % 7},${(i * 1.25).toFixed(2)}`)].join('\n');
  await (await chooser).setFiles({ name: 'mine.csv', mimeType: 'text/csv', buffer: Buffer.from(`${csv}\n`) });
  await expect(page.getByTestId('file-name')).toHaveText('mine.csv');
  await expect.poll(() => shownRows(page)).toBe(300);
  await expect(page.getByTestId('column-city')).toContainText('4'); // distinct values, from the profile

  await page.getByTestId('column-city').focus();
  await page.keyboard.press('Enter');
  const bars = page.getByRole('listbox', { name: /Rows by city/ });
  await expect(bars).toBeVisible();
  await expect(bars.getByRole('option')).toHaveCount(4);
  await bars.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('row-count')).toContainText('75 of 300 rows');
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('row-count')).toHaveText('300 rows');
  await expectNoProblems(page, problems);
});

test('/ opens a dropped CSV', async ({ page }) => {
  const { problems } = await openStart(page);
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await page.getByTestId('app').evaluate((target) => {
    const data = new DataTransfer();
    data.items.add(new File(['id,name\n1,ada\n2,grace\n3,edsger\n'], 'dropped.csv', { type: 'text/csv' }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await expect(page.getByTestId('file-name')).toHaveText('dropped.csv');
  await expect(page.getByTestId('row-count')).toHaveText('3 rows');
  await expect(page.getByRole('gridcell', { name: 'grace' })).toBeAttached();
  await expectNoProblems(page, problems);
});

test('/ opens a picked Parquet file with list, struct and blob columns (rendered as text in the worker, no codegen under the CSP)', async ({ page }) => {
  const { problems } = await openStart(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('open-csv-empty').click();
  await (await chooser).setFiles({ name: 'nested-types.parquet', mimeType: 'application/vnd.apache.parquet', buffer: readFileSync(resolve(FIXTURES, 'nested-types.parquet')) });
  await expect(page.getByTestId('file-name')).toHaveText('nested-types.parquet');
  await expect(page.getByTestId('row-count')).toHaveText('500 rows');
  await expect(page.getByRole('gridcell', { name: '[tag1, x1]' }).first()).toBeAttached();
  await expect(page.getByRole('gridcell', { name: "{'n': 1, 'label': 'item 1'}" })).toBeAttached();
  await expect(page.getByRole('gridcell', { name: 'ab1', exact: true })).toBeAttached();
  await expectNoProblems(page, problems);
});

test('/gallery (and ?gallery) renders the component gallery', async ({ page }) => {
  // The gallery shows error toasts on purpose (component states); console, CSP and HTTP problems still count.
  const problems = await watchProblems(page, { alerts: false });
  await page.goto('/gallery');
  await expect(page.getByRole('heading', { level: 1, name: 'Glassgrid component gallery' })).toBeVisible();
  await expect(page.getByTestId('app')).toHaveCount(0);
  await page.goto('/?gallery');
  await expect(page.getByRole('heading', { level: 1, name: 'Glassgrid component gallery' })).toBeVisible();
  await expectNoProblems(page, problems);
});
