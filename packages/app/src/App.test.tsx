/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tableIdForFile, toFileHandle, type MenuCommand } from '@glassgrid/core';
import { App, formatNulls } from './App';
import { EngineError } from './engine';
import { fakeEngine, handle, table, tableId } from './test-support/fake-engine';
import { fakePlatform } from './test-support/fake-platform';
import { stubLayout } from './test-support/jsdom';
import { THEME_STORAGE_KEY } from './theme';
import { createAppWorkspace } from './workspace';

function renderApp() {
  let id = 0;
  const workspace = createAppWorkspace({ clock: () => 1_000, newId: (prefix) => `${prefix}_${++id}` });
  const engine = fakeEngine();
  const fake = fakePlatform(engine, {
    picked: { status: 'opened', file: { handle, displayName: 'trips.csv', sizeBytes: 2048 } },
    dropped: { status: 'failed', message: 'notes.txt is not a file on this computer' },
  });
  render(<App platform={fake.platform} workspace={workspace} />);
  const menu = (command: MenuCommand) => {
    act(() => fake.menu(command));
  };
  return { engine, workspace, files: fake.files, clipboard: fake.clipboard, shell: fake.shell, menu, close: fake.close };
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

beforeEach(() => {
  stubLayout();
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
    const { workspace, clipboard } = await openFile();
    press(cell(0, 0), { key: 'ArrowDown', shiftKey: true });
    press(cell(1, 0), { key: 'ArrowRight', shiftKey: true });
    press(cell(1, 1), { key: 'c', ctrlKey: true });
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('1\talpha\n2\t'));
    await waitFor(() => expect(toastWith('Copied 2 rows × 2 columns.')).toBeDefined());
    // Write tier: an AI caller is refused (no confirmation UI yet), and nothing is recorded.
    await expect(workspace.registry.dispatch('copySelection', {}, { caller: 'ai' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(workspace.store.getHistory().past.map((entry) => entry.name)).toEqual(['openFile']);
  });

  it('closes the previous table when another file replaces it', async () => {
    const { engine, files } = await openFile();
    const second = toFileHandle('1b6c8f0e-6d0a-4f43-9d3e-2f1f1a0d9c22');
    files.pickCsv.mockResolvedValueOnce({ status: 'opened', file: { handle: second, displayName: 'b.csv', sizeBytes: 10 } });
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
    // The default chart rules: category has 12,345 distinct values, so the top 20 bars plus "Other".
    expect(engine.aggregate).toHaveBeenCalledWith(
      tableId,
      { mark: 'bar', x: { column: 'category' }, filters: [], limit: 20, other: true, pixelWidth: 100 },
      { viewId: 'chart:chart_2' },
    );
    expect(workspace.store.getHistory().past.at(-1)?.input).toEqual({ columns: ['category'] });

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
    // The clicked chart is the active view: the count carries a cube hint for its selection.
    const crossfilter = { filter: 0, dimension: { column: 'category', bin: { kind: 'value' } } };
    await waitFor(() => expect(engine.count).toHaveBeenLastCalledWith(tableId, { viewId: 'status', filters, crossfilter }));
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
      Promise.reject(new EngineError('bad_request', 'y.aggregate "sum" needs a numeric column, but "category" is text. Use "count" instead.', 'y.aggregate')),
    );
    await act(() => workspace.registry.dispatch('addChart', { spec: { mark: 'bar', x: { column: 'id' }, y: { column: 'category', aggregate: 'sum' } } }, { caller: 'ai' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('y.aggregate "sum" needs a numeric column');
    expect(alert.textContent).toContain('y.aggregate');
    expect(screen.getByText('by AI')).toBeDefined();
  });

  it('opens a dropped file through the platform and reports a refused drop', async () => {
    const { files } = renderApp();
    const file = new File(['a,b\n'], 'notes.txt');
    const zone = screen.getByTestId('app');
    fireEvent.dragOver(zone, { dataTransfer: { types: ['Files'], files: [file], dropEffect: 'none' } });
    expect(screen.getByTestId('empty-state').getAttribute('data-over')).toBe('true');
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(files.openDropped).toHaveBeenCalledWith(file);
    expect((await screen.findByRole('alert')).textContent).toContain('notes.txt is not a file on this computer');
    expect(files.pickCsv).not.toHaveBeenCalled();
  });

  it('follows View → Theme and remembers the choice', () => {
    const { shell, menu } = renderApp();
    expect(document.documentElement.dataset['ggTheme']).toBe('light');
    expect(shell.syncTheme).toHaveBeenLastCalledWith('system');
    menu({ kind: 'theme', theme: 'dark' });
    expect(document.documentElement.dataset['ggTheme']).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(shell.syncTheme).toHaveBeenLastCalledWith('dark');
    menu({ kind: 'theme', theme: 'system' });
    expect(document.documentElement.dataset['ggTheme']).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('opens from File → Open', async () => {
    const { files, menu } = renderApp();
    menu({ kind: 'open' });
    expect(files.pickCsv).toHaveBeenCalledOnce();
    expect(await screen.findByTestId('file-name')).toBeDefined();
  });

  it('charts a number as a histogram, prepares cubes on pointer down and cross-filters the other chart on a brush', async () => {
    const { engine, workspace } = await openFile();
    for (const name of ['category', 'amount']) {
      const row = screen.getByTestId(`column-${name}`);
      row.focus();
      fireEvent.keyDown(row, { key: 'Enter' });
    }
    const [bar, histogram] = workspace.store.getState().charts;
    expect(histogram?.spec).toEqual({ mark: 'histogram', x: { column: 'amount', bin: 'auto' }, filters: [] });
    const plot = await screen.findByRole('img', { name: /Distribution of amount\. Histogram of count\(\*\) by bin\(amount, 1\)/ });
    expect(screen.getByTestId(`chart-${histogram?.id ?? ''}-shelf-x`).textContent).toContain('bin(amount, 1)');

    // Pointer down: the engine builds the cubes for a brush on amount's bins (the bar chart and the count).
    fireEvent.pointerDown(plot.closest('.chart-view__plot') as HTMLElement, { button: 0 });
    expect(engine.prepareCrossfilter).toHaveBeenCalledWith(tableId, {
      dimension: { column: 'amount', bin: { kind: 'width', width: 1 } },
      targets: [
        { kind: 'aggregate', spec: { ...bar?.spec, pixelWidth: 100 } },
        { kind: 'count', filters: [] },
      ],
    });

    // Enter on the focused plot creates a brush (the middle fifth), snapped by the brush command to whole bins.
    const barCalls = () => engine.aggregate.mock.calls.filter((call) => (call[2] as { viewId?: string } | undefined)?.viewId === `chart:${bar?.id ?? ''}`);
    const before = barCalls().length;
    fireEvent.keyDown(plot, { key: 'Enter' });
    await waitFor(() => expect(workspace.store.getState().selections[histogram?.id ?? '']).toBeDefined());
    expect(workspace.store.getHistory().past.at(-1)?.name).toBe('brush');
    const filter = workspace.store.getState().selections[histogram?.id ?? '']?.clauses[0]?.filter;
    expect(filter).toMatchObject({ kind: 'range', column: 'amount', minInclusive: true, maxInclusive: false });
    // The bar chart re-queries with the brush, answered from the cube the hint names.
    await waitFor(() => expect(barCalls().length).toBe(before + 1));
    expect(barCalls().at(-1)?.[1]).toMatchObject({ filters: [filter] });
    expect(barCalls().at(-1)?.[2]).toEqual({
      viewId: `chart:${bar?.id ?? ''}`,
      crossfilter: { filter: 0, dimension: { column: 'amount', bin: { kind: 'width', width: 1 } } },
    });
    expect(screen.getByTestId('filter-amount').textContent).toMatch(/^amount\d/);
    await waitFor(() => expect(screen.getByTestId('row-count').textContent).toBe('1 of 2 rows'));

    // Undo restores the unfiltered views.
    fireEvent.click(screen.getByTestId('undo'));
    expect(workspace.store.getState().selections).toEqual({});
    await waitFor(() => expect(screen.getByTestId('row-count').textContent).toBe('2 rows'));
  });

  it('switches marks from the card menu with setMark and disables marks the columns cannot make', async () => {
    const { workspace } = await openFile();
    const row = screen.getByTestId('column-amount');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    const chart = workspace.store.getState().charts[0];
    await screen.findByRole('img', { name: /Histogram/ });
    const card = screen.getByTestId(`chart-${chart?.id ?? ''}`);
    fireEvent.click(within(card).getByRole('button', { name: 'Chart actions' }));
    const heatmap = await screen.findByRole('menuitemradio', { name: /^Heatmap/ });
    expect(heatmap.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('menuitemradio', { name: /^Histogram/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Line chart/ }));
    expect(workspace.store.getState().charts[0]?.spec.mark).toBe('line');
    expect(workspace.store.getHistory().past.at(-1)?.name).toBe('setMark');
    await screen.findByRole('img', { name: /Line chart of count\(\*\)/ });

    // The colour shelf takes a dropped column; the legend lists its series.
    const color = screen.getByTestId(`chart-${chart?.id ?? ''}-shelf-color`);
    fireEvent.drop(color, { dataTransfer: { types: ['application/x-glassgrid-column'], getData: () => 'category' } });
    await waitFor(() => expect(workspace.store.getState().charts[0]?.spec.color).toEqual({ column: 'category' }));
  });

  it('charts two columns selected in the grid together with the default rules', async () => {
    const { workspace } = await openFile();
    await act(() =>
      workspace.registry.dispatch('setSelection', { selection: { anchor: { row: 0, column: 'id' }, focus: { row: 1, column: 'amount' } } }, { caller: 'user' }),
    );
    // id..amount covers three columns: "+ New chart" charts the first.
    fireEvent.click(screen.getByTestId('new-chart'));
    expect(workspace.store.getHistory().past.at(-1)?.input).toEqual({ columns: ['id'] });
    await act(() =>
      workspace.registry.dispatch('reorderColumn', { column: 'amount', toIndex: 1 }, { caller: 'user' }),
    );
    await act(() =>
      workspace.registry.dispatch('setSelection', { selection: { anchor: { row: 0, column: 'id' }, focus: { row: 1, column: 'amount' } } }, { caller: 'user' }),
    );
    const row = screen.getByTestId('column-amount');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(workspace.store.getHistory().past.at(-1)?.input).toEqual({ columns: ['amount', 'id'] });
    expect(workspace.store.getState().charts.at(-1)?.spec).toMatchObject({ mark: 'heatmap', x: { column: 'amount', bin: 'auto' }, y: { column: 'id', bin: 'auto' } });
    await screen.findByRole('img', { name: /Heatmap of bin\(amount, 1\) by bin\(id, 1\)/ });
  });

  it('adds a filter from the "+ Filter" editor, validating the values first', async () => {
    const { engine, workspace } = await openFile();
    fireEvent.click(screen.getByTestId('add-filter'));
    const dialog = await screen.findByRole('dialog', { name: 'Add a filter' });
    fireEvent.change(within(dialog).getByTestId('filter-editor-column'), { target: { value: 'amount' } });
    expect(within(dialog).getByTestId<HTMLSelectElement>('filter-editor-operator').value).toBe('between');
    fireEvent.change(within(dialog).getByTestId('filter-editor-min'), { target: { value: '1' } });
    fireEvent.change(within(dialog).getByTestId('filter-editor-max'), { target: { value: 'lots' } });
    fireEvent.click(within(dialog).getByTestId('filter-editor-submit'));
    expect(within(dialog).getByRole('alert').textContent).toBe('“lots” is not a number');
    expect(within(dialog).getByTestId('filter-editor-max').getAttribute('aria-invalid')).toBe('true');
    expect(workspace.store.getState().userFilters).toEqual([]);

    fireEvent.change(within(dialog).getByTestId('filter-editor-max'), { target: { value: '1.75' } });
    fireEvent.click(within(dialog).getByTestId('filter-editor-submit'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const filter = { kind: 'range', column: 'amount', min: 1, max: 1.75, minInclusive: true, maxInclusive: true };
    expect(workspace.store.getState().userFilters).toEqual([{ id: expect.stringMatching(/^filter_/) as unknown, filter }]);
    expect(screen.getByTestId('filter-amount').textContent).toBe('amount1.00 – 1.75×');
    await waitFor(() => expect(engine.count).toHaveBeenLastCalledWith(tableId, { viewId: 'status', filters: [filter] }));
    fireEvent.click(within(screen.getByTestId('filter-amount')).getByRole('button', { name: 'Remove filter on amount' }));
    expect(workspace.store.getState().userFilters).toEqual([]);
  });
});
