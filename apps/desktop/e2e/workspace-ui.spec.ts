import { appendFile, mkdir, mkdtemp, readdir, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { parseWorkspace } from '@glassgrid/core';
import { writeFixtureCsv } from './csv-fixture';
import { answerClosePrompt, axe, clickMenuItem, closePrompts, digits, launchApp, mirrorRow, recentMenuLabels, removeWorkDir, rowsLoaded, screenshot, setTheme, stubDialogs } from './support';

/*
 * Workspace files through the UI of the real app: Save (File → Save
 * Workspace, Ctrl/Cmd+S) and reopening from the start screen's recent list
 * and File → Open Recent, the
 * edited dot (undo back to the saved state clears it), the "Save changes?"
 * veto on close, the app's own "Save this workspace?" before an open
 * replaces unsaved work, the locate prompt for a moved data file with the
 * changed-data banner, and restoring unsaved work after a crash. Native
 * dialogs are stubbed in main (support.ts).
 */

const ROWS = 1_000;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
/** Screenshots for the persistence UI notes (also attached to the report). */
const SHOTS = process.env['GLASSGRID_E2E_SHOTS'];

async function shot(page: Page, name: string): Promise<void> {
  await screenshot(page, name);
  if (SHOTS) {
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  }
}

async function openCsv(page: Page): Promise<void> {
  await page.getByTestId('open-csv-empty').click();
  await expect.poll(async () => digits(await page.getByTestId('row-count').textContent()), { timeout: 60_000 }).toBe(String(ROWS));
}

/** A bar chart of `category` (a column focused in the list, Enter). */
async function chartCategory(page: Page) {
  await page.getByTestId('column-category').press('Enter');
  const chart = page.getByRole('listbox', { name: /Rows by category/ });
  await expect(chart).toBeVisible();
  return chart;
}

const dot = (page: Page) => page.getByTestId('workspace-edited');

async function recoverySnapshots(userData: string): Promise<string[]> {
  return (await readdir(join(userData, 'recovery')).catch(() => [])).filter((name) => name.endsWith('.glassgrid'));
}

/** Kills the main process, as a crash would: no close events, no prompts. */
async function crash(app: ElectronApplication): Promise<void> {
  const exited = new Promise((resolve) => app.process().once('exit', resolve));
  app.process().kill('SIGKILL');
  await exited;
}

test.describe('workspace files in the UI', () => {
  let work: string;
  let project: string;
  let csvPath: string;
  let userData: string;
  let app: ElectronApplication | undefined;

  test.beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'gg-e2e-workspace-ui-'));
    project = join(work, 'project');
    await mkdir(project);
    csvPath = join(project, 'data.csv');
    await writeFixtureCsv(csvPath, ROWS);
    userData = join(work, 'userData');
  });

  test.afterEach(async () => {
    await app?.close().catch(() => undefined);
    app = undefined;
    await removeWorkDir(work);
  });

  async function launch(): Promise<{ app: ElectronApplication; page: Page; rendererErrors: string[] }> {
    const launched = await launchApp(csvPath, userData);
    app = launched.app;
    await expect(launched.page.getByTestId('empty-state')).toBeVisible();
    return launched;
  }

  test('saves from the File menu, tracks unsaved changes by content and reopens from the recent list', async () => {
    const { app: firstApp, page, rendererErrors } = await launch();
    await openCsv(page);
    await expect(page).toHaveTitle('data.csv — Glassgrid');
    // A freshly opened file has nothing to save.
    await expect(dot(page)).toHaveCount(0);

    await chartCategory(page);
    await expect(dot(page)).toBeVisible();
    await expect(page).toHaveTitle(process.platform === 'darwin' ? 'data.csv — Glassgrid' : '● data.csv — Glassgrid');
    // Undo back to what was opened: clean again (the digest matches), redo: dirty.
    await page.getByTestId('undo').click();
    await expect(dot(page)).toHaveCount(0);
    await page.getByTestId('redo').click();
    await expect(dot(page)).toBeVisible();
    await shot(page, 'workspace-edited');

    // Read category as integer: the engine casts every value to null.
    await page.getByTestId('column-category-type').click();
    await page.getByRole('menuitemradio', { name: /Integer/ }).click();
    await expect(mirrorRow(page, 0)).toHaveText(['1', 'null (empty value)', '0.00', '2026-01-01'], { timeout: 60_000 });

    // File → Save Workspace (its accelerator is Ctrl/Cmd+S; the page leaves that key to the menu): Save As the first time.
    await stubDialogs(firstApp, { save: join(project, 'analysis') });
    expect(await clickMenuItem(firstApp, 'save-workspace')).toBe('CmdOrCtrl+S');
    await expect(page.getByRole('status').filter({ hasText: 'Saved analysis.glassgrid' })).toBeVisible();
    await expect(page.getByTestId('workspace-name')).toHaveText('analysis.glassgrid');
    await expect(page.getByTestId('file-name')).toHaveText('data.csv');
    await expect(dot(page)).toHaveCount(0);
    await expect(page).toHaveTitle('analysis.glassgrid — Glassgrid');
    await expect.poll(() => recentMenuLabels(firstApp)).toEqual(['analysis.glassgrid']);
    await shot(page, 'workspace-saved');
    const saved = parseWorkspace(await readFile(join(project, 'analysis.glassgrid'), 'utf8'));
    expect(saved.workspace.charts).toHaveLength(1);
    expect(saved.workspace.columns.find((column) => column.name === 'category')?.typeOverride).toBe('integer');
    expect(saved.data.relativePath).toBe('data.csv');

    // A change after the save, and undoing it: clean again without saving.
    await page.getByTestId('column-amount').press('Enter');
    await expect(dot(page)).toBeVisible();
    await page.keyboard.press(`${mod}+KeyZ`);
    await expect(dot(page)).toHaveCount(0);

    // Clean: closing asks nothing.
    await app?.close();
    app = undefined;
    expect(rendererErrors).toEqual([]);

    // Next launch: the start screen lists it; opening restores the charts and re-applies the column type in the engine.
    const second = await launch();
    const recent = second.page.getByRole('region', { name: 'Recent workspaces' });
    await expect(recent.getByRole('button', { name: /analysis\.glassgrid/ })).toContainText(project);
    await shot(second.page, 'start-screen-recent');
    expect(await axe(second.page, 'start-screen-recent')).toEqual([]);
    await recent.getByRole('button', { name: /analysis\.glassgrid/ }).click();
    await expect(second.page.getByTestId('workspace-name')).toHaveText('analysis.glassgrid');
    await expect(second.page.getByRole('listbox', { name: /Rows by category/ })).toBeVisible();
    await expect(second.page.getByTestId('column-category-type')).toHaveAttribute('data-type', 'integer');
    await rowsLoaded(second.page);
    await expect(mirrorRow(second.page, 0)).toHaveText(['1', 'null (empty value)', '0.00', '2026-01-01'], { timeout: 60_000 });
    await expect(dot(second.page)).toHaveCount(0);
    expect(second.rendererErrors).toEqual([]);
  });

  test('asks before closing with unsaved changes: Cancel keeps the window, Save writes the file and closes', async () => {
    const { app: electronApp, page } = await launch();
    await openCsv(page);
    await chartCategory(page);
    await expect(dot(page)).toBeVisible();

    await answerClosePrompt(electronApp, 'cancel');
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect.poll(() => closePrompts(electronApp)).toEqual(['Do you want to save the changes you made to the workspace for data.csv?']);
    // Vetoed: the window and its work are still there.
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect(page.getByRole('listbox', { name: /Rows by category/ })).toBeVisible();
    await expect(dot(page)).toBeVisible();

    // Save from the prompt: an untitled workspace goes through Save As, then the window closes.
    await stubDialogs(electronApp, { save: join(project, 'closing.glassgrid') });
    await answerClosePrompt(electronApp, 'save');
    const closed = page.waitForEvent('close');
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await closed;
    expect(parseWorkspace(await readFile(join(project, 'closing.glassgrid'), 'utf8')).workspace.charts).toHaveLength(1);
    expect(await recoverySnapshots(userData)).toEqual([]);
  });

  test('asks before opening over unsaved work: Cancel keeps it, Save writes it first and then opens', async () => {
    const { app: electronApp, page, rendererErrors } = await launch();
    await openCsv(page);
    await chartCategory(page);
    await expect(dot(page)).toBeVisible();

    // Open workspace… over unsaved work: the app asks before the native dialog.
    await page.getByTestId('open-workspace').click();
    const prompt = page.getByRole('alertdialog', { name: 'Save this workspace?' });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole('button', { name: 'Save as…' })).toBeFocused();
    await shot(page, 'save-before-replace');
    expect(await axe(page, 'save-before-replace')).toEqual([]);
    await prompt.getByRole('button', { name: 'Cancel' }).click();
    await expect(prompt).toHaveCount(0);
    await expect(page.getByRole('listbox', { name: /Rows by category/ })).toBeVisible();
    await expect(dot(page)).toBeVisible();

    // Open CSV… (the File menu's command): Save as… writes the workspace, then the CSV opens as a new, clean workspace.
    await stubDialogs(electronApp, { save: join(project, 'before-open.glassgrid') });
    await clickMenuItem(electronApp, 'open');
    await prompt.getByRole('button', { name: 'Save as…' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved before-open.glassgrid' })).toBeVisible();
    await expect(page.getByRole('listbox', { name: /Rows by category/ })).toHaveCount(0);
    await expect(dot(page)).toHaveCount(0);
    await rowsLoaded(page);
    expect(parseWorkspace(await readFile(join(project, 'before-open.glassgrid'), 'utf8')).workspace.charts).toHaveLength(1);
    expect(rendererErrors).toEqual([]);
  });

  test('asks for a moved data file and warns that it changed', async () => {
    const { app: firstApp, page } = await launch();
    await openCsv(page);
    await chartCategory(page);
    await stubDialogs(firstApp, { save: join(project, 'analysis.glassgrid') });
    await page.getByTestId('save-workspace').click();
    await expect(page.getByTestId('workspace-name')).toHaveText('analysis.glassgrid');
    await app?.close();
    app = undefined;

    // The data moves out of the project (neither the relative nor the absolute path finds it) and gains rows.
    const elsewhere = join(work, 'elsewhere');
    await mkdir(elsewhere);
    const moved = join(elsewhere, 'data.csv');
    await rename(csvPath, moved);
    await appendFile(moved, '1001,alpha,1.5,2026-02-01\n1002,bravo,2.5,2026-02-02\n');

    const second = await launch();
    // File → Open Recent → analysis.glassgrid (the same openWorkspace command as the start screen's list).
    await expect.poll(() => recentMenuLabels(second.app)).toEqual(['analysis.glassgrid']);
    const recentId = await second.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('open-recent')?.submenu?.items[0]?.id ?? '');
    await clickMenuItem(second.app, recentId);
    const prompt = second.page.getByRole('alertdialog', { name: 'Where is data.csv?' });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole('button', { name: 'Locate data.csv…' })).toBeFocused();
    await shot(second.page, 'locate-data');
    expect(await axe(second.page, 'locate-data')).toEqual([]);

    await stubDialogs(second.app, { open: moved });
    await prompt.getByRole('button', { name: 'Locate data.csv…' }).click();
    await expect(prompt).toHaveCount(0);
    await expect(second.page.getByRole('listbox', { name: /Rows by category/ })).toBeVisible();
    await expect.poll(async () => digits(await second.page.getByTestId('row-count').textContent()), { timeout: 60_000 }).toBe(String(ROWS + 2));
    const banner = second.page.getByRole('alert').filter({ hasText: 'has changed since this workspace was saved' });
    await expect(banner).toContainText('data.csv has changed since this workspace was saved');
    await expect(banner).toContainText('contents differ');
    // The banner takes its own row: it covers neither the grid nor the charts.
    const bannerBox = await banner.boundingBox();
    const panelsBox = await second.page.locator('main.workspace').boundingBox();
    expect(bannerBox && panelsBox && bannerBox.y + bannerBox.height <= panelsBox.y).toBe(true);
    await shot(second.page, 'data-mismatch');
    await banner.getByRole('button', { name: 'Continue' }).click();
    await expect(banner).toHaveCount(0);
    expect(second.rendererErrors).toEqual([]);
  });

  test('restores unsaved work after a crash', async () => {
    const first = await launch();
    await openCsv(first.page);
    await chartCategory(first.page);
    await expect(dot(first.page)).toBeVisible();
    // Main's autosaver writes the report within its interval (5 s).
    await expect.poll(() => recoverySnapshots(userData), { timeout: 20_000 }).toHaveLength(1);
    app = undefined;
    await crash(first.app);

    const { app: second, page, rendererErrors } = await launch();
    const offer = page.getByRole('status').filter({ hasText: 'Unsaved changes from your last session' });
    await expect(offer).toContainText('Untitled (data.csv)');
    await shot(page, 'start-screen-recovery');
    expect(await axe(page, 'start-screen-recovery')).toEqual([]);
    await setTheme(second, page, 'dark');
    await shot(page, 'start-screen-recovery-dark');
    expect(await axe(page, 'start-screen-recovery-dark')).toEqual([]);
    await offer.getByRole('button', { name: 'Restore unsaved changes to Untitled (data.csv)' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Restored unsaved changes to data.csv' })).toBeVisible();
    await expect(page.getByRole('listbox', { name: /Rows by category/ })).toBeVisible();
    // Still unsaved: the dot shows and Save asks where to put it.
    await expect(dot(page)).toBeVisible();
    await expect(page.getByTestId('workspace-name')).toHaveCount(0);
    expect(rendererErrors).toEqual([]);
  });
});
