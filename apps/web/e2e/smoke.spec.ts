import { expect, test, type Page } from '@playwright/test';

/*
 * Smoke tests of the built web app in Chromium: the shared app on the
 * temporary stub engine at `/`, the component gallery at `/gallery`. Any
 * console error (CSP violations included) or uncaught exception fails.
 */

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('/ renders the app on the stub engine: sample → grid → chart → undo', async ({ page }) => {
  const errors = collectErrors(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');

  // The production CSP is in force (with wasm-unsafe-eval for DuckDB-WASM).
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");

  const app = page.getByTestId('app');
  await expect(app).toHaveAttribute('data-platform', 'web');
  await expect(page.locator('html')).toHaveAttribute('data-gg-theme', 'dark');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByText('The file is read in this browser and never uploaded.')).toBeVisible();
  await expect(page.getByTestId('stub-badge')).toBeVisible();

  // open (a sample) → grid
  await page.getByTestId('sample-sample-trips').click();
  await expect(page.getByTestId('file-name')).toHaveText('sample-trips.csv');
  await expect(page.getByTestId('row-count')).toHaveText('240 rows');
  await expect(page.getByRole('grid')).toBeVisible();
  await expect(page.getByTestId('column-payment_type')).toContainText('4'); // distinct values, from the profile

  // → chart
  await page.getByTestId('column-payment_type').focus();
  await page.keyboard.press('Enter');
  const bars = page.getByRole('listbox', { name: /Rows by payment_type/ });
  await expect(bars).toBeVisible();
  await expect(bars.getByRole('option')).toHaveCount(5); // four payment types and null

  // → cross-filter from a bar (keyboard: Enter selects the focused bar), then undo it and the chart
  await bars.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('row-count')).toContainText('of 240 rows');
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('row-count')).toHaveText('240 rows');
  await page.getByTestId('undo').click();
  await expect(bars).toHaveCount(0);
  await expect(page.getByTestId('charts-drop')).toBeVisible();

  expect(errors).toEqual([]);
});

test('/ opens a picked file through <input type=file>', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('open-csv-empty').click();
  await (await chooser).setFiles({ name: 'mine.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') });
  await expect(page.getByTestId('file-name')).toHaveText('mine.csv');
  await expect(page.getByTestId('row-count')).toHaveText('240 rows');
  expect(errors).toEqual([]);
});

test('/gallery (and ?gallery) renders the component gallery', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/gallery');
  await expect(page.getByRole('heading', { level: 1, name: 'Glassgrid component gallery' })).toBeVisible();
  await expect(page.getByTestId('app')).toHaveCount(0);
  await page.goto('/?gallery');
  await expect(page.getByRole('heading', { level: 1, name: 'Glassgrid component gallery' })).toBeVisible();
  expect(errors).toEqual([]);
});
