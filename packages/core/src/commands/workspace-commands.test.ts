import { describe, expect, it, vi } from 'vitest';
import type { OpenWorkspaceResult, RecoveryUpdate, SaveWorkspaceRequest, SaveWorkspaceResult } from '../protocol/workspace.js';
import type { WorkspaceBridge } from '../protocol/ipc.js';
import { closeAnswer, provideWorkspacePersistence, reportUnsavedWork } from '../workspace-file/host.js';
import { digestPersisted, isWorkspaceDirty, persistedWorkspace, type OpenedData } from '../workspace-file/persisted.js';
import { must, taxiData, taxiWorkspace } from '../workspace-file/test-support.js';
import { CommandError } from './errors.js';
import { desktopLikePolicy, openFileInput, testWorkspace } from './test-support.js';

const user = { caller: 'user' as const };
const ai = { caller: 'ai' as const };
const saved = persistedWorkspace(taxiWorkspace());
const DOC_ID = 'doc_aaaaaaaa-1111';

function loadInput(overrides: Partial<{ data: OpenedData; recovered: boolean }> = {}) {
  return {
    data: overrides.data ?? taxiData(),
    workspace: saved,
    document: { id: DOC_ID, fileName: 'trips.glassgrid' },
    recovered: overrides.recovered ?? false,
  };
}

describe('dirty tracking through commands', () => {
  it('a freshly opened CSV is clean; edits make it dirty and undoing them makes it clean again', async () => {
    const { registry, store } = testWorkspace();
    await registry.dispatch('openFile', openFileInput(), user);
    expect(store.getState().document).toMatchObject({ id: null, fileName: null });
    expect(isWorkspaceDirty(store.getState())).toBe(false);

    await registry.dispatch('setColumnProfiles', { columns: [{ name: 'amount', type: 'float', distinctCount: 3, nullFraction: 0, min: 0, max: 1 }] }, user);
    await registry.dispatch('setSelection', { selection: { anchor: { row: 0, column: 'id' }, focus: { row: 0, column: 'id' } } }, user);
    expect(isWorkspaceDirty(store.getState())).toBe(false);

    await registry.dispatch('sortGrid', { sort: [{ column: 'amount', direction: 'desc' }] }, ai);
    expect(isWorkspaceDirty(store.getState())).toBe(true);
    await registry.dispatch('undo', {}, user);
    expect(isWorkspaceDirty(store.getState())).toBe(false);
  });

  it('markWorkspaceSaved records the save without an undo entry', async () => {
    const { registry, store } = testWorkspace();
    await registry.dispatch('openFile', openFileInput(), user);
    await registry.dispatch('addChart', { columns: ['category'] }, user);
    const digest = digestPersisted(persistedWorkspace(store.getState()));
    const history = store.getHistory();
    const { entryId } = await registry.dispatch('markWorkspaceSaved', { documentId: DOC_ID, fileName: 'sales.glassgrid', savedDigest: digest }, user);
    expect(entryId).toBeNull();
    expect(store.getHistory()).toBe(history);
    expect(store.getState().document).toEqual({ id: DOC_ID, fileName: 'sales.glassgrid', savedDigest: digest });
    expect(isWorkspaceDirty(store.getState())).toBe(false);

    // Undoing past the save leaves work that differs from the file.
    await registry.dispatch('undo', {}, user);
    expect(isWorkspaceDirty(store.getState())).toBe(true);
    await registry.dispatch('redo', {}, user);
    expect(isWorkspaceDirty(store.getState())).toBe(false);
  });
});

describe('loadWorkspace', () => {
  it('replaces the workspace in one undo entry and starts clean', async () => {
    const { registry, store } = testWorkspace();
    await registry.dispatch('openFile', openFileInput(), user);
    const before = store.getState();
    const { entryId } = await registry.dispatch('loadWorkspace', loadInput(), user);
    expect(entryId).not.toBeNull();
    const state = store.getState();
    expect(persistedWorkspace(state)).toEqual(saved);
    expect(state.dataSource?.handleId).toBe(taxiData().handleId);
    expect(state.grid.selection).toBeNull();
    expect(state.document).toEqual({ id: DOC_ID, fileName: 'trips.glassgrid', savedDigest: digestPersisted(saved) });
    expect(isWorkspaceDirty(state)).toBe(false);

    await registry.dispatch('undo', {}, user);
    expect(store.getState()).toEqual(before);
  });

  it('a recovery snapshot, or a workspace that lost something on restore, starts dirty', async () => {
    const { registry, store } = testWorkspace();
    await registry.dispatch('loadWorkspace', loadInput({ recovered: true }), user);
    expect(isWorkspaceDirty(store.getState())).toBe(true);

    const data = taxiData();
    await registry.dispatch('loadWorkspace', loadInput({ data: { ...data, columns: data.columns.slice(1) } }), user);
    expect(store.getState().charts).toHaveLength(3);
    expect(isWorkspaceDirty(store.getState())).toBe(true);
  });

  it('is not available to AI callers, nor is markWorkspaceSaved', async () => {
    const { registry } = testWorkspace();
    await expect(registry.dispatch('loadWorkspace', loadInput(), ai)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(registry.dispatch('markWorkspaceSaved', { documentId: DOC_ID, fileName: 'a.glassgrid', savedDigest: '0123456789abcdef' }, ai)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('validates its input', async () => {
    const { registry } = testWorkspace();
    await expect(registry.dispatch('loadWorkspace', { ...loadInput(), document: { id: 'not-a-doc', fileName: null } }, user)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

// ---------------------------------------------------------------------------

function fakeBridge(overrides: Partial<WorkspaceBridge> = {}) {
  const calls: { method: string; request: unknown }[] = [];
  const saveResult: SaveWorkspaceResult = { status: 'saved', documentId: DOC_ID, workspaceFile: { fileName: 'trips.glassgrid', directory: '/work' } };
  const bridge = {
    save: vi.fn((request: SaveWorkspaceRequest) => (calls.push({ method: 'save', request }), Promise.resolve(saveResult))),
    saveAs: vi.fn((request: SaveWorkspaceRequest) => (calls.push({ method: 'saveAs', request }), Promise.resolve(saveResult))),
    open: vi.fn((request: unknown) => {
      calls.push({ method: 'open', request });
      return Promise.resolve<OpenWorkspaceResult>({
        status: 'opened',
        documentId: DOC_ID,
        workspaceFile: { fileName: 'trips.glassgrid', directory: '/work' },
        file: { handle: taxiData().handleId, displayName: 'trips 2026.csv', sizeBytes: 10 },
        dataFoundBy: 'relative',
        fingerprintMismatch: null,
        workspace: saved,
        warnings: [],
        migratedFrom: null,
        recovered: null,
      });
    }),
    listRecent: vi.fn(() => Promise.resolve([{ id: `rw_${'a'.repeat(24)}`, fileName: 'trips.glassgrid', directory: '/secret/place', lastOpenedAt: '2026-10-18T09:00:00.000Z' }])),
    ...overrides,
  };
  return { bridge, calls };
}

const openTable = () => Promise.resolve({ fingerprint: taxiData().fingerprint, columns: taxiData().columns });

describe('workspace effect commands', () => {
  it('saveWorkspace saves the snapshot, then records the save', async () => {
    const { registry, store } = testWorkspace(desktopLikePolicy);
    const { bridge, calls } = fakeBridge();
    provideWorkspacePersistence({ registry, bridge, openTable });
    await registry.dispatch('openFile', openFileInput(), user);
    await registry.dispatch('addChart', { columns: ['category'] }, user);

    const result = await registry.dispatch('saveWorkspace', {}, user);
    expect(result.value).toEqual({ status: 'saved', workspaceFile: { fileName: 'trips.glassgrid', directory: '/work' } });
    expect(calls[0]).toMatchObject({ method: 'save', request: { documentId: null } });
    expect((calls[0]?.request as SaveWorkspaceRequest).snapshot.workspace.charts).toHaveLength(1);
    expect(store.getState().document).toMatchObject({ id: DOC_ID, fileName: 'trips.glassgrid' });
    expect(isWorkspaceDirty(store.getState())).toBe(false);

    await registry.dispatch('saveWorkspaceAs', {}, user);
    expect(calls[1]).toMatchObject({ method: 'saveAs', request: { documentId: DOC_ID } });
  });

  it('edits made while a save is in flight stay unsaved', async () => {
    const { registry, store } = testWorkspace(desktopLikePolicy);
    const pending: ((value: SaveWorkspaceResult) => void)[] = [];
    const { bridge } = fakeBridge({ save: () => new Promise((resolve) => pending.push(resolve)) });
    provideWorkspacePersistence({ registry, bridge, openTable });
    await registry.dispatch('openFile', openFileInput(), user);
    await registry.dispatch('addChart', { columns: ['category'] }, user);

    const saving = registry.dispatch('saveWorkspace', {}, user);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await registry.dispatch('sortGrid', { sort: [{ column: 'id', direction: 'asc' }] }, user);
    pending[0]?.({ status: 'saved', documentId: DOC_ID, workspaceFile: { fileName: 'a.glassgrid', directory: '/' } });
    await saving;
    expect(isWorkspaceDirty(store.getState())).toBe(true);
    await registry.dispatch('undo', {}, user);
    expect(isWorkspaceDirty(store.getState())).toBe(false);
  });

  it('a cancelled or failed save records nothing; without a file there is nothing to save', async () => {
    const { registry, store } = testWorkspace(desktopLikePolicy);
    const { bridge } = fakeBridge({ save: () => Promise.resolve({ status: 'cancelled' }), saveAs: () => Promise.resolve({ status: 'failed', message: 'Disk full' }) });
    provideWorkspacePersistence({ registry, bridge, openTable });
    await expect(registry.dispatch('saveWorkspace', {}, user)).rejects.toMatchObject({ code: 'precondition_failed' });
    await registry.dispatch('openFile', openFileInput(), user);
    const document = store.getState().document;
    expect((await registry.dispatch('saveWorkspace', {}, user)).value).toEqual({ status: 'cancelled' });
    expect((await registry.dispatch('saveWorkspaceAs', {}, user)).value).toEqual({ status: 'failed', message: 'Disk full' });
    expect(store.getState().document).toBe(document);
  });

  it('saving is write tier: AI callers need the policy to allow it', async () => {
    const { registry } = testWorkspace(desktopLikePolicy);
    const { bridge } = fakeBridge();
    provideWorkspacePersistence({ registry, bridge, openTable });
    await registry.dispatch('openFile', openFileInput(), user);
    await expect(registry.dispatch('saveWorkspace', {}, ai)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(registry.dispatch('saveWorkspaceAs', {}, ai)).rejects.toMatchObject({ code: 'forbidden' });
    expect(bridge.save).not.toHaveBeenCalled();

    const permissive = testWorkspace({ confirmWrite: () => true });
    provideWorkspacePersistence({ registry: permissive.registry, bridge, openTable });
    await permissive.registry.dispatch('openFile', openFileInput(), user);
    await expect(permissive.registry.dispatch('saveWorkspace', {}, ai)).resolves.toMatchObject({ value: { status: 'saved' } });
  });

  it('openWorkspace loads the file over the opened data and reports warnings', async () => {
    const { registry, store } = testWorkspace(desktopLikePolicy);
    const { bridge } = fakeBridge();
    const data = taxiData();
    provideWorkspacePersistence({ registry, bridge, openTable: () => Promise.resolve({ fingerprint: data.fingerprint, columns: data.columns.slice(0, -1) }) });
    const { value, entryId } = await registry.dispatch('openWorkspace', { source: 'dialog' }, user);
    expect(entryId).toBeNull();
    expect(value).toMatchObject({ status: 'opened', dataFoundBy: 'relative', recovered: false, workspaceFile: { fileName: 'trips.glassgrid' } });
    expect((value as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toEqual(['column_missing', 'selection_dropped']);
    expect(store.getState().document?.id).toBe(DOC_ID);
    expect(store.getHistory().past.at(-1)).toMatchObject({ name: 'loadWorkspace', caller: 'user' });
  });

  it('AI callers may open only from the recent list', async () => {
    const { registry } = testWorkspace(desktopLikePolicy);
    const { bridge } = fakeBridge();
    provideWorkspacePersistence({ registry, bridge, openTable });
    const refused = registry.dispatch('openWorkspace', { source: 'dialog' }, ai);
    await expect(refused).rejects.toBeInstanceOf(CommandError);
    await expect(refused).rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(/recent list/) as string });
    await expect(registry.dispatch('openWorkspace', { source: 'external', token: 'ot_12345678' }, ai)).rejects.toMatchObject({ code: 'forbidden' });
    expect(bridge.open).not.toHaveBeenCalled();

    const id = `rw_${'a'.repeat(24)}`;
    await expect(registry.dispatch('openWorkspace', { source: 'recent', id }, ai)).resolves.toMatchObject({ value: { status: 'opened' } });
    expect(bridge.open).toHaveBeenCalledWith({ source: 'recent', id });
    // The rule is checked even when the host has not implemented the command.
    const bare = testWorkspace(desktopLikePolicy);
    await expect(bare.registry.dispatch('openWorkspace', { source: 'dialog' }, ai)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(bare.registry.dispatch('openWorkspace', { source: 'dialog' }, user)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('passes needsData, cancelled and failed results through without touching state', async () => {
    const { registry, store } = testWorkspace();
    const results: OpenWorkspaceResult[] = [
      { status: 'needsData', token: 'ot_abcdefgh', workspaceFile: null, dataFileName: 'trips.csv', warnings: [] },
      { status: 'cancelled' },
      { status: 'failed', code: 'newer_version', message: 'Update Glassgrid' },
    ];
    const { bridge } = fakeBridge({ open: () => Promise.resolve(must(results.shift())) });
    provideWorkspacePersistence({ registry, bridge, openTable });
    const before = store.getState();
    expect((await registry.dispatch('openWorkspace', { source: 'dialog' }, user)).value).toMatchObject({ status: 'needsData', token: 'ot_abcdefgh' });
    expect((await registry.dispatch('openWorkspace', { source: 'dialog' }, user)).value).toEqual({ status: 'cancelled' });
    expect((await registry.dispatch('openWorkspace', { source: 'dialog' }, user)).value).toMatchObject({ status: 'failed', code: 'newer_version' });
    expect(store.getState()).toBe(before);
  });

  it('reports data the engine cannot open as data_unreadable', async () => {
    const { registry, store } = testWorkspace();
    const { bridge } = fakeBridge();
    provideWorkspacePersistence({ registry, bridge, openTable: () => Promise.reject(new Error('Permission denied')) });
    const before = store.getState();
    expect((await registry.dispatch('openWorkspace', { source: 'dialog' }, user)).value).toEqual({
      status: 'failed',
      code: 'data_unreadable',
      message: 'Could not open trips 2026.csv: Permission denied',
    });
    expect(store.getState()).toBe(before);
  });

  it('listRecentWorkspaces gives ids and names, not folders', async () => {
    const { registry } = testWorkspace();
    const { bridge } = fakeBridge();
    provideWorkspacePersistence({ registry, bridge, openTable });
    expect((await registry.dispatch('listRecentWorkspaces', {}, ai)).value).toEqual([
      { id: `rw_${'a'.repeat(24)}`, fileName: 'trips.glassgrid', lastOpenedAt: '2026-10-18T09:00:00.000Z' },
    ]);
  });
});

describe('recovery reporting and the close prompt', () => {
  it('reports unsaved work once per change and null once clean', async () => {
    const { registry, store } = testWorkspace();
    const updates: (RecoveryUpdate | null)[] = [];
    const stop = reportUnsavedWork(store, (update) => updates.push(update));
    await registry.dispatch('openFile', openFileInput(), user);
    expect(updates).toEqual([]);
    await registry.dispatch('addChart', { columns: ['category'] }, user);
    await registry.dispatch('setSelection', { selection: { anchor: { row: 0, column: 'id' }, focus: { row: 0, column: 'id' } } }, user);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ documentId: null, snapshot: { dataSource: { fileName: 'sales.csv' } } });
    await registry.dispatch('sortGrid', { sort: [{ column: 'id', direction: 'asc' }] }, user);
    expect(updates).toHaveLength(2);
    await registry.dispatch('undo', {}, user);
    await registry.dispatch('undo', {}, user);
    expect(updates).toHaveLength(4);
    expect(updates.at(-1)).toBeNull();
    stop();
    await registry.dispatch('redo', {}, user);
    expect(updates).toHaveLength(4);
  });

  it('closeAnswer says whether to ask, with the snapshot to save', async () => {
    const { registry, store } = testWorkspace();
    expect(closeAnswer(store.getState())).toEqual({ dirty: false });
    await registry.dispatch('openFile', openFileInput(), user);
    expect(closeAnswer(store.getState())).toEqual({ dirty: false });
    await registry.dispatch('addChart', { columns: ['category'] }, user);
    expect(closeAnswer(store.getState())).toMatchObject({ dirty: true, documentId: null, snapshot: { workspace: { charts: [{ id: 'chart_2' }] } } });
  });
});
