import { existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { downscalePng, ensureDir, log, MEDIA_DIR, parkPointer, REPO_ROOT, run, sandboxFlags, SCALE, settle, SHOT, WORK_DIR } from './common.ts';

/*
 * The desktop app (apps/desktop, built by electron-vite) on a large CSV:
 * the grid with four charts and unsaved changes, then the same window
 * after File → Save Workspace. Runs in its own process because Electron on
 * Linux needs a display: run.ts starts it under xvfb-run when there is none.
 *
 *   node tools/showcase/src/desktop.ts
 *
 * Uses the app's E2E hooks (GLASSGRID_E2E=1): Open reads the CSV below
 * instead of showing the native dialog, and userData (with its Parquet
 * cache) lives in a throwaway folder. The native Save dialog and the
 * close prompt are answered in main, as the E2E suite does.
 */

const APP_DIR = join(REPO_ROOT, 'apps', 'desktop');
const WORK = join(WORK_DIR, 'desktop');
const PROJECT = join(WORK, 'project');
/** The pinned synthetic benchmark CSV from tools/datasets: 10,000,000 rows, 14 columns, 1.5 GB. */
const DATASET = 'synthetic-10m-seed42';
const CSV = join(PROJECT, `${DATASET}.csv`);
const ROWS = '10,000,000';
const CHART_COLUMNS = ['region', 'quantity', 'status', 'event_time'];
const WORKSPACE = join(PROJECT, 'orders-analysis.glassgrid');

/**
 * Generates the CSV with the datasets tool on the first run (about 1 to 2
 * minutes on 2 cores) and keeps it for later runs; the tool's manifest is
 * written last, so a CSV without one is incomplete and is made again.
 */
async function ensureCsv(): Promise<number> {
  if (!existsSync(join(PROJECT, `${DATASET}.manifest.json`)) || !existsSync(CSV)) {
    log(`generating ${DATASET}.csv with tools/datasets (first run only)`);
    await run('pnpm', ['--filter', '@glassgrid/datasets', 'synthetic', '--rows', '10m', '--seed', '42', '--out', PROJECT]);
  }
  return (await stat(CSV)).size;
}

async function still(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))));
  const raw = join(WORK_DIR, 'raw', `${name}@2x.png`);
  await page.screenshot({ path: raw, animations: 'disabled', caret: 'hide' });
  await downscalePng(raw, join(MEDIA_DIR, `${name}.png`), SHOT.width);
  log(`wrote docs/images/showcase/${name}.png`);
}

async function menu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`No menu item ${itemId}`);
    (item.click as () => void).call(item);
  }, id);
}

async function main(): Promise<void> {
  const started = performance.now();
  await ensureDir(join(WORK_DIR, 'raw'));
  await ensureDir(MEDIA_DIR);
  const bytes = await ensureCsv();
  log(`desktop data: ${CSV} (${(bytes / 1e6).toFixed(0)} MB)`);
  await rm(join(WORK, 'userData'), { recursive: true, force: true });
  await rm(WORKSPACE, { force: true });

  const electronPath = createRequire(join(APP_DIR, 'package.json'))('electron') as unknown as string;
  const app = await electron.launch({
    executablePath: electronPath,
    args: [APP_DIR, `--force-device-scale-factor=${SCALE}`, ...sandboxFlags()],
    env: { ...process.env, GLASSGRID_E2E: '1', GLASSGRID_E2E_OPEN: CSV, GLASSGRID_E2E_USER_DATA: join(WORK, 'userData') },
  });
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (error) => console.warn(`[showcase] renderer error: ${error.message}`));
    await app.evaluate(({ BrowserWindow, dialog }, { width, height, workspace }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setContentSize(width, height);
      // Native dialogs would block an unattended run: Save writes the workspace below; closing does not save again.
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: workspace });
      dialog.showMessageBox = () => Promise.resolve({ response: 1, checkboxChecked: false });
    }, { ...SHOT, workspace: WORKSPACE });
    await page.waitForFunction(({ width }) => window.innerWidth === width, SHOT);
    await menu(app, 'theme-light');
    await page.getByTestId('empty-state').waitFor();

    // Open the CSV and wait for the profile and the full row count (and a background Parquet copy, if it started).
    await page.getByTestId('open-csv-empty').click();
    await page.waitForFunction((rows) => (document.querySelector('[data-testid="row-count"]')?.textContent ?? '').trim().startsWith(`${rows} rows`), ROWS, { timeout: 300_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="app"]')?.getAttribute('data-parquet') !== 'converting', undefined, { timeout: 300_000, polling: 250 });

    // Four charts by the default chart rules: a column focused in the list, Enter.
    for (const [index, column] of CHART_COLUMNS.entries()) {
      await page.getByTestId(`column-${column}`).press('Enter');
      await settle(page, { charts: index + 1 });
    }
    await page.getByTestId('workspace-edited').waitFor();
    await parkPointer(page);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await settle(page, { charts: 4 });
    await still(page, 'desktop-csv-charts');

    // File → Save Workspace: Save As the first time, then the toast and the workspace's name in the top bar.
    await menu(app, 'save-workspace');
    await page.getByRole('status').filter({ hasText: 'Saved orders-analysis.glassgrid' }).waitFor();
    await page.getByTestId('workspace-name').filter({ hasText: 'orders-analysis.glassgrid' }).waitFor();
    await settle(page, { charts: 4 });
    await still(page, 'desktop-saved');
  } finally {
    await app.close().catch(() => undefined);
  }
  log(`desktop captures done in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

await main();
