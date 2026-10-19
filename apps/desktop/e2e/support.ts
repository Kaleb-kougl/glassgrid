import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { COUNT_ROWS_MEASURE, type CountRowsMeasureDetail } from '@glassgrid/app/perf';
import { e2eRowCount } from './config';

/*
 * Shared by the E2E specs: launching the app, waiting for performance
 * measures, themes, screenshots, axe, the canvas grid's geometry and the
 * benchmark JSON.
 */

export const APP_DIR = resolve(__dirname, '..');
export const RESULTS_DIR = join(APP_DIR, 'e2e-results');
export const ROWS = e2eRowCount();
/** Optional path to a packaged app binary (e.g. release/<v>/linux-unpacked/glassgrid). */
export const PACKAGED_EXECUTABLE = process.env['GLASSGRID_E2E_EXECUTABLE'];

export interface CountRun {
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
export function chromiumFlags(): string[] {
  const isRoot = process.platform === 'linux' && process.getuid?.() === 0;
  return isRoot || process.env['GLASSGRID_E2E_NO_SANDBOX'] === '1' ? ['--no-sandbox'] : [];
}

export async function duckdbPackageVersion(): Promise<string> {
  const pkg = JSON.parse(
    await readFile(join(APP_DIR, 'node_modules/@duckdb/node-api/package.json'), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

export async function measureCount(page: Page, name: string): Promise<number> {
  return page.evaluate((measure) => performance.getEntriesByName(measure, 'measure').length, name);
}

/** Wait for the next performance.measure entry called `name` (or an error shown by the app). */
export async function nextMeasure(page: Page, name: string, previous: number): Promise<{ duration: number; detail: unknown }> {
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
export interface CountEntry {
  duration: number;
  detail: CountRowsMeasureDetail;
}

export async function countEntries(page: Page): Promise<CountEntry[]> {
  return page.evaluate(
    (name) =>
      (performance.getEntriesByName(name, 'measure') as PerformanceMeasure[]).map((entry) => ({
        duration: entry.duration,
        detail: entry.detail as CountRowsMeasureDetail,
      })),
    COUNT_ROWS_MEASURE,
  );
}

export function toRun(label: CountRun['label'], entry: CountEntry, wallMs: number): CountRun {
  return { label, roundTripMs: entry.duration, engineMs: entry.detail.engineMs, cached: entry.detail.cached, wallMs };
}

/** Switch the window's theme the way a person does: View → Theme in the application menu. */
export async function setTheme(app: ElectronApplication, page: Page, theme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`No menu item ${id}`);
    (item.click as () => void).call(item);
  }, `theme-${theme}`);
  await expect(page.locator('html')).toHaveAttribute('data-gg-theme', theme);
}

/** Screenshot the window once fonts and pending paints have settled. */
export async function screenshot(page: Page, name: string): Promise<string> {
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  await mkdir(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `${name}.png`);
  await page.screenshot({ path });
  await test.info().attach(name, { path, contentType: 'image/png' });
  return path;
}

export const digits = (text: string | null) => text?.replace(/\D/g, '') ?? '';

/** axe-core on the whole window. Legacy mode runs in the page itself (an Electron context cannot open the extra page axe would use). */
export async function axe(page: Page, name: string) {
  const results = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
  await test.info().attach(`axe-${name}`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => `${node.target.join(' ')}: ${node.failureSummary ?? ''}`),
  }));
}

// ---------------------------------------------------------------------------
// The canvas grid: assertions read its ARIA mirror; pointer input goes to the canvas at computed positions.

export const ROW_HEIGHT = 32;
export const HEADER_HEIGHT = 32;

export function mirror(page: Page) {
  return page.getByTestId('grid-mirror');
}

/** Cell texts of a mirrored data row (0 = first row on screen). */
export function mirrorRow(page: Page, index: number) {
  return mirror(page).getByRole('row').nth(index + 1).getByRole('gridcell');
}

export function mirrorHeader(page: Page, name: string) {
  return mirror(page).getByRole('columnheader', { name: new RegExp(`^${name}(,|$)`) });
}

/** Where the grid is on screen and where its columns start and end (published on the scroll spacer). */
export async function gridGeometry(page: Page) {
  const box = await page.getByTestId('grid').boundingBox();
  if (!box) throw new Error('grid has no box');
  const edges = await page.getByTestId('grid-scroller').evaluate((scroller) => {
    const spacer = scroller.firstElementChild as HTMLElement | null;
    return (spacer?.dataset['columnEdges'] ?? '').split(' ').map(Number);
  });
  return {
    box,
    /** Centre of display column `col`'s header. */
    header: (col: number) => ({ x: box.x + ((edges[col] ?? 0) + (edges[col + 1] ?? 0)) / 2, y: box.y + HEADER_HEIGHT / 2 }),
    /** Centre of the cell at on-screen row `row` (0 = first body row) and display column `col`. */
    cell: (row: number, col: number) => ({
      x: box.x + ((edges[col] ?? 0) + (edges[col + 1] ?? 0)) / 2,
      y: box.y + HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2,
    }),
  };
}

/** Every mirrored cell has its value (no page still loading). */
export async function rowsLoaded(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const cells = [...document.querySelectorAll('[data-testid="grid-mirror"] [role="gridcell"]')];
        return cells.length > 0 && cells.every((cell) => cell.textContent !== 'Loading');
      }),
    )
    .toBe(true);
}

export async function machineInfo(app: ElectronApplication | undefined) {
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

export async function writeBaseline(name: string, baseline: object): Promise<string> {
  await mkdir(RESULTS_DIR, { recursive: true });
  const variant = PACKAGED_EXECUTABLE ? '-packaged' : '';
  const outFile = join(RESULTS_DIR, `${name}-${ROWS}-${platform()}-${arch()}${variant}.json`);
  await writeFile(outFile, `${JSON.stringify(baseline, null, 2)}\n`);
  await test.info().attach('benchmark', { path: outFile, contentType: 'application/json' });
  return outFile;
}


export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  /** Main, engine and renderer output, written next to the results when a test fails. */
  logs: string[];
  /** Console errors and uncaught exceptions, e.g. CSP violations. */
  rendererErrors: string[];
}

/**
 * Launch the built app (or GLASSGRID_E2E_EXECUTABLE) with the E2E hooks:
 * "Open" opens `csvPath`, and userData (with the Parquet cache) lives in `userData`.
 */
export async function launchApp(csvPath: string, userData: string, env: Record<string, string> = {}): Promise<LaunchedApp> {
  const fullEnv = { ...process.env, GLASSGRID_E2E: '1', GLASSGRID_E2E_OPEN: csvPath, GLASSGRID_E2E_USER_DATA: userData, ...env };
  const app = PACKAGED_EXECUTABLE
    ? await electron.launch({ executablePath: PACKAGED_EXECUTABLE, args: chromiumFlags(), env: fullEnv })
    : await electron.launch({ args: [APP_DIR, ...chromiumFlags()], env: fullEnv });
  const logs: string[] = [];
  const rendererErrors: string[] = [];
  app.process().stdout?.on('data', (chunk: Buffer) => logs.push(`[stdout] ${chunk.toString()}`));
  app.process().stderr?.on('data', (chunk: Buffer) => logs.push(`[stderr] ${chunk.toString()}`));
  const page = await app.firstWindow();
  // The window's size decides how many grid columns are on screen, and so in the accessibility mirror the tests
  // read. Windows and macOS shrink a new window to a small CI display (1440x900 is the design frame), so every
  // test starts at that content size; macOS also needs `enableLargerThanScreen`, set under GLASSGRID_E2E in main.
  // The sizes go into the logs, so a failure on a small display explains itself.
  const sizes = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setContentSize(1440, 900);
    return { workArea: screen.getPrimaryDisplay().workAreaSize, content: win?.getContentSize() ?? [] };
  });
  logs.push(`[e2e] display work area ${sizes.workArea.width}x${sizes.workArea.height}, window content ${sizes.content.join('x')}\n`);
  // "Save changes?" on close: Don't Save unless a test says otherwise (a native box would block the run).
  await answerClosePrompt(app, 'dontSave');
  page.on('console', (message) => {
    logs.push(`[renderer:${message.type()}] ${message.text()}\n`);
    if (message.type() === 'error') rendererErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    logs.push(`[renderer:pageerror] ${error.message}\n`);
    rendererErrors.push(error.message);
  });
  return { app, page, logs, rendererErrors };
}

/** Every performance.measure entry called `name` (duration and detail). */
export async function measures(page: Page, name: string): Promise<{ duration: number; detail: unknown }[]> {
  return page.evaluate(
    (measure) => (performance.getEntriesByName(measure, 'measure') as PerformanceMeasure[]).map((entry) => ({ duration: entry.duration, detail: entry.detail as unknown })),
    name,
  );
}

/** p50 / p95 (nearest rank) and the extremes of a sample. */
export function stats(values: readonly number[]): { n: number; min: number; p50: number; p95: number; max: number; mean: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? Number.NaN;
  return {
    n: sorted.length,
    min: sorted[0] ?? Number.NaN,
    p50: rank(0.5),
    p95: rank(0.95),
    max: sorted.at(-1) ?? Number.NaN,
    mean: sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length),
  };
}

/** Answer main's native Save / Open dialogs with these paths instead of showing them. */
export async function stubDialogs(app: ElectronApplication, paths: { save?: string; open?: string }): Promise<void> {
  await app.evaluate(({ dialog }, { save, open }) => {
    if (save !== undefined) dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: save });
    if (open !== undefined) dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [open] });
  }, paths);
}

const CLOSE_BUTTONS = { save: 0, dontSave: 1, cancel: 2 } as const;

/**
 * Answer main's "Do you want to save the changes…?" box (close-guard.ts)
 * with a button, without showing it; every message it would have shown is
 * recorded for `closePrompts`.
 */
export async function answerClosePrompt(app: ElectronApplication, button: keyof typeof CLOSE_BUTTONS): Promise<void> {
  await app.evaluate(({ dialog }, response) => {
    const record = globalThis as { ggClosePrompts?: string[] };
    record.ggClosePrompts ??= [];
    const prompts = record.ggClosePrompts;
    dialog.showMessageBox = ((...args: unknown[]) => {
      const options = args.at(-1) as { message?: string };
      prompts.push(options.message ?? '');
      return Promise.resolve({ response, checkboxChecked: false });
    });
  }, CLOSE_BUTTONS[button]);
}

/** The close prompts main has shown so far (see `answerClosePrompt`). */
export async function closePrompts(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => [...((globalThis as { ggClosePrompts?: string[] }).ggClosePrompts ?? [])]);
}

/**
 * Click an application-menu item by id, as a person would from the menu or
 * its accelerator (Playwright's synthetic keys reach the page, not Electron's
 * menu accelerators). Resolves with the item's accelerator.
 */
export async function clickMenuItem(app: ElectronApplication, id: string): Promise<string | undefined> {
  return app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`No menu item ${itemId}`);
    (item.click as () => void).call(item);
    return item.accelerator ?? undefined;
  }, id);
}

/** Labels of the File → Open Recent submenu. */
export async function recentMenuLabels(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('open-recent')?.submenu?.items.map((item) => item.label) ?? []);
}

/**
 * Remove a test's temp folder. On Windows, Electron's helper processes can hold files in userData for a moment
 * after the app closes (EBUSY); `rm` retries those errors with a back-off instead of failing the test.
 */
export async function removeWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
