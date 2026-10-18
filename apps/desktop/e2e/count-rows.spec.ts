import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, tmpdir, totalmem } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  AGGREGATE_MEASURE,
  COUNT_ROWS_MEASURE,
  OPEN_TO_FIRST_PAGE_MEASURE,
  PROFILE_MEASURE,
  type AggregateMeasureDetail,
  type CountRowsMeasureDetail,
  type OpenToFirstPageMeasureDetail,
  type ProfileMeasureDetail,
} from '../src/renderer/src/perf';
import { e2eRowCount } from './config';
import { CATEGORIES, writeFixtureCsv } from './csv-fixture';

const APP_DIR = resolve(__dirname, '..');
const RESULTS_DIR = join(APP_DIR, 'e2e-results');
const ROWS = e2eRowCount();
/** Optional path to a packaged app binary (e.g. release/<v>/linux-unpacked/glassgrid). */
const PACKAGED_EXECUTABLE = process.env['GLASSGRID_E2E_EXECUTABLE'];

interface CountRun {
  label: 'cold' | 'warm';
  /** Renderer performance.measure: click handler -> Arrow decoded. */
  roundTripMs: number;
  /** Engine-reported time: DuckDB query + encode (0 when served from the result cache). */
  engineMs: number;
  /** Served from the engine's result cache (the warm run after a cold one). */
  cached: boolean;
  /** Playwright-observed time from click to measure (includes polling). */
  wallMs: number;
}

/** Chromium refuses to run as root without --no-sandbox (containers, some CI). */
function chromiumFlags(): string[] {
  const isRoot = process.platform === 'linux' && process.getuid?.() === 0;
  return isRoot || process.env['GLASSGRID_E2E_NO_SANDBOX'] === '1' ? ['--no-sandbox'] : [];
}

async function duckdbPackageVersion(): Promise<string> {
  const pkg = JSON.parse(
    await readFile(join(APP_DIR, 'node_modules/@duckdb/node-api/package.json'), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

async function measureCount(page: Page, name: string): Promise<number> {
  return page.evaluate((measure) => performance.getEntriesByName(measure, 'measure').length, name);
}

/** Wait for the next performance.measure entry called `name` (or an error shown by the app). */
async function nextMeasure(page: Page, name: string, previous: number): Promise<{ duration: number; detail: unknown }> {
  const handle = await page.waitForFunction(
    ({ name, previous }) => {
      const error = document.querySelector('[data-testid="error"]');
      if (error) return { error: error.textContent };
      const entries = performance.getEntriesByName(name, 'measure') as PerformanceMeasure[];
      const latest = entries.at(-1);
      if (entries.length > previous && latest) {
        return { duration: latest.duration, detail: latest.detail as unknown };
      }
      return null;
    },
    { name, previous },
    { timeout: test.info().timeout, polling: 25 },
  );
  const outcome = (await handle.jsonValue()) as { error: string } | { duration: number; detail: unknown };
  if ('error' in outcome) throw new Error(`App reported an error: ${outcome.error}`);
  return outcome;
}

/** A COUNT_ROWS_MEASURE entry (the grid's "N of M rows" status count). */
interface CountEntry {
  duration: number;
  detail: CountRowsMeasureDetail;
}

async function countEntries(page: Page): Promise<CountEntry[]> {
  return page.evaluate(
    (name) =>
      (performance.getEntriesByName(name, 'measure') as PerformanceMeasure[]).map((entry) => ({
        duration: entry.duration,
        detail: entry.detail as CountRowsMeasureDetail,
      })),
    COUNT_ROWS_MEASURE,
  );
}

function toRun(label: CountRun['label'], entry: CountEntry, wallMs: number): CountRun {
  return { label, roundTripMs: entry.duration, engineMs: entry.detail.engineMs, cached: entry.detail.cached, wallMs };
}

/** Switch the window's theme the way a person does: View → Theme in the application menu. */
async function setTheme(app: ElectronApplication, page: Page, theme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`No menu item ${id}`);
    (item.click as () => void).call(item);
  }, `theme-${theme}`);
  await expect(page.locator('html')).toHaveAttribute('data-gg-theme', theme);
}

/** Screenshot the window once fonts and pending paints have settled. */
async function screenshot(page: Page, name: string): Promise<string> {
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  await mkdir(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `${name}.png`);
  await page.screenshot({ path });
  await test.info().attach(name, { path, contentType: 'image/png' });
  return path;
}

const digits = (text: string | null) => text?.replace(/\D/g, '') ?? '';

async function machineInfo(app: ElectronApplication | undefined) {
  if (!app) throw new Error('Electron app failed to launch');
  const versions = await app.evaluate(() => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }));
  return {
    machine: {
      platform: platform(),
      arch: arch(),
      cpuModel: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      totalMemBytes: totalmem(),
      ci: Boolean(process.env['CI']),
    },
    versions: { ...versions, duckdbNodeApi: await duckdbPackageVersion() },
    packaged: Boolean(PACKAGED_EXECUTABLE),
  };
}

async function writeBaseline(name: string, baseline: object): Promise<string> {
  await mkdir(RESULTS_DIR, { recursive: true });
  const variant = PACKAGED_EXECUTABLE ? '-packaged' : '';
  const outFile = join(RESULTS_DIR, `${name}-${ROWS}-${platform()}-${arch()}${variant}.json`);
  await writeFile(outFile, `${JSON.stringify(baseline, null, 2)}\n`);
  await test.info().attach('benchmark', { path: outFile, contentType: 'application/json' });
  return outFile;
}

test.describe('data path', () => {
  // The tests share one app instance: the first opens the file, the second counts it.
  test.describe.configure({ mode: 'serial' });

  let workDir: string;
  let csvPath: string;
  let fileBytes: number;
  let csvGenerationMs: number;
  let app: ElectronApplication | undefined;
  let page: Page;
  const logs: string[] = [];
  /** Console errors and uncaught exceptions, e.g. CSP violations. */
  const rendererErrors: string[] = [];

  test.beforeAll(async () => {
    if (PACKAGED_EXECUTABLE) {
      if (!existsSync(PACKAGED_EXECUTABLE)) throw new Error(`No packaged app at ${PACKAGED_EXECUTABLE}`);
    } else if (!existsSync(join(APP_DIR, 'out/main/index.js'))) {
      throw new Error('App is not built. Run `pnpm --filter @glassgrid/desktop build` first.');
    }

    workDir = await mkdtemp(join(tmpdir(), 'glassgrid-e2e-'));
    csvPath = join(workDir, `fixture-${ROWS}-rows.csv`);
    const started = performance.now();
    fileBytes = await writeFixtureCsv(csvPath, ROWS);
    csvGenerationMs = performance.now() - started;

    const env = {
      ...process.env,
      GLASSGRID_E2E: '1',
      GLASSGRID_E2E_OPEN: csvPath,
      // Fresh userData per run: no Parquet cache from earlier runs, nothing written to the real profile.
      GLASSGRID_E2E_USER_DATA: join(workDir, 'user-data'),
    };
    const launched = PACKAGED_EXECUTABLE
      ? await electron.launch({ executablePath: PACKAGED_EXECUTABLE, args: chromiumFlags(), env })
      : await electron.launch({ args: [APP_DIR, ...chromiumFlags()], env });
    app = launched;
    launched.process().stdout?.on('data', (chunk: Buffer) => logs.push(`[stdout] ${chunk.toString()}`));
    launched.process().stderr?.on('data', (chunk: Buffer) => logs.push(`[stderr] ${chunk.toString()}`));

    page = await launched.firstWindow();
    page.on('console', (message) => {
      logs.push(`[renderer:${message.type()}] ${message.text()}\n`);
      if (message.type() === 'error') rendererErrors.push(message.text());
    });
    page.on('pageerror', (error) => {
      logs.push(`[renderer:pageerror] ${error.message}\n`);
      rendererErrors.push(error.message);
    });
  });

  // Playwright requires an object pattern for the fixtures argument.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('app-logs', { body: logs.join(''), contentType: 'text/plain' });
    }
  });

  test.afterAll(async () => {
    await app?.close();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  test(`opens ${ROWS.toLocaleString('en-US')} rows, fetches the first page and profiles`, async () => {
    if (!app) throw new Error('Electron app failed to launch');
    // Design frames are 1440x900; the window content matches them for the screenshots.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
    await expect(page.getByTestId('empty-state')).toBeVisible();

    // State B (empty) in both themes.
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(app, page, theme);
      await screenshot(page, `main-empty-${theme}`);
    }
    await setTheme(app, page, 'dark');

    // Drag and drop goes through the preload: a File the page made up has no path, so main never sees one.
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['a,b\n1,2\n'], 'made-up.csv', { type: 'text/csv' }));
      const target = document.querySelector('[data-testid="app"]');
      target?.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      target?.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await expect(page.getByRole('alert')).toContainText('made-up.csv is not a file on this computer');
    await page.getByRole('alert').getByRole('button', { name: 'Dismiss' }).click();

    const previousOpen = await measureCount(page, OPEN_TO_FIRST_PAGE_MEASURE);
    const previousProfile = await measureCount(page, PROFILE_MEASURE);
    const clickedAt = performance.now();
    await page.getByTestId('open-csv').click();
    const opened = await nextMeasure(page, OPEN_TO_FIRST_PAGE_MEASURE, previousOpen);
    const firstPage = { duration: opened.duration, detail: opened.detail as OpenToFirstPageMeasureDetail };
    const firstPageWallMs = performance.now() - clickedAt;
    await expect(page.getByTestId('file-name')).toHaveText(basename(csvPath));
    expect(firstPage.detail).toMatchObject({ rows: 1000, columns: 4, usingParquetCache: false });
    const grid = page.getByTestId('grid');
    await expect(grid.getByRole('columnheader')).toHaveText(['', 'id', 'category', 'amount', 'created_on']);
    await expect(grid.getByRole('row').nth(1).getByRole('gridcell')).toHaveText(['1', 'alpha', '0', '2026-01-01']);

    const profiled = await nextMeasure(page, PROFILE_MEASURE, previousProfile);
    const profile = { duration: profiled.duration, detail: profiled.detail as ProfileMeasureDetail };
    expect(profile.detail).toMatchObject({ rowCount: ROWS, columns: 4 });
    // The column list shows the profile's distinct counts (category has exactly five values).
    await expect(page.getByTestId('column-category')).toContainText(String(Math.min(ROWS, CATEGORIES.length)));
    await expect(page.getByTestId('column-id-type')).toHaveAttribute('data-type', 'integer');
    await expect.poll(async () => digits(await page.getByTestId('row-count').textContent())).toBe(String(ROWS));

    expect(rendererErrors, 'renderer console errors (CSP violations, exceptions)').toEqual([]);

    const baseline = {
      benchmark: 'open-to-first-page',
      /** M1 exit gate: "open-to-first-query baseline recorded" (docs/technical-design.md). */
      milestone: 'M1',
      exitGate: {
        name: 'open-to-first-query',
        firstQuery: `first ${firstPage.detail.rows}-row page`,
        roundTripMs: firstPage.duration,
      },
      recordedAt: new Date().toISOString(),
      rows: ROWS,
      fileBytes,
      csvGenerationMs,
      ...(await machineInfo(app)),
      openToFirstPage: {
        /** Renderer measure: Open click -> first 1,000-row page decoded. */
        roundTripMs: firstPage.duration,
        openEngineMs: firstPage.detail.openEngineMs,
        firstPageEngineMs: firstPage.detail.firstPageEngineMs,
        wallMs: firstPageWallMs,
      },
      profile: {
        /** Renderer measure: profile request -> result, started after the first page. */
        roundTripMs: profile.duration,
        engineMs: profile.detail.engineMs,
      },
    };
    const outFile = await writeBaseline('open-to-first-page', baseline);
    console.log(
      `open-to-first-page ${ROWS} rows: ${firstPage.duration.toFixed(1)} ms ` +
        `(open ${firstPage.detail.openEngineMs.toFixed(1)} ms, page ${firstPage.detail.firstPageEngineMs.toFixed(1)} ms); ` +
        `profile ${profile.duration.toFixed(1)} ms (engine ${profile.detail.engineMs.toFixed(1)} ms) -> ${outFile}`,
    );
  });

  test('changes a column type in the UI and undoes it', async () => {
    const amount = page.getByTestId('column-amount-type');
    await expect(amount).toHaveAttribute('data-type', 'float');
    const historyButton = page.getByTestId('history-button');
    const entries = page.getByTestId('history-entry');
    await historyButton.click();
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText(`Opened ${basename(csvPath)}`);
    await historyButton.click();

    await amount.click();
    await page.getByRole('menuitemradio', { name: /Text/ }).click();
    await expect(amount).toHaveAttribute('data-type', 'text');
    await historyButton.click();
    await expect(entries).toHaveCount(2);
    // Newest first, with its caller.
    await expect(entries.first()).toContainText('Set amount to text');
    await expect(entries.first().getByTestId('history-entry-caller')).toContainText('by you');
    await historyButton.click();

    await page.getByTestId('undo').click();
    await expect(amount).toHaveAttribute('data-type', 'float');
    await historyButton.click();
    await expect(entries.first()).toHaveAttribute('data-undone', 'true');
    await historyButton.click();

    // Keyboard: redo, then undo again (Ctrl on Linux/Windows, Cmd on macOS).
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+Shift+KeyZ`);
    await expect(amount).toHaveAttribute('data-type', 'text');
    await page.keyboard.press(`${mod}+KeyZ`);
    await expect(amount).toHaveAttribute('data-type', 'float');
    await expect(page.getByTestId('redo')).toBeEnabled();

    // The data views are untouched by state-only commands.
    await expect(page.getByTestId('grid').getByRole('row').nth(1).getByRole('gridcell')).toHaveText(['1', 'alpha', '0', '2026-01-01']);
    expect(rendererErrors, 'renderer console errors (CSP violations, exceptions)').toEqual([]);
  });

  test('charts a column, selects a bar and cross-filters the grid', async () => {
    if (!app) throw new Error('Electron app failed to launch');
    const previous = await measureCount(page, AGGREGATE_MEASURE);
    // Drag the category column onto the charts panel: addChart with a bar spec.
    await page.getByTestId('column-category').dragTo(page.getByTestId('charts-drop'));
    const measured = await nextMeasure(page, AGGREGATE_MEASURE, previous);
    const detail = measured.detail as AggregateMeasureDetail;
    expect(detail).toMatchObject({ mark: 'bar', rows: Math.min(ROWS, CATEGORIES.length), cached: false });

    const card = page.locator('[data-testid^="chart-"][data-status]').first();
    await expect(card.getByRole('heading')).toHaveText('Rows by category');
    await expect(card.locator('[data-testid$="-shelf-y"]')).toContainText('count(*)');
    const bars = card.getByRole('listbox');
    const options = bars.getByRole('option');
    // Row i has category i % 5. Bars sort by count descending, ties by category.
    const expected = CATEGORIES.map((category, k) => ({ category, count: Math.floor((ROWS - 1 - k) / CATEGORIES.length) + 1 }))
      .filter((bar) => bar.count > 0)
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
    await expect(options).toHaveCount(expected.length);
    for (const [i, bar] of expected.entries()) {
      await expect(options.nth(i)).toHaveText(`${bar.category}: ${bar.count.toLocaleString('en-US')}`);
    }

    // Click the second bar on the canvas: an `in` filter on category.
    const selected = expected[1] ?? expected[0];
    if (!selected) throw new Error('no bars');
    const box = await bars.locator('canvas').boundingBox();
    if (!box) throw new Error('chart canvas has no box');
    const index = expected.indexOf(selected);
    await page.mouse.click(box.x + box.width / 2, box.y + index * 26 + 10);
    await expect(options.nth(index)).toHaveAttribute('aria-selected', 'true');
    await expect(card).toContainText('1 selected');
    const chip = page.getByTestId('filter-category');
    await expect(chip).toHaveText(`category= ${selected.category}×`);
    await expect.poll(async () => digits(await page.getByTestId('row-count').textContent())).toBe(`${selected.count}${ROWS}`);
    const firstRow = page.getByTestId('grid').getByRole('row').nth(1).getByRole('gridcell');
    await expect(firstRow.nth(1)).toHaveText(selected.category);

    // State A: sort by id, select a range of cells and focus one, as in the design frame.
    await page.getByTestId('grid-header-id').click();
    await expect(page.getByTestId('grid-header-id')).toHaveAttribute('aria-sort', 'ascending');
    await expect(firstRow.nth(0)).toHaveText(String(CATEGORIES.indexOf(selected.category) + 1));
    await expect(page.getByTestId('grid').locator('.gg-grid__cell--placeholder')).toHaveCount(0);
    const cell = (row: number, col: number) => page.getByTestId('grid').getByRole('row').nth(row).getByRole('gridcell').nth(col);
    await cell(7, 2).hover();
    await page.mouse.down();
    await cell(10, 3).hover();
    await page.mouse.up();
    await page.keyboard.press('Shift+ArrowUp');
    await expect(page.getByTestId('column-amount')).toHaveAttribute('data-selected', 'true');
    await page.mouse.move(box.x + box.width / 2, box.y + index * 26 + 10);
    await expect(page.getByRole('tooltip')).toContainText(selected.category);
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(app, page, theme);
      await screenshot(page, `main-populated-${theme}`);
    }
    await setTheme(app, page, 'dark');
    expect(rendererErrors, 'renderer console errors (CSP violations, exceptions)').toEqual([]);

    const outFile = await writeBaseline('aggregate-bar', {
      benchmark: 'aggregate-bar',
      recordedAt: new Date().toISOString(),
      rows: ROWS,
      fileBytes,
      ...(await machineInfo(app)),
      /** Renderer measure: column dropped -> Arrow decoded; a cold bar chart (count by category) over the CSV. */
      aggregate: { roundTripMs: measured.duration, engineMs: detail.engineMs, cached: detail.cached, rows: detail.rows },
    });
    console.log(`aggregate-bar ${ROWS} rows: ${measured.duration.toFixed(1)} ms (engine ${detail.engineMs.toFixed(1)} ms) -> ${outFile}`);
  });

  test(`counts ${ROWS.toLocaleString('en-US')} rows and records a baseline`, async () => {
    await expect(page.getByTestId('file-name')).toHaveText(basename(csvPath));
    // The cold count ran when the file opened ("N rows" in the grid bar).
    const [coldEntry] = (await countEntries(page)).filter((entry) => entry.detail.rowCount === String(ROWS));
    if (!coldEntry) throw new Error('no unfiltered count was measured');
    expect(coldEntry.detail.cached).toBe(false);

    // Removing the filter chip asks for the unfiltered count again: a result-cache hit.
    const before = (await countEntries(page)).length;
    const clearedAt = performance.now();
    await page.getByTestId('filter-category').getByRole('button', { name: 'Remove filter on category' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Removed filter category' })).toBeVisible();
    await expect.poll(async () => (await countEntries(page)).length).toBeGreaterThan(before);
    const warmEntry = (await countEntries(page)).at(-1);
    if (!warmEntry) throw new Error('no warm count');
    const wallMs = performance.now() - clearedAt;
    expect(warmEntry.detail).toMatchObject({ rowCount: String(ROWS), cached: true });
    await expect.poll(async () => digits(await page.getByTestId('row-count').textContent())).toBe(String(ROWS));

    const cold = toRun('cold', coldEntry, coldEntry.duration);
    const warm = toRun('warm', warmEntry, wallMs);
    expect(rendererErrors, 'renderer console errors (CSP violations, exceptions)').toEqual([]);

    const baseline = {
      benchmark: 'count-rows',
      recordedAt: new Date().toISOString(),
      rows: ROWS,
      fileBytes,
      csvGenerationMs,
      ...(await machineInfo(app)),
      runs: [cold, warm],
    };
    const outFile = await writeBaseline('count-rows', baseline);
    console.log(
      `count-rows ${ROWS} rows: cold ${cold.roundTripMs.toFixed(1)} ms (engine ${cold.engineMs.toFixed(1)} ms), ` +
        `warm ${warm.roundTripMs.toFixed(1)} ms (result cache) -> ${outFile}`,
    );
  });
});
