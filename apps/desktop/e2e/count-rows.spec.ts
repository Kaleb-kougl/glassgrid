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

async function countOnce(page: Page, label: CountRun['label']): Promise<CountRun> {
  const previous = await measureCount(page, COUNT_ROWS_MEASURE);
  const clickedAt = performance.now();
  await page.getByTestId('count-rows').click();
  const measured = await nextMeasure(page, COUNT_ROWS_MEASURE, previous);
  const outcome = { duration: measured.duration, detail: measured.detail as CountRowsMeasureDetail };
  const wallMs = performance.now() - clickedAt;
  expect(outcome.detail.rowCount).toBe(String(ROWS));

  // The rendered value must match too (strip locale-specific separators).
  await expect
    .poll(async () => (await page.getByTestId('row-count').textContent())?.replace(/\D/g, ''))
    .toBe(String(ROWS));

  return {
    label,
    roundTripMs: outcome.duration,
    engineMs: outcome.detail.engineMs,
    cached: outcome.detail.cached,
    wallMs,
  };
}

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
    const previousOpen = await measureCount(page, OPEN_TO_FIRST_PAGE_MEASURE);
    const previousProfile = await measureCount(page, PROFILE_MEASURE);
    const clickedAt = performance.now();
    await page.getByTestId('open-csv').click();
    const opened = await nextMeasure(page, OPEN_TO_FIRST_PAGE_MEASURE, previousOpen);
    const firstPage = { duration: opened.duration, detail: opened.detail as OpenToFirstPageMeasureDetail };
    const firstPageWallMs = performance.now() - clickedAt;
    await expect(page.getByTestId('file-name')).toHaveText(basename(csvPath));
    expect(firstPage.detail).toMatchObject({ rows: 1000, columns: 4, usingParquetCache: false });
    await expect(page.getByTestId('first-page')).toContainText('4 columns');

    const profiled = await nextMeasure(page, PROFILE_MEASURE, previousProfile);
    const profile = { duration: profiled.duration, detail: profiled.detail as ProfileMeasureDetail };
    expect(profile.detail).toMatchObject({ rowCount: ROWS, columns: 4 });
    const profileTable = page.getByTestId('profile');
    await expect(profileTable.locator('tbody tr')).toHaveCount(4);
    await expect(profileTable.locator('tbody tr').first()).toContainText('integer');

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
        /** Renderer measure: Open CSV click -> first 1,000-row page decoded. */
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
    const amount = page.getByTestId('column-type-amount');
    await expect(amount).toHaveValue('float');
    const history = page.getByTestId('history-entry');
    await expect(history).toHaveCount(1);
    await expect(history.first()).toContainText(`Open ${basename(csvPath)}`);

    await amount.selectOption('text');
    await expect(amount).toHaveValue('text');
    await expect(history).toHaveCount(2);
    await expect(history.nth(1)).toHaveText('Set amount to text by you');

    await page.getByTestId('undo').click();
    await expect(amount).toHaveValue('float');
    await expect(history.nth(1)).toHaveAttribute('data-undone', 'true');

    // Keyboard: redo, then undo again (Ctrl on Linux/Windows, Cmd on macOS).
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+Shift+KeyZ`);
    await expect(amount).toHaveValue('text');
    await page.keyboard.press(`${mod}+KeyZ`);
    await expect(amount).toHaveValue('float');
    await expect(page.getByTestId('redo')).toBeEnabled();

    // The data views are untouched by state-only commands.
    await expect(page.getByTestId('first-page')).toContainText('4 columns');
    expect(rendererErrors, 'renderer console errors (CSP violations, exceptions)').toEqual([]);
  });

  test('runs a bar chart aggregate and shows its rows', async () => {
    const previous = await measureCount(page, AGGREGATE_MEASURE);
    await page.getByTestId('run-aggregate').click();
    const measured = await nextMeasure(page, AGGREGATE_MEASURE, previous);
    const detail = measured.detail as AggregateMeasureDetail;
    expect(detail).toMatchObject({ mark: 'bar', rows: Math.min(ROWS, CATEGORIES.length), cached: false });

    const result = page.getByTestId('aggregate-result');
    await expect(page.getByTestId('aggregate-spec')).toHaveText('{"mark":"bar","x":{"column":"category"}}');
    const rows = result.locator('tbody tr');
    await expect(rows).toHaveCount(Math.min(ROWS, CATEGORIES.length));
    // Row i has category i % 5. Bars sort by count descending, ties by category.
    const expected = CATEGORIES.map((category, k) => ({ category, count: Math.floor((ROWS - 1 - k) / CATEGORIES.length) + 1 }))
      .filter((bar) => bar.count > 0)
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
    for (const [i, bar] of expected.entries()) {
      const cells = rows.nth(i).locator('td');
      await expect(cells.nth(0)).toHaveText(bar.category);
      // Strip locale-specific digit grouping.
      expect((await cells.nth(1).textContent())?.replace(/\D/g, '')).toBe(String(bar.count));
    }
    expect(rendererErrors, 'renderer console errors (CSP violations, exceptions)').toEqual([]);

    const outFile = await writeBaseline('aggregate-bar', {
      benchmark: 'aggregate-bar',
      recordedAt: new Date().toISOString(),
      rows: ROWS,
      fileBytes,
      ...(await machineInfo(app)),
      /** Renderer measure: click -> Arrow decoded; a cold bar chart (count by category) over the CSV. */
      aggregate: { roundTripMs: measured.duration, engineMs: detail.engineMs, cached: detail.cached, rows: detail.rows },
    });
    console.log(`aggregate-bar ${ROWS} rows: ${measured.duration.toFixed(1)} ms (engine ${detail.engineMs.toFixed(1)} ms) -> ${outFile}`);
  });

  test(`counts ${ROWS.toLocaleString('en-US')} rows and records a baseline`, async () => {
    await expect(page.getByTestId('file-name')).toHaveText(basename(csvPath));

    const cold = await countOnce(page, 'cold');
    const warm = await countOnce(page, 'warm');
    expect(cold.cached).toBe(false);
    expect(warm.cached).toBe(true);

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
