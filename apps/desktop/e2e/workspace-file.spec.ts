import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { parseWorkspace, type GlassgridBridge, type WorkspaceSnapshot } from '@glassgrid/core';
import { fingerprintFile } from '@glassgrid/engine';
import { nodeFiles } from '@glassgrid/engine/native';
import { writeFixtureCsv } from './csv-fixture';
import { launchApp } from './support';

/*
 * Workspace files through the real main process and preload: Save As, the
 * recent list, reopening a moved project (relative relink), autosave to the
 * recovery folder and finding that snapshot again after the app closed
 * without saving. The renderer UI is wired at integration, so this drives
 * `window.glassgrid.workspace` directly; native dialogs are stubbed in main.
 */

async function stubDialogs(app: ElectronApplication, paths: { save?: string; open?: string }): Promise<void> {
  await app.evaluate(({ dialog }, { save, open }) => {
    if (save !== undefined) dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: save });
    if (open !== undefined) dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [open] });
  }, paths);
}

test.describe('workspace files', () => {
  let work: string;
  let app: ElectronApplication | undefined;

  test.beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'gg-e2e-workspace-'));
  });

  test.afterEach(async () => {
    await app?.close().catch(() => undefined);
    app = undefined;
    await rm(work, { recursive: true, force: true });
  });

  test('save, reopen a moved project, autosave and recover through main', async () => {
    const project = join(work, 'project');
    await mkdir(project);
    const csvPath = join(project, 'data.csv');
    await writeFixtureCsv(csvPath, 1_000);
    const userData = join(work, 'userData');

    const launched = await launchApp(csvPath, userData);
    app = launched.app;
    const page: Page = launched.page;
    await page.waitForFunction(() => 'glassgrid' in window);

    const csv = await page.evaluate(() => (window as unknown as { glassgrid: GlassgridBridge }).glassgrid.openCsv());
    if (csv.status !== 'opened') throw new Error(`could not open the CSV: ${JSON.stringify(csv)}`);
    const snapshot: WorkspaceSnapshot = {
      dataSource: { handleId: csv.file.handle, fileName: 'data.csv', fingerprint: await fingerprintFile(nodeFiles, csvPath) },
      workspace: {
        columns: [
          { name: 'id', inferredType: 'integer', typeOverride: null },
          { name: 'category', inferredType: 'text', typeOverride: null },
          { name: 'amount', inferredType: 'float', typeOverride: null },
          { name: 'created_on', inferredType: 'date', typeOverride: null },
        ],
        charts: [{ id: 'chart_1', spec: { mark: 'bar', x: { column: 'category' }, filters: [] }, title: 'By category' }],
        selections: { chart_1: { source: 'click', clauses: [{ channel: 'x', filter: { kind: 'in', column: 'category', values: ['alpha'] } }] } },
        userFilters: [],
        grid: { sort: [{ column: 'amount', direction: 'desc' }], columnOrder: [], columnWidths: [] },
        layout: { cards: [{ chartId: 'chart_1', x: 0, y: 0, w: 1, h: 1 }] },
      },
    };

    // Save As: the dialog's answer has no extension; main adds it and writes atomically next to the data.
    await stubDialogs(app, { save: join(project, 'analysis') });
    const saved = await page.evaluate((s) => (window as unknown as { glassgrid: GlassgridBridge }).glassgrid.workspace.saveAs({ documentId: null, snapshot: s }), snapshot);
    expect(saved).toMatchObject({ status: 'saved', workspaceFile: { fileName: 'analysis.glassgrid', directory: project } });
    const onDisk = parseWorkspace(await readFile(join(project, 'analysis.glassgrid'), 'utf8'));
    expect(onDisk.data).toMatchObject({ fileName: 'data.csv', absolutePath: csvPath, relativePath: 'data.csv' });
    expect(onDisk.workspace).toEqual(snapshot.workspace);
    expect(await readdir(project)).toEqual(expect.arrayContaining(['analysis.glassgrid', 'data.csv']));
    expect((await readdir(project)).filter((name) => name.endsWith('.gg-tmp'))).toEqual([]);

    const recent = await page.evaluate(() => (window as unknown as { glassgrid: GlassgridBridge }).glassgrid.workspace.listRecent());
    expect(recent).toEqual([expect.objectContaining({ fileName: 'analysis.glassgrid', directory: project })]);

    // Copy the project elsewhere and open the copy: the data is found next to it (relative path first).
    const moved = join(work, 'moved');
    await cp(project, moved, { recursive: true, preserveTimestamps: true });
    await stubDialogs(app, { open: join(moved, 'analysis.glassgrid') });
    const opened = await page.evaluate(() => (window as unknown as { glassgrid: GlassgridBridge }).glassgrid.workspace.open({ source: 'dialog' }));
    if (opened.status !== 'opened') throw new Error(`expected opened, got ${JSON.stringify(opened)}`);
    expect(opened).toMatchObject({ dataFoundBy: 'relative', fingerprintMismatch: null, file: { displayName: 'data.csv' }, workspaceFile: { directory: moved } });
    expect(opened.file.handle).not.toBe(csv.file.handle);
    expect(opened.workspace).toEqual(snapshot.workspace);
    expect(JSON.stringify(opened)).not.toContain(join(moved, 'data.csv'));

    // Unsaved work reaches the recovery folder within the autosave interval, not the person's file.
    const edited: WorkspaceSnapshot = { dataSource: { ...snapshot.dataSource, handleId: opened.file.handle }, workspace: { ...snapshot.workspace, selections: {} } };
    await page.evaluate((u) => {
      (window as unknown as { glassgrid: GlassgridBridge }).glassgrid.workspace.updateRecovery(u);
    }, { documentId: opened.documentId, snapshot: edited });
    const recoveryDir = join(userData, 'recovery');
    await expect.poll(async () => (await readdir(recoveryDir).catch(() => [])).filter((name) => name.endsWith('.glassgrid')).length, { timeout: 15_000 }).toBe(1);
    expect(parseWorkspace(await readFile(join(moved, 'analysis.glassgrid'), 'utf8')).workspace.selections).toEqual(snapshot.workspace.selections);

    // Close without a renderer close handler: the window closes and the snapshot stays.
    await app.close();
    app = undefined;
    expect((await readdir(recoveryDir)).filter((name) => name.endsWith('.glassgrid'))).toHaveLength(1);

    const relaunched = await launchApp(csvPath, userData);
    app = relaunched.app;
    await relaunched.page.waitForFunction(() => 'glassgrid' in window);
    const offered = await relaunched.page.evaluate(() => (window as unknown as { glassgrid: GlassgridBridge }).glassgrid.workspace.listRecovery());
    expect(offered).toEqual([expect.objectContaining({ workspaceFile: { fileName: 'analysis.glassgrid', directory: moved }, dataFileName: 'data.csv' })]);
    const restored = await relaunched.page.evaluate((id) => (window as unknown as { glassgrid: GlassgridBridge }).glassgrid.workspace.restoreRecovery(id), offered[0]?.id ?? '');
    expect(restored).toMatchObject({ status: 'opened', dataFoundBy: 'relative', recovered: { id: offered[0]?.id } });
  });
});
