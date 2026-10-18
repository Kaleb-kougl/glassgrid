/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { tableFromArrays } from 'apache-arrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tableIdForFile, toFileHandle, type FilterInput, type MenuCommand, type SortKey, type TableHandle } from '@glassgrid/core';
import { App, formatNulls, type AppProps } from './App';
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

interface PageView {
  viewId?: string;
  sort?: SortKey[];
  filters?: readonly FilterInput[];
}

function fakeEngine() {
  const timing = { engineMs: 1, cached: false };
  const restartListeners = new Set<() => void>();
  /** Every page the grid fetched: view, offset and limit. */
  const pages: { table: string; view: PageView; offset: number; limit: number }[] = [];
  return {
    pages,
    restart: () => restartListeners.forEach((listener) => listener()),
    open: vi.fn(() => Promise.resolve({ table, engineMs: 3 })),
    pageFetcher: vi.fn((tableId: string, view: PageView = {}) => (offset: number, limit: number) => {
      pages.push({ table: tableId, view, offset, limit });
      return Promise.resolve({
        table: tableFromArrays({ id: Int32Array.from([1, 2]), category: ['alpha', null], amount: Float64Array.from([1.5, 2]) }),
        ...timing,
      });
    }),
    setColumnTypes: vi.fn((tableId: string, overrides: readonly { column: string; type: string }[]) =>
      Promise.resolve({
        table: { ...table, id: tableId as TableHandle['id'], typeOverrides: overrides.map((o) => ({ ...o })) } as TableHandle,
        columns: overrides.map((o) => ({ column: o.column, type: o.type as 'text', duckdbType: 'VARCHAR', failedCasts: o.type === 'integer' ? 1_234 : 0 })),
        engineMs: 2,
      }),
    ),
    closeTable: vi.fn(() => Promise.resolve()),
    onRestarted: vi.fn((listener: () => void) => {
      restartListeners.add(listener);
      return () => restartListeners.delete(listener);
    }),
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
  } satisfies AppProps['engine'] & Record<string, unknown>;
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
    clipboard: { writeText: vi.fn((_text: string) => Promise.resolve()) },
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
  await waitFor(() => expect(gridCells()).toHaveLength(6));
  return app;
}

/** The info toast (a status region) saying `text`. */
function toastWith(text: string): HTMLElement {
  const found = screen.getAllByRole('status').find((element) => element.textContent.includes(text) && !element.closest('.gg-cgrid'));
  if (!found) throw new Error(`No toast saying ${text}`);
  return found;
}

/** The grid as screen readers see it: the ARIA mirror of the canvas. */
const mirror = () => screen.getByRole('grid');
const gridCells = () => within(mirror()).queryAllByRole('gridcell').map((cell) => cell.textContent);
const gridHeaders = () => within(mirror()).getAllByRole('columnheader').map((cell) => cell.textContent);

function header(name: string): HTMLElement {
  const found = within(mirror())
    .getAllByRole('columnheader')
    .find((cell) => cell.textContent.startsWith(name));
  if (!found) throw new Error(`No header ${name}`);
  return found;
}

function cell(row: number, col: number): HTMLElement {
  const found = mirror().querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);
  if (!found) throw new Error(`No cell ${row}:${col}`);
  return found;
}

/** Keyboard on the focused header or cell (the mirror owns focus; the canvas follows). */
function press(target: HTMLElement, init: { key: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }) {
  act(() => target.focus());
  fireEvent.keyDown(document.activeElement ?? target, init);
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

/** A 2D context that draws nothing: jsdom has no canvas backend. */
function nullContext(): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'measureText') return (text: string) => ({ width: text.length * 7 });
      return () => undefined;
    },
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => nullContext());
  // jsdom does no layout: give the grid's scroller a viewport.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('gg-cgrid__scroller') ? 800 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('gg-cgrid__scroller') ? 400 : 0;
  });
  window.matchMedia = vi.fn((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('formatNulls', () => {
  it('words the share of NULLs', () => {
    expect([0, 0.0004, 0.125, 1].map(formatNulls)).toEqual(['no nulls', '<0.1% null', '12.5% null', '100% null']);
  });
});

describe('App', () => {
  it('starts on the empty state: the window is the drop zone', () => {
    renderApp();
    expect(screen.getByText('Drop a CSV file here')).toBeDefined();
    expect(screen.getByTestId('agent-indicator').textContent).toBe('Agent · not connected');
    expect(screen.getByTestId<HTMLButtonElement>('undo').disabled).toBe(true);
  });

  it('opens a file: first rows on the canvas grid, profile distinct counts and the row count', async () => {
    const { engine, workspace } = await openFile();
    expect(screen.getByTestId('file-name').textContent).toBe('trips.csv');
    expect(engine.pageFetcher).toHaveBeenCalledWith(tableId, { viewId: 'grid', sort: [], filters: [] });
    expect(engine.pages[0]).toMatchObject({ table: tableId, offset: 0, limit: 1000 });
    expect(gridHeaders()).toEqual(['Row', 'id', 'category', 'amount']);
    expect(gridCells()).toEqual(['1', 'alpha', '1.5', '2', 'null (empty value)', '2']);
    expect(mirror().getAttribute('aria-rowcount')).toBe('3');
    await waitFor(() => expect(within(screen.getByTestId('column-category')).getByText('12,345')).toBeDefined());
    expect(within(screen.getByTestId('column-amount')).getByText('8.41M')).toBeDefined();
    expect(screen.getByTestId('column-amount').getAttribute('title')).toBe('no nulls');
    // The profile is recorded in the workspace (for default charts and brush snapping), without an undo entry.
    expect(workspace.store.getState().columns.find((column) => column.name === 'category')?.profile).toEqual({
      type: 'text',
      distinctCount: 12_345,
      nullFraction: 0,
      min: null,
      max: null,
    });
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

  it('sends type overrides to the engine, re-queries every view and reports failed casts with Undo', async () => {
    const { engine, workspace } = await openFile();
    const fetchers = engine.pageFetcher.mock.calls.length;
    const profiles = engine.profile.mock.calls.length;
    const counts = engine.count.mock.calls.length;
    await setType('id', 'Text');
    await waitFor(() => expect(engine.setColumnTypes).toHaveBeenLastCalledWith(tableId, [{ column: 'id', type: 'text' }]));
    // Views re-query once the engine applied the overrides.
    await waitFor(() => expect(engine.pageFetcher.mock.calls.length).toBeGreaterThan(fetchers));
    await waitFor(() => expect(engine.profile.mock.calls.length).toBeGreaterThan(profiles));
    await waitFor(() => expect(engine.count.mock.calls.length).toBeGreaterThan(counts));
    expect(screen.queryByText(/couldn’t be read/)).toBeNull();

    // A cast that fails for some values says so, with Undo.
    await setType('category', 'Integer');
    await waitFor(() =>
      expect(engine.setColumnTypes).toHaveBeenLastCalledWith(tableId, [
        { column: 'id', type: 'text' },
        { column: 'category', type: 'integer' },
      ]),
    );
    const toast = await waitFor(() => toastWith('1,234 values in category couldn’t be read as integer and show as null'));
    fireEvent.click(within(toast).getByRole('button', { name: /Undo/ }));
    expect(workspace.store.getState().columns.find((column) => column.name === 'category')?.typeOverride).toBeNull();
    await waitFor(() => expect(engine.setColumnTypes).toHaveBeenLastCalledWith(tableId, [{ column: 'id', type: 'text' }]));

    // The engine forgets overrides when it restarts: they are sent again.
    const sent = engine.setColumnTypes.mock.calls.length;
    act(() => engine.restart());
    await waitFor(() => expect(engine.setColumnTypes.mock.calls.length).toBe(sent + 1));
    expect(engine.setColumnTypes).toHaveBeenLastCalledWith(tableId, [{ column: 'id', type: 'text' }]);
  });

  it('ends with the engine on the latest overrides after quick undo and redo', async () => {
    const { engine } = await openFile();
    const original = engine.setColumnTypes.getMockImplementation();
    // Slow replies: each change is sent before the previous one is answered.
    engine.setColumnTypes.mockImplementation((tableId, overrides) => new Promise((resolve) => setTimeout(() => resolve(original?.(tableId, overrides) as never), 30)));
    await setType('amount', 'Text');
    fireEvent.click(screen.getByTestId('undo'));
    fireEvent.click(screen.getByTestId('redo'));
    fireEvent.click(screen.getByTestId('undo'));
    await waitFor(() => expect(engine.setColumnTypes.mock.calls.map(([, overrides]) => overrides.length)).toEqual([1, 0, 1, 0]));
    await waitFor(() => expect(screen.queryByTestId('retyping')).toBeNull());
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
    press(header('amount'), { key: 'Enter' });
    expect(workspace.store.getState().grid.sort).toEqual([{ column: 'amount', direction: 'asc' }]);
    expect(engine.pageFetcher).toHaveBeenLastCalledWith(tableId, { viewId: 'grid', sort: [{ column: 'amount', direction: 'asc' }], filters: [] });
    await waitFor(() => expect(engine.pages.at(-1)?.view.sort).toEqual([{ column: 'amount', direction: 'asc' }]));
    await waitFor(() => expect(header('amount').getAttribute('aria-sort')).toBe('ascending'));
    press(header('amount'), { key: 'Enter' });
    press(header('amount'), { key: 'Enter' });
    expect(workspace.store.getState().grid.sort).toEqual([]);
  });

  it('resizes and reorders columns through commands, undoably', async () => {
    const { workspace } = await openFile();
    press(header('amount'), { key: 'ArrowRight', altKey: true, shiftKey: true });
    expect(workspace.store.getState().grid.columnWidths).toEqual([{ column: 'amount', width: 120 }]);
    press(header('amount'), { key: 'ArrowLeft', altKey: true });
    expect(workspace.store.getState().grid.columnOrder).toEqual(['id', 'amount', 'category']);
    await waitFor(() => expect(gridHeaders()).toEqual(['Row', 'id', 'amount', 'category']));
    expect(historyEntries().map((entry) => entry.split('by ')[0])).toEqual(['Moved amount to position 2', 'Resized amount to 120 px', 'Opened trips.csv']);
    fireEvent.click(screen.getByTestId('undo'));
    await waitFor(() => expect(gridHeaders()).toEqual(['Row', 'id', 'category', 'amount']));
  });

  it('keeps the selection in the store without undo entries and marks its columns in the list', async () => {
    const { workspace } = await openFile();
    press(cell(0, 1), { key: 'ArrowRight', shiftKey: true });
    expect(workspace.store.getState().grid.selection).toEqual({ anchor: { row: 0, column: 'category' }, focus: { row: 0, column: 'amount' } });
    expect(screen.getByTestId('column-category').dataset['selected']).toBe('true');
    expect(screen.getByTestId('column-amount').dataset['selected']).toBe('true');
    expect(screen.getByTestId('column-id').dataset['selected']).toBe('false');
    expect(workspace.store.getHistory().past.map((entry) => entry.name)).toEqual(['openFile']);

    // An agent can drive it too; the grid follows.
    await act(() =>
      workspace.registry.dispatch('setSelection', { selection: { anchor: { row: 1, column: 'id' }, focus: { row: 1, column: 'id' } } }, { caller: 'ai' }),
    );
    expect(cell(1, 0).getAttribute('aria-selected')).toBe('true');
  });

  it('copies the selection as TSV through copySelection and the preload clipboard', async () => {
    const { workspace, bridge } = await openFile();
    press(cell(0, 0), { key: 'ArrowDown', shiftKey: true });
    press(cell(1, 0), { key: 'ArrowRight', shiftKey: true });
    press(cell(1, 1), { key: 'c', ctrlKey: true });
    await waitFor(() => expect(bridge.clipboard.writeText).toHaveBeenCalledWith('1\talpha\n2\t'));
    await waitFor(() => expect(toastWith('Copied 2 rows × 2 columns.')).toBeDefined());
    // Write tier: an AI caller is refused (no confirmation UI yet), and nothing is recorded.
    await expect(workspace.registry.dispatch('copySelection', {}, { caller: 'ai' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(bridge.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(workspace.store.getHistory().past.map((entry) => entry.name)).toEqual(['openFile']);
  });

  it('closes the previous table when another file replaces it', async () => {
    const { engine, bridge } = await openFile();
    const second = toFileHandle('1b6c8f0e-6d0a-4f43-9d3e-2f1f1a0d9c22');
    bridge.openCsv.mockResolvedValueOnce({ status: 'opened', file: { handle: second, displayName: 'b.csv', sizeBytes: 10 } });
    engine.open.mockResolvedValueOnce({ table: { ...table, id: tableIdForFile(second), file: second, fileName: 'b.csv' }, engineMs: 1 });
    fireEvent.click(screen.getByTestId('open-csv'));
    await waitFor(() => expect(screen.getByTestId('file-name').textContent).toBe('b.csv'));
    await waitFor(() => expect(engine.closeTable).toHaveBeenCalledWith(tableId));
    expect(engine.closeTable).toHaveBeenCalledTimes(1);
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
    const clicked = { source: 'click', clauses: [{ channel: 'x', filter: { kind: 'in', column: 'category', values: ['alpha'] } }] };
    expect(workspace.store.getState().selections).toEqual({ chart_2: clicked });
    expect(workspace.store.getHistory().past.at(-1)?.name).toBe('brush');
    expect(within(bars).getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('1 selected')).toBeDefined();

    const chip = screen.getByTestId('filter-category');
    expect(chip.textContent).toBe('category= alpha×');
    const filters = [{ kind: 'in', column: 'category', values: ['alpha'] }];
    await waitFor(() => expect(engine.count).toHaveBeenLastCalledWith(tableId, { viewId: 'status', filters }));
    expect(engine.pageFetcher).toHaveBeenLastCalledWith(tableId, { viewId: 'grid', sort: [], filters });
    await waitFor(() => expect(engine.pages.at(-1)?.view.filters).toEqual(filters));
    await waitFor(() => expect(screen.getByTestId('row-count').textContent).toBe('1 of 2 rows'));
    // The chart that owns the selection keeps its full distribution.
    expect(engine.aggregate).toHaveBeenCalledTimes(1);

    fireEvent.click(within(chip).getByRole('button', { name: 'Remove filter on category' }));
    expect(workspace.store.getState().selections).toEqual({});
    const toast = toastWith('Removed filter category');
    fireEvent.click(within(toast).getByRole('button', { name: /Undo/ }));
    expect(workspace.store.getState().selections).toEqual({ chart_2: clicked });
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
