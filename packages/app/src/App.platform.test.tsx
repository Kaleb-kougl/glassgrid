/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
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
