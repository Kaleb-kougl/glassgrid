/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isWorkspaceDirty, tableIdForFile, type CloseAnswer } from '@glassgrid/core';
import { App } from './App';
import { fakeEngine, handle } from './test-support/fake-engine';
import { fakePlatform, type FakePlatformOptions } from './test-support/fake-platform';
import { DOC_ID, fakeWorkspaceFiles, openedResult, recentEntry, recoveryEntry, workspaceHandle } from './test-support/fake-workspace-files';
import { stubLayout } from './test-support/jsdom';
import { createAppWorkspace } from './workspace';
import { describeMismatch, documentTitle, isWorkspaceFileName } from './workspace-files';

/*
 * `.glassgrid` workspace files in the app: core's commands and dirty model
 * over a fake WorkspaceFilesApi (the shape of the desktop's preload bridge).
 */

const picked = { status: 'opened' as const, file: { handle, displayName: 'trips.csv', sizeBytes: 2048 } };
const savedTable = tableIdForFile(workspaceHandle);

function renderApp(options: FakePlatformOptions & { files?: ReturnType<typeof fakeWorkspaceFiles> } = {}) {
  let id = 0;
  const workspace = createAppWorkspace({ clock: () => 1_000, newId: (prefix) => `${prefix}_${++id}` });
  const files = options.files ?? fakeWorkspaceFiles();
  const fake = fakePlatform(fakeEngine(), { name: 'linux', picked, workspaceFiles: files.api, ...options, capabilities: { canSaveWorkspace: true, ...options.capabilities } });
  render(<App platform={fake.platform} workspace={workspace} />);
  return { ...fake, workspace, api: files.api, openRequest: files.openRequest };
}

async function openCsv() {
  fireEvent.click(screen.getByTestId('open-csv-empty'));
  await screen.findByTestId('grid');
  await waitFor(() => expect(screen.getByTestId('row-count').textContent).toBe('2 rows'));
}

const dot = () => screen.queryByTestId('workspace-edited');

beforeEach(() => {
  stubLayout();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('workspace files: saving and the edited dot', () => {
  it('stays hidden without the API or without the capability', async () => {
    const { api } = renderApp({ capabilities: { canSaveWorkspace: false } });
    await openCsv();
    expect(screen.queryByTestId('save-workspace')).toBeNull();
    expect(screen.queryByTestId('open-workspace-empty')).toBeNull();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(api.save).not.toHaveBeenCalled();
    expect(api.listRecent).not.toHaveBeenCalled();
    expect(api.updateRecovery).not.toHaveBeenCalled();
  });

  it('shows unsaved changes by digest: clean after opening, dirty after an edit, clean again after undoing it', async () => {
    const { workspace } = renderApp();
    await openCsv();
    expect(dot()).toBeNull();
    // Profiles and the grid selection are not changes to the work.
    await act(() => workspace.registry.dispatch('setSelection', { selection: { anchor: { row: 0, column: 'id' }, focus: { row: 0, column: 'id' } } }, { caller: 'user' }));
    expect(dot()).toBeNull();

    await act(() => workspace.registry.dispatch('setColumnType', { column: 'amount', type: 'text' }, { caller: 'user' }));
    expect(dot()?.textContent).toBe('Edited, not saved');
    fireEvent.click(screen.getByTestId('undo'));
    await waitFor(() => expect(dot()).toBeNull());
    fireEvent.click(screen.getByTestId('redo'));
    await waitFor(() => expect(dot()).not.toBeNull());
  });

  it('saves through the saveWorkspace command, names the workspace and is clean until the next change', async () => {
    const { workspace, api, shell } = renderApp();
    expect(screen.getByTestId<HTMLButtonElement>('save-workspace').disabled).toBe(true);
    await openCsv();
    expect(shell.setDocumentChrome).toHaveBeenLastCalledWith({ title: 'trips.csv', edited: false, documentId: null });
    await act(() => workspace.registry.dispatch('addChart', { columns: ['category'] }, { caller: 'user' }));
    await waitFor(() => expect(shell.setDocumentChrome).toHaveBeenLastCalledWith({ title: 'trips.csv', edited: true, documentId: null }));

    fireEvent.click(screen.getByTestId('save-workspace'));
    expect(await screen.findByText('Saved trips.glassgrid')).toBeDefined();
    expect(api.save.mock.calls[0]?.[0]).toMatchObject({ documentId: null, snapshot: { workspace: { charts: [{ id: 'chart_2' }] } } });
    expect(dot()).toBeNull();
    expect(screen.getByTestId('workspace-name').textContent).toBe('trips.glassgrid');
    expect(screen.getByTestId('file-name').textContent).toBe('trips.csv');
    expect(workspace.store.getState().document).toMatchObject({ id: DOC_ID, fileName: 'trips.glassgrid' });
    expect(shell.setDocumentChrome).toHaveBeenLastCalledWith({ title: 'trips.glassgrid', edited: false, documentId: DOC_ID });

    // Undo past the save point is unsaved work again; Save As writes a new file.
    fireEvent.click(screen.getByTestId('undo'));
    await waitFor(() => expect(dot()).not.toBeNull());
    fireEvent.click(screen.getByTestId('save-workspace-as'));
    expect(await screen.findByText('Saved copy.glassgrid')).toBeDefined();
    expect(api.saveAs).toHaveBeenCalledWith(expect.objectContaining({ documentId: DOC_ID }));
    expect(dot()).toBeNull();
  });

  it('reports a failed save and keeps the dot; a cancelled one says nothing', async () => {
    const { workspace, api } = renderApp();
    api.save.mockResolvedValueOnce({ status: 'failed', message: 'Could not save trips.glassgrid: disk full' }).mockResolvedValueOnce({ status: 'cancelled' });
    await openCsv();
    await act(() => workspace.registry.dispatch('sortGrid', { sort: [{ column: 'id', direction: 'asc' }] }, { caller: 'user' }));
    fireEvent.click(screen.getByTestId('save-workspace'));
    expect((await screen.findByRole('alert')).textContent).toContain('disk full');
    expect(dot()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(screen.getByTestId('save-workspace'));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(dot()).not.toBeNull();
  });

  it('feeds the host autosaver with unsaved work (null once clean) and answers the close prompt', async () => {
    const { workspace, api, requestClose } = renderApp();
    await openCsv();
    expect(await requestClose()).toEqual({ dirty: false });
    await act(() => workspace.registry.dispatch('addChart', { columns: ['category'] }, { caller: 'user' }));
    expect(api.updateRecovery.mock.calls.at(-1)?.[0]).toMatchObject({ documentId: null, snapshot: { dataSource: { handleId: handle } } });
    const answer = (await requestClose()) as Extract<CloseAnswer, { dirty: true }>;
    expect(answer).toMatchObject({ dirty: true, documentId: null });
    expect(answer.snapshot.workspace.charts).toHaveLength(1);

    await act(() => workspace.registry.dispatch('undo', {}, { caller: 'user' }));
    expect(api.updateRecovery).toHaveBeenLastCalledWith(null);
    expect(await requestClose()).toEqual({ dirty: false });
  });
});

describe('workspace files: shortcuts and menus', () => {
  it('without a native menu the page owns Ctrl+O, Ctrl+Shift+O, Ctrl+S and Ctrl+Shift+S', async () => {
    const { api, files, workspace } = renderApp();
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    await openCsv();
    expect(files.pickCsv).toHaveBeenCalledOnce();
    await act(() => workspace.registry.dispatch('addChart', { columns: ['category'] }, { caller: 'user' }));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
    fireEvent.keyDown(window, { key: 'S', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledOnce());
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(api.open).toHaveBeenCalledWith({ source: 'dialog' }));
  });

  it('with a native menu the keys are left to it, and its items run the workspace commands', async () => {
    const { api, files, menu, workspace } = renderApp({ menuShortcuts: true });
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    expect(files.pickCsv).not.toHaveBeenCalled();
    act(() => menu({ kind: 'open' }));
    await screen.findByTestId('grid');
    await act(() => workspace.registry.dispatch('addChart', { columns: ['category'] }, { caller: 'user' }));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(api.save).not.toHaveBeenCalled();

    act(() => menu({ kind: 'saveWorkspace' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
    act(() => menu({ kind: 'saveWorkspaceAs' }));
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledOnce());
    act(() => menu({ kind: 'openWorkspace' }));
    await waitFor(() => expect(api.open).toHaveBeenCalledWith({ source: 'dialog' }));
    act(() => menu({ kind: 'openRecentWorkspace', id: recentEntry.id }));
    await waitFor(() => expect(api.open).toHaveBeenCalledWith({ source: 'recent', id: recentEntry.id }));
    // Undo is still the page's.
    const before = workspace.store.getHistory().past.length;
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(workspace.store.getHistory().past.length).toBe(before - 1));
  });
});

describe('workspace files: opening', () => {
  it('opens a saved workspace, restores it over the data and re-sends its column types to the engine', async () => {
    const { api, engine, workspace } = renderApp();
    fireEvent.click(screen.getByTestId('open-workspace-empty'));
    expect(await screen.findByText('Opened trips.glassgrid')).toBeDefined();
    expect(api.open).toHaveBeenCalledWith({ source: 'dialog' });
    expect(engine.open).toHaveBeenCalledWith(workspaceHandle);
    expect(await screen.findByRole('listbox', { name: /Trips by category/ })).toBeDefined();
    expect(screen.getByTestId('workspace-name').textContent).toBe('trips.glassgrid');
    expect(dot()).toBeNull();
    // The engine opened the file with inferred types: the saved override goes to it, then the profile.
    await waitFor(() => expect(engine.setColumnTypes).toHaveBeenCalledWith(savedTable, [{ column: 'amount', type: 'text' }]));
    await waitFor(() => expect(engine.profile).toHaveBeenCalledWith(savedTable, expect.anything()));
    expect(workspace.store.getHistory().past.at(-1)).toMatchObject({ name: 'loadWorkspace' });
    expect(isWorkspaceDirty(workspace.store.getState())).toBe(false);
  });

  it('shows what restoring changed', async () => {
    const { api } = renderApp();
    api.open.mockResolvedValueOnce(openedResult({ warnings: [{ code: 'migrated', message: 'Upgraded from format 0' }, { code: 'chart_dropped', message: 'Dropped the chart “Old”: it used column gone' }] }));
    fireEvent.click(screen.getByTestId('open-workspace-empty'));
    expect(await screen.findByText('Opened trips.glassgrid. Dropped the chart “Old”: it used column gone (1 more change)')).toBeDefined();
  });

  it('reports a file that cannot be opened', async () => {
    const { api } = renderApp();
    api.open.mockResolvedValueOnce({ status: 'failed', code: 'newer_version', message: 'This workspace was saved by a newer version of Glassgrid' });
    fireEvent.click(screen.getByTestId('open-workspace-empty'));
    expect((await screen.findByRole('alert')).textContent).toContain('newer version');
    expect(screen.getByTestId('empty-state')).toBeDefined();
  });

  it('asks where a missing data file is: Cancel forgets the open, Locate… finishes it', async () => {
    const { api, workspace } = renderApp();
    const needsData = { status: 'needsData' as const, token: 'ot_pending-1', workspaceFile: { fileName: 'trips.glassgrid', directory: '/work' }, dataFileName: 'trips.csv', warnings: [] };
    api.open.mockResolvedValue(needsData);
    fireEvent.click(screen.getByTestId('open-workspace-empty'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Where is trips.csv?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByText(/no longer where it was saved/)).toBeDefined();
    const locate = within(dialog).getByRole('button', { name: 'Locate trips.csv…' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(locate);
    // Focus stays inside; the rest of the window is out of reach.
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(locate);
    expect(screen.getByRole('main', { hidden: true }).hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('topbar').hasAttribute('inert')).toBe(true);
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });
    expect(api.open).toHaveBeenCalledOnce();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.cancelOpen).toHaveBeenCalledWith('ot_pending-1');
    expect(screen.getByTestId('topbar').hasAttribute('inert')).toBe(false);

    // Again: the picker is cancelled (the prompt stays), then fails, then finds the file.
    fireEvent.click(screen.getByTestId('open-workspace-empty'));
    await screen.findByRole('alertdialog');
    api.locateData
      .mockResolvedValueOnce({ status: 'cancelled' })
      .mockResolvedValueOnce({ status: 'failed', code: 'data_unreadable', message: 'Could not open trips.csv: permission denied' });
    fireEvent.click(screen.getByTestId('locate-data-pick'));
    await waitFor(() => expect(api.locateData).toHaveBeenCalledWith('ot_pending-1'));
    expect(screen.getByRole('alertdialog')).toBeDefined();
    fireEvent.click(screen.getByTestId('locate-data-pick'));
    expect((await within(screen.getByRole('alertdialog')).findByRole('alert')).textContent).toContain('permission denied');
    fireEvent.click(screen.getByTestId('locate-data-pick'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByRole('listbox', { name: /Trips by category/ })).toBeDefined();
    expect(workspace.store.getState().dataSource?.handleId).toBe(workspaceHandle);
    expect(api.cancelOpen).toHaveBeenCalledOnce();
  });

  it('warns without blocking when the data changed: Continue keeps it, Locate another file… relinks it', async () => {
    const { api } = renderApp();
    const mismatch = { sizeBytes: { expected: 2048, actual: 4096 }, mtimeMs: null, contentChanged: true };
    api.open.mockResolvedValue(openedResult({ fingerprintMismatch: mismatch, relinkToken: 'ot_relink-1' }));
    fireEvent.click(screen.getByTestId('open-workspace-empty'));
    const banner = await screen.findByTestId('data-mismatch');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('trips.csv has changed since this workspace was saved (2.00 KB → 4.00 KB, contents differ)');
    // Non-blocking: the workspace is open and usable.
    expect(await screen.findByRole('listbox', { name: /Trips by category/ })).toBeDefined();
    expect(screen.getByTestId('topbar').hasAttribute('inert')).toBe(false);

    fireEvent.click(within(banner).getByRole('button', { name: 'Continue' }));
    expect(screen.queryByTestId('data-mismatch')).toBeNull();
    expect(api.cancelOpen).toHaveBeenCalledWith('ot_relink-1');

    api.open.mockResolvedValueOnce(openedResult({ fingerprintMismatch: mismatch, relinkToken: 'ot_relink-2' }));
    fireEvent.click(screen.getByTestId('open-workspace'));
    fireEvent.click(await screen.findByTestId('data-mismatch-locate'));
    await waitFor(() => expect(api.locateData).toHaveBeenCalledWith('ot_relink-2'));
    await waitFor(() => expect(screen.queryByTestId('data-mismatch')).toBeNull());
  });

  it('opens files the OS hands over and .glassgrid files dropped on the window', async () => {
    const { api, openRequest, files } = renderApp();
    act(() => openRequest({ token: 'ot_external-1', fileName: 'trips.glassgrid' }));
    await waitFor(() => expect(api.open).toHaveBeenCalledWith({ source: 'external', token: 'ot_external-1' }));
    await screen.findByTestId('workspace-name');

    const workspaceFile = new File(['{}'], 'Q3 Review.GLASSGRID');
    fireEvent.drop(screen.getByTestId('app'), { dataTransfer: { types: ['Files'], files: [workspaceFile] } });
    await waitFor(() => expect(api.openDropped).toHaveBeenCalledWith(workspaceFile));
    expect(files.openDropped).not.toHaveBeenCalled();
    const csv = new File(['a\n1\n'], 'more.csv');
    fireEvent.drop(screen.getByTestId('app'), { dataTransfer: { types: ['Files'], files: [csv] } });
    await waitFor(() => expect(files.openDropped).toHaveBeenCalledWith(csv));
  });
});

describe('workspace files: asking before replacing unsaved work', () => {
  async function dirtyWorkspace() {
    const app = renderApp();
    await openCsv();
    await act(() => app.workspace.registry.dispatch('addChart', { columns: ['category'] }, { caller: 'user' }));
    await waitFor(() => expect(dot()).not.toBeNull());
    return app;
  }

  it('does not ask when nothing is unsaved', async () => {
    const { api, files } = renderApp();
    await openCsv();
    fireEvent.click(screen.getByTestId('open-workspace'));
    await waitFor(() => expect(api.open).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('save-before-replace')).toBeNull();
    fireEvent.click(screen.getByTestId('open-csv'));
    await waitFor(() => expect(files.pickCsv).toHaveBeenCalledTimes(2));
  });

  it('Cancel (or Escape) keeps the unsaved work and opens nothing', async () => {
    const { api, files, workspace } = await dirtyWorkspace();
    fireEvent.click(screen.getByTestId('open-workspace'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Save this workspace?' });
    expect(within(dialog).getByText(/has unsaved changes/).textContent).toContain('this workspace on trips.csv');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Save as…' }));
    expect(screen.getByTestId('topbar').hasAttribute('inert')).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.open).not.toHaveBeenCalled();
    expect(workspace.store.getState().charts).toHaveLength(1);

    // A CSV from the native menu asks the same; Escape is Cancel.
    fireEvent.click(screen.getByTestId('open-csv'));
    fireEvent.keyDown(await screen.findByRole('alertdialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(files.pickCsv).toHaveBeenCalledOnce();
    expect(dot()).not.toBeNull();
  });

  it('Don’t save goes ahead without saving', async () => {
    const { api, files } = await dirtyWorkspace();
    fireEvent.click(screen.getByTestId('open-csv'));
    fireEvent.click(await screen.findByTestId('save-before-replace-discard'));
    await waitFor(() => expect(files.pickCsv).toHaveBeenCalledTimes(2));
    expect(api.save).not.toHaveBeenCalled();
  });

  it('Save writes the workspace before the open; a failed or cancelled save stops it', async () => {
    const { api, workspace } = await dirtyWorkspace();
    api.save.mockResolvedValueOnce({ status: 'failed', message: 'Could not save trips.glassgrid: disk full' });
    fireEvent.click(screen.getByTestId('open-workspace'));
    fireEvent.click(await screen.findByTestId('save-before-replace-save'));
    expect((await screen.findByRole('alert')).textContent).toContain('disk full');
    expect(api.open).not.toHaveBeenCalled();
    expect(dot()).not.toBeNull();

    fireEvent.click(screen.getByTestId('open-workspace'));
    fireEvent.click(await screen.findByTestId('save-before-replace-save'));
    expect(await screen.findByText('Opened trips.glassgrid')).toBeDefined();
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(api.save.mock.calls[1]?.[0]).toMatchObject({ documentId: null, snapshot: { workspace: { charts: [{ id: 'chart_2' }] } } });
    expect(api.save.mock.invocationCallOrder[1]).toBeLessThan(api.open.mock.invocationCallOrder[0] ?? 0);
    // Undo brings the replaced workspace back.
    fireEvent.click(screen.getByTestId('undo'));
    await waitFor(() => expect(workspace.store.getState().charts.map((chart) => chart.id)).toEqual(['chart_2']));
  });

  it('asks before an OS hand-off or a dropped workspace replaces unsaved work', async () => {
    const { api, openRequest } = await dirtyWorkspace();
    act(() => openRequest({ token: 'ot_external-2', fileName: 'other.glassgrid' }));
    fireEvent.click(await screen.findByTestId('save-before-replace-cancel'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.open).not.toHaveBeenCalled();

    const workspaceFile = new File(['{}'], 'other.glassgrid');
    fireEvent.drop(screen.getByTestId('app'), { dataTransfer: { types: ['Files'], files: [workspaceFile] } });
    fireEvent.click(await screen.findByTestId('save-before-replace-discard'));
    await waitFor(() => expect(api.openDropped).toHaveBeenCalledWith(workspaceFile));
  });
});

describe('workspace files: the start screen', () => {
  it('lists recent workspaces and opens one through openWorkspace', async () => {
    const { api } = renderApp({ files: fakeWorkspaceFiles({ recent: [recentEntry] }) });
    const list = await screen.findByRole('region', { name: 'Recent workspaces' });
    const entry = within(list).getByRole('button', { name: /q3\.glassgrid/ });
    expect(entry.textContent).toBe('q3.glassgrid/work/reports');
    fireEvent.click(entry);
    await waitFor(() => expect(api.open).toHaveBeenCalledWith({ source: 'recent', id: recentEntry.id }));
    await screen.findByTestId('workspace-name');
  });

  it('offers unsaved work from an earlier session: Restore opens it with its changes unsaved, Discard deletes it', async () => {
    const other = { ...recoveryEntry, id: 'rs_recover-5678', workspaceFile: null, dataFileName: 'sales.csv' };
    const { api, workspace } = renderApp({ files: fakeWorkspaceFiles({ recovery: [recoveryEntry, other] }) });
    const offer = await screen.findByRole('status', { name: 'Unsaved changes from 2 earlier sessions' });
    expect(within(offer).getAllByTestId('recovery-entry').map((row) => row.textContent)).toEqual([
      expect.stringContaining('trips.glassgridtrips.csv · autosaved Oct 18, 2026'),
      expect.stringContaining('Untitled (sales.csv)autosaved'),
    ]);
    api.listRecovery.mockResolvedValue([recoveryEntry]);
    fireEvent.click(within(offer).getByRole('button', { name: 'Discard unsaved changes to Untitled (sales.csv)' }));
    await waitFor(() => expect(api.discardRecovery).toHaveBeenCalledWith('rs_recover-5678'));
    await waitFor(() => expect(screen.getAllByTestId('recovery-entry')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Restore unsaved changes to trips.glassgrid' }));
    expect(await screen.findByText('Restored unsaved changes to trips.glassgrid')).toBeDefined();
    expect(api.restoreRecovery).toHaveBeenCalledWith(recoveryEntry.id);
    // Recovered work is unsaved: the dot shows and Save goes back to the original file.
    expect(dot()).not.toBeNull();
    expect(workspace.store.getState().document).toMatchObject({ id: DOC_ID, fileName: 'trips.glassgrid', savedDigest: null });
  });
});

describe('workspace-file helpers', () => {
  it('names files and mismatches for people', () => {
    expect(isWorkspaceFileName('a.glassgrid')).toBe(true);
    expect(isWorkspaceFileName('A.GlassGrid')).toBe(true);
    expect(isWorkspaceFileName('a.glassgrid.csv')).toBe(false);
    expect(documentTitle({ dataSource: null })).toBeNull();
    expect(describeMismatch('sales.csv', { sizeBytes: null, mtimeMs: { expected: 1, actual: Date.UTC(2026, 0, 2, 12) }, contentChanged: false })).toMatch(
      /^sales\.csv has changed since this workspace was saved \(modified Jan 2, 2026, .+\)\. Charts and counts may differ/,
    );
    expect(describeMismatch('sales.csv', { sizeBytes: null, mtimeMs: null, contentChanged: true })).toContain('(contents differ)');
  });
});
