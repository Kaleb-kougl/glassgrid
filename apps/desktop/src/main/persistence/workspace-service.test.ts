import { mkdir, mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OpenWorkspaceResultSchema,
  parseWorkspace,
  toFileHandle,
  type FileHandle,
  type OpenWorkspaceResult,
  type PersistedWorkspace,
  type WorkspaceSnapshot,
} from '@glassgrid/core';
import { fingerprintFile } from '@glassgrid/engine';
import { nodeFiles } from '@glassgrid/engine/native';
import { AppStateStore } from './app-state';
import { RecoveryStore } from './recovery';
import { WorkspaceService, type Dialogs } from './workspace-service';

let root: string;
let userData: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gg-service-'));
  userData = join(root, 'userData');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface DialogCall {
  kind: 'save' | 'open';
  options: { title: string; defaultPath?: string; filters: { name: string; extensions: string[] }[] };
}

/** Fake native dialogs: each call takes the next scripted answer (a path, or null for Cancel). */
function scriptedDialogs(answers: (string | null)[]): Dialogs<null> & { calls: DialogCall[] } {
  const calls: DialogCall[] = [];
  return {
    calls,
    showSaveDialog: (_owner, options) => {
      calls.push({ kind: 'save', options });
      const answer = answers.shift() ?? null;
      return Promise.resolve(answer === null ? { canceled: true } : { canceled: false, filePath: answer });
    },
    showOpenDialog: (_owner, options) => {
      calls.push({ kind: 'open', options });
      const answer = answers.shift() ?? null;
      return Promise.resolve(answer === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [answer] });
    },
  };
}

function setup(answers: (string | null)[] = []) {
  const dialogs = scriptedDialogs(answers);
  const handles = new Map<FileHandle, string>();
  let next = 0;
  const registered: string[] = [];
  let clock = Date.UTC(2026, 9, 18, 9, 0, 0);
  const registerFile = (path: string) => {
    registered.push(path);
    const handle = toFileHandle(`00000000-0000-0000-0000-${String(++next).padStart(12, '0')}`);
    handles.set(handle, path);
    return Promise.resolve({ handle, sizeBytes: 42 });
  };
  const service = new WorkspaceService<null>({
    app: { name: 'Glassgrid', version: '1.2.3' },
    dialogs,
    registerFile,
    pathOfHandle: (handle) => handles.get(handle),
    fingerprint: (path) => fingerprintFile(nodeFiles, path),
    appState: new AppStateStore(join(userData, 'state.json')),
    recovery: new RecoveryStore(join(userData, 'recovery')),
    now: () => new Date((clock += 1_000)),
  });
  const win = { key: 1, owner: null };
  return { service, dialogs, handles, registered, win, registerFile };
}

async function csv(path: string, body = 'id,amount\n1,2.5\n2,3.5\n'): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
  return path;
}

const persisted: PersistedWorkspace = {
  columns: [
    { name: 'id', inferredType: 'integer', typeOverride: null },
    { name: 'amount', inferredType: 'float', typeOverride: null },
  ],
  charts: [{ id: 'chart_1', spec: { mark: 'histogram', x: { column: 'amount', bin: 'auto' }, filters: [] }, title: 'Amounts' }],
  selections: { chart_1: { source: 'brush', clauses: [{ channel: 'x', filter: { kind: 'range', column: 'amount', min: 1, max: 3, minInclusive: true, maxInclusive: false } }] } },
  userFilters: [],
  grid: { sort: [{ column: 'amount', direction: 'desc' }], columnOrder: [], columnWidths: [{ column: 'id', width: 80 }] },
  layout: { cards: [{ chartId: 'chart_1', x: 0, y: 0, w: 1, h: 1 }] },
};

/** Opens `dataPath` the way the renderer would (register it), and returns a snapshot over that handle. */
async function snapshotOver(ctx: ReturnType<typeof setup>, dataPath: string, workspace = persisted): Promise<WorkspaceSnapshot> {
  const { handle } = await ctx.registerFile(dataPath);
  ctx.registered.length = 0;
  return { dataSource: { handleId: handle, fileName: 'trips.csv', fingerprint: await fingerprintFile(nodeFiles, dataPath) }, workspace };
}

function opened(result: OpenWorkspaceResult): Extract<OpenWorkspaceResult, { status: 'opened' }> {
  OpenWorkspaceResultSchema.parse(result);
  if (result.status !== 'opened') throw new Error(`expected opened, got ${JSON.stringify(result)}`);
  return result;
}

describe('saving', () => {
  it('Save As defaults to the data folder and name, adds the extension, and writes a valid file', async () => {
    const data = await csv(join(root, 'data', 'trips.csv'));
    const target = join(root, 'work', 'analysis');
    await mkdir(join(root, 'work'));
    const ctx = setup([target]);
    const snapshot = await snapshotOver(ctx, data);

    const result = await ctx.service.save(ctx.win, { documentId: null, snapshot });
    expect(result).toMatchObject({ status: 'saved', workspaceFile: { fileName: 'analysis.glassgrid', directory: join(root, 'work') } });
    expect(ctx.dialogs.calls[0]).toMatchObject({
      kind: 'save',
      options: { title: 'Save Workspace', defaultPath: join(root, 'data', 'trips.glassgrid'), filters: [{ name: 'Glassgrid workspace', extensions: ['glassgrid'] }] },
    });

    const parsed = parseWorkspace(await readFile(`${target}.glassgrid`, 'utf8'));
    expect(parsed.workspace).toEqual(persisted);
    expect(parsed.data).toEqual({ fileName: 'trips.csv', absolutePath: data, relativePath: '../data/trips.csv', fingerprint: snapshot.dataSource.fingerprint });
    expect(parsed.file).toMatchObject({ app: { name: 'Glassgrid', version: '1.2.3' }, savedAt: '2026-10-18T09:00:01.000Z' });
    expect(parsed.file.recoveryOf).toBeUndefined();
    expect((await readdir(join(root, 'work'))).sort()).toEqual(['analysis.glassgrid']);
  });

  it('Save goes to the document\'s file without a dialog; the id is stable per path', async () => {
    const data = await csv(join(root, 'trips.csv'));
    const ctx = setup([join(root, 'a.glassgrid')]);
    const snapshot = await snapshotOver(ctx, data);
    const first = await ctx.service.saveAs(ctx.win, { documentId: null, snapshot });
    if (first.status !== 'saved') throw new Error('not saved');
    const second = await ctx.service.save(ctx.win, { documentId: first.documentId, snapshot: { ...snapshot, workspace: { ...persisted, charts: [], selections: {}, layout: { cards: [] } } } });
    expect(second).toEqual(first);
    expect(ctx.dialogs.calls).toHaveLength(1);
    expect(parseWorkspace(await readFile(join(root, 'a.glassgrid'), 'utf8')).workspace.charts).toEqual([]);
    expect((await ctx.service.listRecent()).map((entry) => entry.fileName)).toEqual(['a.glassgrid']);
  });

  it('a cancelled dialog writes nothing; an unknown data handle or an unwritable folder fails', async () => {
    const data = await csv(join(root, 'trips.csv'));
    const ctx = setup([null, join(root, 'missing-folder', 'x.glassgrid')]);
    const snapshot = await snapshotOver(ctx, data);
    expect(await ctx.service.saveAs(ctx.win, { documentId: null, snapshot })).toEqual({ status: 'cancelled' });
    expect(await ctx.service.saveAs(ctx.win, { documentId: null, snapshot })).toEqual({ status: 'failed', message: 'Could not save x.glassgrid: the file does not exist' });
    const stranger = { ...snapshot, dataSource: { ...snapshot.dataSource, handleId: toFileHandle('ffffffff-ffff-ffff-ffff-ffffffffffff') } };
    expect(await ctx.service.save(ctx.win, { documentId: null, snapshot: stranger })).toMatchObject({ status: 'failed' });
    expect(ctx.dialogs.calls).toHaveLength(2);
  });
});

describe('opening and relinking', () => {
  async function saved(ctx: ReturnType<typeof setup>, workspacePath: string, dataPath: string) {
    await mkdir(join(workspacePath, '..'), { recursive: true });
    const snapshot = await snapshotOver(ctx, dataPath);
    const dialogs = ctx.dialogs as unknown as { showSaveDialog: Dialogs<null>['showSaveDialog'] };
    const original = dialogs.showSaveDialog;
    dialogs.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: workspacePath });
    const result = await ctx.service.saveAs(ctx.win, { documentId: null, snapshot });
    dialogs.showSaveDialog = original;
    if (result.status !== 'saved') throw new Error('save failed');
    return { snapshot, documentId: result.documentId };
  }

  it('opens next to a moved workspace (relative path) and registers the CSV as a handle', async () => {
    const ctx = setup();
    await saved(ctx, join(root, 'project', 'a.glassgrid'), await csv(join(root, 'project', 'data', 'trips.csv')));
    await rename(join(root, 'project'), join(root, 'moved'));

    const later = setup([join(root, 'moved', 'a.glassgrid')]);
    const result = opened(await later.service.open(later.win, { source: 'dialog' }));
    expect(result).toMatchObject({
      dataFoundBy: 'relative',
      fingerprintMismatch: null,
      workspaceFile: { fileName: 'a.glassgrid', directory: join(root, 'moved') },
      file: { displayName: 'trips.csv', sizeBytes: 42 },
      migratedFrom: null,
      recovered: null,
      warnings: [],
    });
    expect(result.workspace).toEqual(persisted);
    expect(later.registered).toEqual([join(root, 'moved', 'data', 'trips.csv')]);
    expect(later.handles.get(result.file.handle)).toBe(join(root, 'moved', 'data', 'trips.csv'));
    expect(later.dialogs.calls[0]).toMatchObject({ kind: 'open', options: { title: 'Open Workspace' } });
    expect(JSON.stringify(result)).not.toContain(join(root, 'moved', 'data'));
  });

  it('falls back to the absolute path when only the workspace moved', async () => {
    const ctx = setup();
    const data = await csv(join(root, 'data', 'trips.csv'));
    await saved(ctx, join(root, 'w', 'a.glassgrid'), data);
    await mkdir(join(root, 'elsewhere', 'deeper'), { recursive: true });
    await rename(join(root, 'w', 'a.glassgrid'), join(root, 'elsewhere', 'deeper', 'a.glassgrid'));
    const result = opened(await ctx.service.openPath(join(root, 'elsewhere', 'deeper', 'a.glassgrid')));
    expect(result.dataFoundBy).toBe('absolute');
    expect(ctx.handles.get(result.file.handle)).toBe(data);
  });

  it('asks to locate missing data, then reports how the located file differs', async () => {
    const ctx = setup();
    const data = await csv(join(root, 'data', 'trips.csv'));
    await saved(ctx, join(root, 'w', 'a.glassgrid'), data);
    await rm(join(root, 'data'), { recursive: true });
    const other = await csv(join(root, 'downloads', 'trips (1).csv'), 'id,amount\n1,2.5\n2,3.5\n3,9\n');

    const located = setup([null, other]);
    const needs = await located.service.openPath(join(root, 'w', 'a.glassgrid'));
    expect(needs).toMatchObject({ status: 'needsData', dataFileName: 'trips.csv', workspaceFile: { fileName: 'a.glassgrid' } });
    if (needs.status !== 'needsData') throw new Error('expected needsData');
    expect(located.registered).toEqual([]);

    // Cancel the picker: the token stays usable.
    expect(await located.service.locateData(located.win, needs.token)).toEqual({ status: 'cancelled' });
    const result = opened(await located.service.locateData(located.win, needs.token));
    expect(result.dataFoundBy).toBe('located');
    expect(result.file.displayName).toBe('trips (1).csv');
    expect(result.fingerprintMismatch).toMatchObject({ sizeBytes: { expected: 22, actual: 26 }, contentChanged: true });
    expect(located.dialogs.calls[1]).toMatchObject({ kind: 'open', options: { title: 'Locate trips.csv', defaultPath: join(root, 'w') } });
    // The token is single-use.
    expect(await located.service.locateData(located.win, needs.token)).toMatchObject({ status: 'failed', code: 'not_found' });
  });

  it('warns when the data at the saved path changed', async () => {
    const ctx = setup();
    const data = await csv(join(root, 'trips.csv'));
    await saved(ctx, join(root, 'a.glassgrid'), data);
    await utimes(data, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    const result = opened(await ctx.service.openPath(join(root, 'a.glassgrid')));
    expect(result.fingerprintMismatch).toEqual({ sizeBytes: null, mtimeMs: { expected: expect.any(Number) as number, actual: Date.parse('2026-01-01T00:00:00Z') }, contentChanged: false });
  });

  it('cancelOpen forgets a pending open', async () => {
    const ctx = setup();
    await saved(ctx, join(root, 'a.glassgrid'), await csv(join(root, 'd', 'trips.csv')));
    await rm(join(root, 'd'), { recursive: true });
    const needs = await ctx.service.openPath(join(root, 'a.glassgrid'));
    if (needs.status !== 'needsData') throw new Error('expected needsData');
    ctx.service.cancelOpen(needs.token);
    expect(await ctx.service.locateData(ctx.win, needs.token)).toMatchObject({ status: 'failed', code: 'not_found' });
  });

  it('reports unreadable, invalid and newer files with their codes', async () => {
    const ctx = setup([null]);
    expect(await ctx.service.open(ctx.win, { source: 'dialog' })).toEqual({ status: 'cancelled' });
    expect(await ctx.service.openPath(join(root, 'nope.glassgrid'))).toMatchObject({ status: 'failed', code: 'io' });
    await writeFile(join(root, 'bad.glassgrid'), '{');
    expect(await ctx.service.openPath(join(root, 'bad.glassgrid'))).toMatchObject({ status: 'failed', code: 'invalid_json' });
    await writeFile(join(root, 'new.glassgrid'), '{"formatVersion": 7}');
    expect(await ctx.service.openPath(join(root, 'new.glassgrid'))).toMatchObject({ status: 'failed', code: 'newer_version' });
  });

  it('opens recent entries by id and prunes ones whose file vanished', async () => {
    const ctx = setup();
    await saved(ctx, join(root, 'a.glassgrid'), await csv(join(root, 'trips.csv')));
    const [entry] = await ctx.service.listRecent();
    if (!entry) throw new Error('no recent entry');
    expect(opened(await ctx.service.open(ctx.win, { source: 'recent', id: entry.id })).documentId).toMatch(/^doc_/);
    await rm(join(root, 'a.glassgrid'));
    expect(await ctx.service.open(ctx.win, { source: 'recent', id: entry.id })).toMatchObject({ status: 'failed', code: 'io' });
    expect(await ctx.service.listRecent()).toEqual([]);
    expect(await ctx.service.open(ctx.win, { source: 'recent', id: entry.id })).toMatchObject({ status: 'failed', code: 'not_found' });
  });

  it('OS hand-offs become single-use tokens', async () => {
    const ctx = setup();
    const { documentId } = await saved(ctx, join(root, 'a.glassgrid'), await csv(join(root, 'trips.csv')));
    const request = ctx.service.externalOpen(join(root, 'a.glassgrid'));
    expect(request).toEqual({ token: expect.stringMatching(/^ot_/) as string, fileName: 'a.glassgrid' });
    expect(opened(await ctx.service.open(ctx.win, { source: 'external', token: request.token })).documentId).toBe(documentId);
    expect(await ctx.service.open(ctx.win, { source: 'external', token: request.token })).toMatchObject({ status: 'failed', code: 'not_found' });
  });
});

describe('autosave and crash recovery', () => {
  it('writes unsaved work to the recovery folder, never over the person\'s file, and deletes it on a clean save', async () => {
    const data = await csv(join(root, 'trips.csv'));
    const ctx = setup([join(root, 'a.glassgrid')]);
    const snapshot = await snapshotOver(ctx, data);
    const first = await ctx.service.saveAs(ctx.win, { documentId: null, snapshot });
    if (first.status !== 'saved') throw new Error('not saved');
    const savedText = await readFile(join(root, 'a.glassgrid'), 'utf8');

    const edited = { ...snapshot, workspace: { ...persisted, grid: { ...persisted.grid, sort: [] } } };
    ctx.service.updateRecovery(ctx.win, { documentId: first.documentId, snapshot: edited });
    await ctx.service.autosaver.flushAll();
    const files = await readdir(join(userData, 'recovery'));
    expect(files).toEqual([`${ctx.service.recoveryIdOf(ctx.win)}.glassgrid`]);
    const recovery = parseWorkspace(await readFile(join(userData, 'recovery', files[0] ?? ''), 'utf8'));
    expect(recovery.file.recoveryOf).toEqual({ workspacePath: join(root, 'a.glassgrid') });
    expect(recovery.data.relativePath).toBe('trips.csv');
    expect(recovery.workspace.grid.sort).toEqual([]);
    expect(await readFile(join(root, 'a.glassgrid'), 'utf8')).toBe(savedText);

    // Saving older work keeps the snapshot (it holds newer edits); saving the edits deletes it.
    await ctx.service.save(ctx.win, { documentId: first.documentId, snapshot });
    expect(await readdir(join(userData, 'recovery'))).toHaveLength(1);
    await ctx.service.save(ctx.win, { documentId: first.documentId, snapshot: edited });
    expect(await readdir(join(userData, 'recovery'))).toEqual([]);
  });

  it('after a crash, lists snapshots newer than their file and restores them over the relinked data', async () => {
    const data = await csv(join(root, 'project', 'trips.csv'));
    const crashed = setup([join(root, 'project', 'a.glassgrid')]);
    const snapshot = await snapshotOver(crashed, data);
    const first = await crashed.service.saveAs(crashed.win, { documentId: null, snapshot });
    if (first.status !== 'saved') throw new Error('not saved');
    const edited = { ...snapshot, workspace: { ...persisted, userFilters: [{ id: 'filter_1', filter: { kind: 'notNull' as const, column: 'id' } }] } };
    crashed.service.updateRecovery(crashed.win, { documentId: first.documentId, snapshot: edited });
    const untitledWin = { key: 2, owner: null };
    crashed.service.updateRecovery(untitledWin, { documentId: null, snapshot });
    await crashed.service.autosaver.flushAll();
    // The file on disk is older than the snapshots (the fake clock is 2026-10-18T09:00).
    const before = new Date('2026-10-18T08:00:00Z');
    await utimes(join(root, 'project', 'a.glassgrid'), before, before);
    // ...the app dies here; nothing is cleaned up.

    const next = setup();
    const offered = await next.service.listRecovery();
    expect(offered).toHaveLength(2);
    const ofFile = offered.find((entry) => entry.workspaceFile !== null);
    expect(ofFile).toMatchObject({ workspaceFile: { fileName: 'a.glassgrid', directory: join(root, 'project') }, dataFileName: 'trips.csv' });
    expect(offered.find((entry) => entry.workspaceFile === null)).toMatchObject({ dataFileName: 'trips.csv' });

    const restored = opened(await next.service.restoreRecovery(next.win, ofFile?.id ?? ''));
    expect(restored).toMatchObject({ recovered: { id: ofFile?.id }, dataFoundBy: 'relative', workspaceFile: { fileName: 'a.glassgrid' } });
    expect(restored.workspace.userFilters).toHaveLength(1);
    expect(next.service.documentPath(restored.documentId)).toBe(join(root, 'project', 'a.glassgrid'));
    // The window now owns that snapshot: it is not offered again while open, and a clean close deletes it.
    expect(await next.service.listRecovery()).toHaveLength(1);
    await next.service.windowClosed(next.win, true);
    expect(await readdir(join(userData, 'recovery'))).toHaveLength(1);

    const untitled = (await next.service.listRecovery())[0];
    await next.service.discardRecovery(untitled?.id ?? '');
    expect(await readdir(join(userData, 'recovery'))).toEqual([]);
  });

  it('drops snapshots older than their workspace file (it was saved later)', async () => {
    const data = await csv(join(root, 'trips.csv'));
    const ctx = setup([join(root, 'a.glassgrid')]);
    const snapshot = await snapshotOver(ctx, data);
    const first = await ctx.service.saveAs(ctx.win, { documentId: null, snapshot });
    if (first.status !== 'saved') throw new Error('not saved');
    ctx.service.updateRecovery(ctx.win, { documentId: first.documentId, snapshot: { ...snapshot, workspace: { ...persisted, charts: [], selections: {}, layout: { cards: [] } } } });
    await ctx.service.autosaver.flushAll();
    const later = new Date('2026-10-18T10:00:00Z');
    await utimes(join(root, 'a.glassgrid'), later, later);

    expect(await setup().service.listRecovery()).toEqual([]);
    expect(await readdir(join(userData, 'recovery'))).toEqual([]);
  });

  it('a window closed without an answer keeps its latest work', async () => {
    const data = await csv(join(root, 'trips.csv'));
    const ctx = setup();
    const snapshot = await snapshotOver(ctx, data);
    ctx.service.updateRecovery(ctx.win, { documentId: null, snapshot });
    await ctx.service.windowClosed(ctx.win, false);
    expect(await readdir(join(userData, 'recovery'))).toHaveLength(1);
    expect(await setup().service.listRecovery()).toHaveLength(1);
  });

  it('the autosaver writes only on its tick, only when changed, and removes the file once clean', async () => {
    const data = await csv(join(root, 'trips.csv'));
    const ctx = setup();
    const snapshot = await snapshotOver(ctx, data);
    const recoveryDir = join(userData, 'recovery');
    ctx.service.updateRecovery(ctx.win, { documentId: null, snapshot });
    await expect(readdir(recoveryDir)).rejects.toThrow();
    await ctx.service.autosaver.flushAll();
    const [name] = await readdir(recoveryDir);
    const firstText = await readFile(join(recoveryDir, name ?? ''), 'utf8');
    await ctx.service.autosaver.flushAll();
    expect(await readFile(join(recoveryDir, name ?? ''), 'utf8')).toBe(firstText);
    ctx.service.updateRecovery(ctx.win, null);
    expect(await readdir(recoveryDir)).toHaveLength(1);
    await ctx.service.autosaver.flushAll();
    expect(await readdir(recoveryDir)).toEqual([]);
  });
});
