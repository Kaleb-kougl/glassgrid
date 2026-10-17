import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, tmpdir, totalmem } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { COUNT_ROWS_MEASURE, type CountRowsMeasureDetail } from '../src/renderer/src/perf';
import { e2eRowCount } from './config';
import { writeFixtureCsv } from './csv-fixture';

const APP_DIR = resolve(__dirname, '..');
const RESULTS_DIR = join(APP_DIR, 'e2e-results');
const ROWS = e2eRowCount();
/** Optional path to a packaged app binary (e.g. release/<v>/linux-unpacked/glassgrid). */
const PACKAGED_EXECUTABLE = process.env['GLASSGRID_E2E_EXECUTABLE'];

interface CountRun {
  label: 'cold' | 'warm';
  /** Renderer performance.measure: click handler -> Arrow decoded. */
  roundTripMs: number;
  /** Engine-reported time: DuckDB query + Arrow encode. */
  engineMs: number;
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

async function countOnce(page: Page, label: CountRun['label']): Promise<CountRun> {
  const previous = await page.evaluate(
    (name) => performance.getEntriesByName(name, 'measure').length,
    COUNT_ROWS_MEASURE,
  );

  const clickedAt = performance.now();
  await page.getByTestId('count-rows').click();

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
    { name: COUNT_ROWS_MEASURE, previous },
    { timeout: test.info().timeout, polling: 25 },
  );
  const wallMs = performance.now() - clickedAt;
  const outcome = (await handle.jsonValue()) as
    | { error: string }
    | { duration: number; detail: CountRowsMeasureDetail };

  if ('error' in outcome) throw new Error(`App reported an error: ${outcome.error}`);
  expect(outcome.detail.rowCount).toBe(String(ROWS));

  // The rendered value must match too (strip locale-specific separators).
  await expect
    .poll(async () => (await page.getByTestId('row-count').textContent())?.replace(/\D/g, ''))
    .toBe(String(ROWS));

  return { label, roundTripMs: outcome.duration, engineMs: outcome.detail.engineMs, wallMs };
}

test.describe('count rows', () => {
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

    const env = { ...process.env, GLASSGRID_E2E: '1', GLASSGRID_E2E_OPEN: csvPath };
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

  test(`counts ${ROWS.toLocaleString('en-US')} rows and records a baseline`, async () => {
    await page.getByTestId('open-csv').click();
    await expect(page.getByTestId('file-name')).toHaveText(basename(csvPath));

    const cold = await countOnce(page, 'cold');
    const warm = await countOnce(page, 'warm');

    expect(rendererErrors, 'renderer console errors (CSP violations, exceptions)').toEqual([]);

    if (!app) throw new Error('Electron app failed to launch');
    const versions = await app.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    }));

    const baseline = {
      benchmark: 'count-rows',
      recordedAt: new Date().toISOString(),
      rows: ROWS,
      fileBytes,
      csvGenerationMs,
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
      runs: [cold, warm],
    };

    await mkdir(RESULTS_DIR, { recursive: true });
    const variant = PACKAGED_EXECUTABLE ? '-packaged' : '';
    const outFile = join(RESULTS_DIR, `count-rows-${ROWS}-${platform()}-${arch()}${variant}.json`);
    await writeFile(outFile, `${JSON.stringify(baseline, null, 2)}\n`);
    await test.info().attach('benchmark', { path: outFile, contentType: 'application/json' });
    console.log(
      `count-rows ${ROWS} rows: cold ${cold.roundTripMs.toFixed(1)} ms (engine ${cold.engineMs.toFixed(1)} ms), ` +
        `warm ${warm.roundTripMs.toFixed(1)} ms (engine ${warm.engineMs.toFixed(1)} ms) -> ${outFile}`,
    );
  });
});
