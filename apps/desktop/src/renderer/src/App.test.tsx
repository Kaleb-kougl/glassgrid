/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { tableFromArrays } from 'apache-arrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tableIdForFile, toFileHandle, type MenuCommand, type TableHandle } from '@glassgrid/core';
import { App, type AppProps } from './App';
import { EngineRequestError } from './engine-client';
import { THEME_STORAGE_KEY } from './theme';
import { createAppWorkspace } from './workspace';

const handle = toFileHandle('0b6c8f0e-6d0a-4f43-9d3e-2f1f1a0d9c11');
const tableId = tableIdForFile(handle);
const table: TableHandle = {
  id: tableId,
  file: handle,
  fileName: 'trips.csv',
  fingerprint: { sizeBytes: 2048, mtimeMs: 1, headTailSha256: 'a'.repeat(64), key: 'b'.repeat(32) },
  usingParquetCache: false,
  columns: [
    { name: 'id', type: 'integer', duckdbType: 'BIGINT' },
    { name: 'category', type: 'text', duckdbType: 'VARCHAR' },
    { name: 'amount', type: 'float', duckdbType: 'DOUBLE' },
  ],
};

function fakeEngine() {
  const timing = { engineMs: 1, cached: false };
  return {
    open: vi.fn(() => Promise.resolve({ table, engineMs: 3 })),
    rows: vi.fn(() =>
      Promise.resolve({
        table: tableFromArrays({ id: Int32Array.from([1, 2]), category: ['alpha', null], amount: Float64Array.from([1.5, 2]) }),
        ...timing,
      }),
    ),
    profile: vi.fn(() =>
      Promise.resolve({
        rowCount: 2,
        columns: table.columns.map((c, i) => ({ ...c, nullFraction: 0, distinctCount: [2, 12_345, 8_410_000][i] ?? 0, min: null, max: null })),
        ...timing,
      }),
    ),
    count: vi.fn((_table: string, options: { filters?: readonly unknown[] } = {}) =>
      Promise.resolve({ rowCount: options.filters?.length ? 1 : 2, ...timing }),
    ),
    aggregate: vi.fn(() =>
      Promise.resolve({
        table: tableFromArrays({ x: ['alpha', 'bravo'], y: Float64Array.from([7, 5]) }),
        mark: 'bar' as const,
        fellBackToHeatmap: false,
        ...timing,
      }),
    ),
    onEvent: vi.fn(() => () => undefined),
  } satisfies AppProps['engine'];
}

function renderApp() {
  let id = 0;
  const workspace = createAppWorkspace({ clock: () => 1_000, newId: (prefix) => `${prefix}_${++id}` });
  const engine = fakeEngine();
  const menuListeners = new Set<(command: MenuCommand) => void>();
  const bridge = {
    platform: 'linux',
    openCsv: vi.fn(() => Promise.resolve({ status: 'opened' as const, file: { handle, displayName: 'trips.csv', sizeBytes: 2048 } })),
    openDroppedFile: vi.fn(() => Promise.resolve({ status: 'failed' as const, message: 'notes.txt is not a file on this computer' })),
    setTheme: vi.fn(),
    onMenuCommand: (listener: (command: MenuCommand) => void) => {
      menuListeners.add(listener);
      return () => menuListeners.delete(listener);
    },
  } satisfies AppProps['bridge'];
  render(<App engine={engine} bridge={bridge} workspace={workspace} />);
  const menu = (command: MenuCommand) => {
    act(() => {
      menuListeners.forEach((listener) => listener(command));
    });
  };
  return { engine, workspace, bridge, menu };
}

async function openFile() {
  const app = renderApp();
  fireEvent.click(screen.getByTestId('open-csv'));
  await screen.findByTestId('grid');
  await waitFor(() => expect(screen.getByTestId('row-count').textContent).toBe('2 rows'));
  return app;
}

const typeBadge = (column: string) => screen.getByTestId(`column-${column}-type`);

async function setType(column: string, label: string) {
  fireEvent.click(typeBadge(column));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: new RegExp(label) }));
}

function historyEntries() {
  fireEvent.click(screen.getByTestId('history-button'));
  const entries = screen.queryAllByTestId('history-entry').map((li) => li.textContent);
  fireEvent.click(screen.getByTestId('history-button'));
  return entries;
}

beforeEach(() => {
  window.matchMedia = vi.fn((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  window.localStorage.clear();
});

afterEach(cleanup);

describe('App', () => {
  it('starts on the empty state: the window is the drop zone', () => {
    renderApp();
    expect(screen.getByText('Drop a CSV file here')).toBeDefined();
    expect(screen.getByTestId('agent-indicator').textContent).toBe('Agent · not connected');
    expect(screen.getByTestId<HTMLButtonElement>('undo').disabled).toBe(true);
  });

  it('opens a file: first rows, profile distinct counts and the row count', async () => {
    const { engine } = await openFile();
    expect(screen.getByTestId('file-name').textContent).toBe('trips.csv');
    expect(engine.rows).toHaveBeenCalledWith(tableId, { offset: 0, limit: 1000, sort: [] }, { viewId: 'grid', filters: [] });
    const cells = within(screen.getByTestId('grid')).getAllByRole('gridcell').map((cell) => cell.textContent);
    expect(cells).toEqual(['1', 'alpha', '1.5', '2', 'null', '2']);
    await waitFor(() => expect(within(screen.getByTestId('column-category')).getByText('12,345')).toBeDefined());
    expect(within(screen.getByTestId('column-amount')).getByText('8.41M')).toBeDefined();
    expect(historyEntries()).toEqual(['Opened trips.csvby you · ' + new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(1_000)]);
  });

  it('changes a column type through the type menu and undoes it by button and keyboard', async () => {
    await openFile();
    expect(typeBadge('amount').dataset['type']).toBe('float');
    await setType('amount', 'Text');
    expect(typeBadge('amount').dataset['type']).toBe('text');
    expect(typeBadge('amount').className).toContain('gg-type-badge--set');

    fireEvent.click(screen.getByTestId('undo'));
    expect(typeBadge('amount').dataset['type']).toBe('float');
    fireEvent.click(screen.getByTestId('redo'));
    expect(typeBadge('amount').dataset['type']).toBe('text');

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(typeBadge('amount').dataset['type']).toBe('float');
    fireEvent.keyDown(window, { key: 'Z', metaKey: true, shiftKey: true });
    expect(typeBadge('amount').dataset['type']).toBe('text');
  });

  it('labels changes made by an AI caller in History', async () => {
    const { workspace } = await openFile();
    await act(() => workspace.registry.dispatch('setColumnType', { column: 'amount', type: 'decimal' }, { caller: 'ai' }));
    const entries = historyEntries();
    expect(entries[0]).toMatch(/^Set amount to decimalby AI/);
    expect(entries[1]).toMatch(/^Opened trips\.csvby you/);
  });

  it('sorts from the grid header through sortGrid and re-queries the rows', async () => {
    const { engine, workspace } = await openFile();
    fireEvent.click(screen.getByTestId('grid-header-amount'));
    expect(workspace.store.getState().grid.sort).toEqual([{ column: 'amount', direction: 'asc' }]);
    await waitFor(() =>
      expect(engine.rows).toHaveBeenLastCalledWith(
        tableId,
        { offset: 0, limit: 1000, sort: [{ column: 'amount', direction: 'asc' }] },
        { viewId: 'grid', filters: [] },
      ),
    );
    expect(screen.getByTestId('grid-header-amount').getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(screen.getByTestId('grid-header-amount'));
    fireEvent.click(screen.getByTestId('grid-header-amount'));
    expect(workspace.store.getState().grid.sort).toEqual([]);
  });

  it('charts a column, cross-filters the grid from a bar and removes the filter chip with Undo', async () => {
    const { engine, workspace } = await openFile();
    const row = screen.getByTestId('column-category');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    const chartId = workspace.store.getState().charts[0]?.id ?? '';
    expect(chartId).toBe('chart_2');
    expect(engine.aggregate).toHaveBeenCalledWith(tableId, { mark: 'bar', x: { column: 'category' }, filters: [] }, { viewId: 'chart:chart_2' });

    const bars = await screen.findByRole('listbox', { name: /Rows by category/ });
    await waitFor(() => expect(within(bars).getAllByRole('option')).toHaveLength(2));
    fireEvent.keyDown(bars, { key: 'Enter' });
    expect(workspace.store.getState().filters).toEqual({ chart_2: { kind: 'in', column: 'category', values: ['alpha'] } });
    expect(within(bars).getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('1 selected')).toBeDefined();

    const chip = screen.getByTestId('filter-category');
    expect(chip.textContent).toBe('category= alpha×');
    const filters = [{ kind: 'in', column: 'category', values: ['alpha'] }];
    await waitFor(() => expect(engine.count).toHaveBeenLastCalledWith(tableId, { viewId: 'status', filters }));
    expect(engine.rows).toHaveBeenLastCalledWith(tableId, { offset: 0, limit: 1000, sort: [] }, { viewId: 'grid', filters });
    await waitFor(() => expect(screen.getByTestId('row-count').textContent).toBe('1 of 2 rows'));
    // The chart that owns the selection keeps its full distribution.
    expect(engine.aggregate).toHaveBeenCalledTimes(1);

    fireEvent.click(within(chip).getByRole('button', { name: 'Remove filter on category' }));
    expect(workspace.store.getState().filters).toEqual({});
    const toast = screen.getByRole('status', { name: '' });
    expect(toast.textContent).toContain('Removed filter category');
    fireEvent.click(within(toast).getByRole('button', { name: /Undo/ }));
    expect(workspace.store.getState().filters).toEqual({ chart_2: { kind: 'in', column: 'category', values: ['alpha'] } });
  });

  it('shows the engine message on a chart that cannot be computed', async () => {
    const { engine, workspace } = await openFile();
    engine.aggregate.mockImplementationOnce(() =>
      Promise.reject(new EngineRequestError('bad_request', 'y.aggregate "sum" needs a numeric column, but "category" is text. Use "count" instead.', 'y.aggregate')),
    );
    await act(() => workspace.registry.dispatch('addChart', { spec: { mark: 'bar', x: { column: 'id' }, y: { column: 'category', aggregate: 'sum' } } }, { caller: 'ai' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('y.aggregate "sum" needs a numeric column');
    expect(alert.textContent).toContain('y.aggregate');
    expect(screen.getByText('by AI')).toBeDefined();
  });

  it('opens a dropped file through the bridge and reports a refused drop', async () => {
    const { bridge } = renderApp();
    const file = new File(['a,b\n'], 'notes.txt');
    const zone = screen.getByTestId('app');
    fireEvent.dragOver(zone, { dataTransfer: { types: ['Files'], files: [file], dropEffect: 'none' } });
    expect(screen.getByTestId('empty-state').getAttribute('data-over')).toBe('true');
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(bridge.openDroppedFile).toHaveBeenCalledWith(file);
    expect((await screen.findByRole('alert')).textContent).toContain('notes.txt is not a file on this computer');
    expect(bridge.openCsv).not.toHaveBeenCalled();
  });

  it('follows View → Theme and remembers the choice', () => {
    const { bridge, menu } = renderApp();
    expect(document.documentElement.dataset['ggTheme']).toBe('light');
    expect(bridge.setTheme).toHaveBeenLastCalledWith('system');
    menu({ kind: 'theme', theme: 'dark' });
    expect(document.documentElement.dataset['ggTheme']).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(bridge.setTheme).toHaveBeenLastCalledWith('dark');
    menu({ kind: 'theme', theme: 'system' });
    expect(document.documentElement.dataset['ggTheme']).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('opens from File → Open', async () => {
    const { bridge, menu } = renderApp();
    menu({ kind: 'open' });
    expect(bridge.openCsv).toHaveBeenCalledOnce();
    expect(await screen.findByTestId('file-name')).toBeDefined();
  });
});
