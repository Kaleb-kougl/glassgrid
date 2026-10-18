/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, AUTOSAVE_DELAY_MS } from './App';
import type { WorkspaceState } from '@glassgrid/core';
import type { WorkspaceFileContext, WorkspaceFileOutcome, WorkspaceFilesApi } from './platform';
import { fakeEngine, handle, tableId } from './test-support/fake-engine';
import { fakePlatform, type FakePlatformOptions } from './test-support/fake-platform';
import { stubLayout } from './test-support/jsdom';
import { createAppWorkspace } from './workspace';

/*
 * The app as each shell runs it: everything platform-specific comes from a
 * fake Platform (here mostly a browser-like one), the data from a fake
 * engine.
 */

const picked = { status: 'opened' as const, file: { handle, displayName: 'trips.csv', sizeBytes: 2048 } };

function renderApp(options: FakePlatformOptions = {}) {
  let id = 0;
  const workspace = createAppWorkspace({ clock: () => 1_000, newId: (prefix) => `${prefix}_${++id}` });
  const fake = fakePlatform(fakeEngine(), { name: 'web', picked, ...options });
  render(<App platform={fake.platform} workspace={workspace} />);
  return { ...fake, workspace };
}

const gridCells = () => within(screen.getByRole('grid')).queryAllByRole('gridcell').map((cell) => cell.textContent);

async function openFromEmptyState() {
  fireEvent.click(screen.getByTestId('open-csv-empty'));
  await screen.findByTestId('grid');
  await waitFor(() => expect(screen.getByTestId('row-count').textContent).toBe('2 rows'));
}

function fakeWorkspaceFiles() {
  return {
    save: vi.fn(
      (_context: WorkspaceFileContext, _options: { saveAs: boolean }): Promise<WorkspaceFileOutcome> =>
        Promise.resolve({ status: 'done', displayName: 'trips.glassgrid' }),
    ),
    open: vi.fn((_context: WorkspaceFileContext): Promise<WorkspaceFileOutcome> => Promise.resolve({ status: 'done', displayName: 'other.glassgrid' })),
    autosave: vi.fn((_state: WorkspaceState) => undefined),
  } satisfies WorkspaceFilesApi;
}

beforeEach(() => {
  stubLayout();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('App on a Platform', () => {
  it('opens through the platform, shows the grid, charts a column and undoes back to the empty state', async () => {
    const { engine, files, workspace } = renderApp();
    const app = screen.getByTestId('app');
    expect(app.dataset['platform']).toBe('web');
    expect(app.hasAttribute('data-titlebar-inset')).toBe(false);
    expect(screen.getByText('The file is read on this computer and never uploaded.')).toBeDefined();
    expect(screen.getByTestId('open-csv-empty').textContent).toBe('Open CSV…');
    // Shortcuts as a PC writes them.
    expect(screen.getByText('Ctrl+O')).toBeDefined();

    // open → grid
    await openFromEmptyState();
    expect(files.pickCsv).toHaveBeenCalledOnce();
    expect(engine.open).toHaveBeenCalledWith(handle);
    await waitFor(() => expect(gridCells()).toEqual(['1', 'alpha', '1.5', '2', 'null (empty value)', '2']));
    expect(screen.getByTestId('file-name').textContent).toBe('trips.csv');

    // → chart
    const row = screen.getByTestId('column-category');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    const bars = await screen.findByRole('listbox', { name: /Rows by category/ });
    await waitFor(() => expect(within(bars).getAllByRole('option')).toHaveLength(2));
    expect(engine.aggregate).toHaveBeenCalledWith(tableId, expect.objectContaining({ mark: 'bar', x: { column: 'category' } }), { viewId: 'chart:chart_2' });

    // → undo: the chart goes, then the file
    fireEvent.click(screen.getByTestId('undo'));
    await waitFor(() => expect(screen.queryByRole('listbox', { name: /Rows by category/ })).toBeNull());
    expect(workspace.store.getState().charts).toEqual([]);
    expect(screen.getByTestId('charts-drop')).toBeDefined();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(await screen.findByTestId('empty-state')).toBeDefined();
    await waitFor(() => expect(engine.closeTable).toHaveBeenCalledWith(tableId));
    // Redo brings the file back without re-running the engine's open.
    fireEvent.click(screen.getByTestId('redo'));
    await screen.findByTestId('grid');
    expect(engine.open).toHaveBeenCalledTimes(1);
  });

  it('writes shortcuts the Mac way and leaves room for traffic lights when the platform says so', () => {
    const fake = fakePlatform(fakeEngine(), { name: 'mac' });
    const platform = { ...fake.platform, window: { ...fake.shell, shortcuts: 'mac' as const, titleBarInset: true } };
    render(<App platform={platform} />);
    expect(screen.getByTestId('app').hasAttribute('data-titlebar-inset')).toBe(true);
    expect(screen.getByTestId('topbar').querySelector('.topbar__inset')).not.toBeNull();
    expect(screen.getByText('⌘O')).toBeDefined();
  });

  it('works without native menus or theme sync (browsers) and makes its own workspace', async () => {
    const fake = fakePlatform(fakeEngine(), { name: 'web', picked });
    const { syncTheme: _sync, onMenuCommand: _menu, ...browserWindow } = fake.shell;
    render(<App platform={{ ...fake.platform, window: browserWindow }} />);
    expect(document.documentElement.dataset['ggTheme']).toBe('light');
    await openFromEmptyState();
    expect(screen.getByTestId<HTMLButtonElement>('undo').disabled).toBe(false);
  });

  it('offers the platform’s sample datasets on the empty state', async () => {
    const { files } = renderApp({ samples: [{ id: 'taxi', label: 'NYC taxi trips', detail: '200 rows' }] });
    const samples = screen.getByRole('list', { name: 'Or try a sample' });
    const button = within(samples).getByTestId('sample-taxi');
    expect(button.textContent).toBe('NYC taxi trips200 rows');
    fireEvent.click(button);
    await screen.findByTestId('grid');
    expect(files.openSample).toHaveBeenCalledWith('taxi');
    expect(files.pickCsv).not.toHaveBeenCalled();
  });

  it('shows no sample list without samples', () => {
    renderApp();
    expect(screen.queryByText('Or try a sample')).toBeNull();
  });

  it('refuses files over the platform’s size limit before the engine opens them', async () => {
    const { engine } = renderApp({ capabilities: { maxFileBytes: 1024 } });
    fireEvent.click(screen.getByTestId('open-csv-empty'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('trips.csv is 2.00 KB; files up to 1.00 KB open here');
    expect(engine.open).not.toHaveBeenCalled();
    expect(screen.getByTestId('empty-state')).toBeDefined();
  });

  it('closes the open table when the platform says the window is going away', async () => {
    const { engine, close } = renderApp();
    await openFromEmptyState();
    act(() => close());
    expect(engine.closeTable).toHaveBeenCalledWith(tableId);
  });
});

describe('workspace files (persistence hooks)', () => {
  it('hides save, open and the edited dot without workspace files, or without the capability', async () => {
    renderApp();
    await openFromEmptyState();
    expect(screen.queryByTestId('save-workspace')).toBeNull();
    expect(screen.queryByTestId('open-workspace')).toBeNull();
    expect(screen.queryByTestId('workspace-edited')).toBeNull();
    cleanup();

    const api = fakeWorkspaceFiles();
    renderApp({ workspaceFiles: api, capabilities: { canSaveWorkspace: false } });
    await openFromEmptyState();
    expect(screen.queryByTestId('save-workspace')).toBeNull();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(api.save).not.toHaveBeenCalled();
  });

  it('saves by button and Ctrl+S, tracks unsaved changes and opens saved workspaces', async () => {
    const api = fakeWorkspaceFiles();
    const { workspace, engine } = renderApp({ workspaceFiles: api, capabilities: { canSaveWorkspace: true } });
    expect(screen.getByTestId<HTMLButtonElement>('save-workspace').disabled).toBe(true);
    expect(screen.queryByTestId('workspace-edited')).toBeNull();
    await openFromEmptyState();
    expect(screen.getByTestId('workspace-edited').textContent).toBe('Edited, not saved');

    fireEvent.click(screen.getByTestId('save-workspace'));
    await waitFor(() => expect(screen.queryByTestId('workspace-edited')).toBeNull());
    expect(api.save).toHaveBeenCalledWith({ workspace, engine }, { saveAs: false });
    expect(screen.getByText('Saved trips.glassgrid')).toBeDefined();

    await act(() => workspace.registry.dispatch('setColumnType', { column: 'amount', type: 'text' }, { caller: 'user' }));
    expect(screen.getByTestId('workspace-edited')).toBeDefined();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(api.save).toHaveBeenLastCalledWith({ workspace, engine }, { saveAs: true }));
    await waitFor(() => expect(screen.queryByTestId('workspace-edited')).toBeNull());
    // Undo past the save point is an unsaved change again.
    fireEvent.click(screen.getByTestId('undo'));
    expect(screen.getByTestId('workspace-edited')).toBeDefined();

    fireEvent.click(screen.getByTestId('open-workspace'));
    await waitFor(() => expect(api.open).toHaveBeenCalledWith({ workspace, engine }));
    expect(await screen.findByText('Opened other.glassgrid')).toBeDefined();
  });

  it('reports a failed save and keeps the edited dot', async () => {
    const api = fakeWorkspaceFiles();
    api.save.mockResolvedValueOnce({ status: 'failed', message: 'Could not save: disk full' });
    renderApp({ workspaceFiles: api, capabilities: { canSaveWorkspace: true } });
    await openFromEmptyState();
    fireEvent.click(screen.getByTestId('save-workspace'));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save: disk full');
    expect(screen.getByTestId('workspace-edited')).toBeDefined();
  });

  it('autosaves after a quiet moment and offers recovery at start', async () => {
    const offer = { id: 'autosave-1', displayName: 'trips.csv', savedAt: Date.UTC(2026, 9, 18, 12) };
    const restore = vi.fn(() => Promise.resolve({ status: 'done' as const, displayName: 'trips.csv' }));
    const api = { ...fakeWorkspaceFiles(), recovery: { check: vi.fn(() => Promise.resolve(offer)), restore } };
    const { workspace, engine } = renderApp({ workspaceFiles: api, capabilities: { canSaveWorkspace: true } });

    const toast = await screen.findByText(/Unsaved changes to trips\.csv from .* can be restored/);
    fireEvent.click(within(toast.closest('[role="status"]') as HTMLElement).getByRole('button', { name: /Restore/ }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(offer, { workspace, engine }));

    await openFromEmptyState();
    vi.useFakeTimers();
    await act(() => workspace.registry.dispatch('setColumnType', { column: 'amount', type: 'text' }, { caller: 'user' }));
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
    });
    const before = api.autosave.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(api.autosave.mock.calls.length).toBe(before + 1);
    expect(api.autosave).toHaveBeenLastCalledWith(workspace.store.getState());
  });
});
