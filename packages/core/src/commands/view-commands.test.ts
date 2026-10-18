import { describe, expect, it } from 'vitest';
import { CommandError } from './errors.js';
import { openFileInput, testWorkspace } from './test-support.js';

async function opened() {
  const workspace = testWorkspace();
  await workspace.registry.dispatch('openFile', openFileInput(), { caller: 'user' });
  return workspace;
}

describe('sortGrid', () => {
  it('replaces the grid sort and undoes back to file order', async () => {
    const { registry, store } = await opened();
    const { state } = await registry.dispatch('sortGrid', { sort: [{ column: 'amount', direction: 'desc' }] }, { caller: 'user' });
    expect(state.grid.sort).toEqual([{ column: 'amount', direction: 'desc' }]);

    await registry.dispatch('sortGrid', { sort: [{ column: 'id' }] }, { caller: 'ai' });
    expect(store.getState().grid.sort).toEqual([{ column: 'id', direction: 'asc' }]);
    await registry.dispatch('undo', {}, { caller: 'user' });
    await registry.dispatch('undo', {}, { caller: 'user' });
    expect(store.getState().grid.sort).toEqual([]);
  });

  it('rejects unknown and repeated columns', async () => {
    const { registry } = await opened();
    await expect(registry.dispatch('sortGrid', { sort: [{ column: 'nope' }] }, { caller: 'ai' })).rejects.toThrow(
      'Unknown column "nope"; columns are "id", "category", "amount", "created_on"',
    );
    await expect(
      registry.dispatch('sortGrid', { sort: [{ column: 'id' }, { column: 'id', direction: 'desc' }] }, { caller: 'ai' }),
    ).rejects.toThrow('appears twice');
  });
});

describe('setFilter and clearFilter', () => {
  it('keeps one selection per view and clears it', async () => {
    const { registry, store } = await opened();
    const { state } = await registry.dispatch('addChart', { spec: { mark: 'bar', x: { column: 'category' } } }, { caller: 'user' });
    const chartId = state.charts[0]?.id ?? '';
    await registry.dispatch('setFilter', { viewId: chartId, filter: { kind: 'in', column: 'category', values: ['alpha'] } }, { caller: 'user' });
    await registry.dispatch('setFilter', { viewId: chartId, filter: { kind: 'in', column: 'category', values: ['bravo'] } }, { caller: 'user' });
    expect(store.getState().selections).toEqual({
      [chartId]: { source: 'filter', clauses: [{ channel: 'x', filter: { kind: 'in', column: 'category', values: ['bravo'] } }] },
    });

    await registry.dispatch('setFilter', { viewId: 'grid', filter: { kind: 'range', column: 'amount', min: 10 } }, { caller: 'ai' });
    expect(Object.keys(store.getState().selections)).toEqual([chartId, 'grid']);
    expect(store.getState().selections['grid']?.clauses[0]?.channel).toBeNull();

    await registry.dispatch('clearFilter', { viewId: chartId }, { caller: 'user' });
    expect(Object.keys(store.getState().selections)).toEqual(['grid']);
    await registry.dispatch('undo', {}, { caller: 'user' });
    expect(store.getState().selections[chartId]?.clauses[0]?.filter).toEqual({ kind: 'in', column: 'category', values: ['bravo'] });
  });

  it('clearing a view without a selection records nothing', async () => {
    const { registry, store } = await opened();
    const before = store.getHistory().past.length;
    const { entryId } = await registry.dispatch('clearFilter', { viewId: 'grid' }, { caller: 'user' });
    expect(entryId).toBeNull();
    expect(store.getHistory().past.length).toBe(before);
  });

  it('rejects unknown views and columns', async () => {
    const { registry } = await opened();
    await expect(
      registry.dispatch('setFilter', { viewId: 'chart_9', filter: { kind: 'isNull', column: 'id' } }, { caller: 'ai' }),
    ).rejects.toThrow('Unknown view "chart_9"; use "grid" or a chart id (there are no charts)');
    const error: unknown = await registry
      .dispatch('setFilter', { viewId: 'grid', filter: { kind: 'notNull', column: 'Amount' } }, { caller: 'ai' })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ code: 'precondition_failed', issues: [{ path: 'filter.column', message: 'Unknown column' }] });
  });
});

describe('chart commands', () => {
  it('adds a chart with a generated id, a layout card and an optional title', async () => {
    const { registry } = await opened();
    const { state } = await registry.dispatch(
      'addChart',
      { spec: { mark: 'bar', x: { column: 'category' }, y: { column: 'amount', aggregate: 'sum' } }, title: 'Revenue' },
      { caller: 'ai' },
    );
    expect(state.charts).toEqual([
      {
        id: 'chart_2',
        title: 'Revenue',
        spec: { mark: 'bar', x: { column: 'category' }, y: { column: 'amount', aggregate: 'sum' }, filters: [] },
      },
    ]);
    expect(state.layout.cards).toEqual([{ chartId: 'chart_2', x: 0, y: 0, w: 1, h: 1 }]);
    const second = await registry.dispatch('addChart', { spec: { mark: 'bar', x: { column: 'id' } } }, { caller: 'user' });
    expect(second.state.layout.cards[1]).toMatchObject({ y: 1 });
  });

  it('refuses charts over unknown columns or without a file', async () => {
    const empty = testWorkspace();
    await expect(empty.registry.dispatch('addChart', { spec: { mark: 'bar', x: { column: 'a' } } }, { caller: 'ai' })).rejects.toThrow(
      'No file is open',
    );
    const { registry } = await opened();
    await expect(
      registry.dispatch('addChart', { spec: { mark: 'bar', x: { column: 'category' }, y: { column: 'nope', aggregate: 'sum' } } }, { caller: 'ai' }),
    ).rejects.toMatchObject({ issues: [{ path: 'spec.y.column' }] });
  });

  it('renames, re-derives and removes a chart with its selection', async () => {
    const { registry, store } = await opened();
    const { state } = await registry.dispatch('addChart', { spec: { mark: 'bar', x: { column: 'category' } } }, { caller: 'user' });
    const chartId = state.charts[0]?.id ?? '';
    await registry.dispatch('renameChart', { chartId, title: '  Rows by category  ' }, { caller: 'user' });
    expect(store.getState().charts[0]?.title).toBe('Rows by category');
    await registry.dispatch('renameChart', { chartId, title: null }, { caller: 'user' });
    expect(store.getState().charts[0]).not.toHaveProperty('title');

    await registry.dispatch('setFilter', { viewId: chartId, filter: { kind: 'in', column: 'category', values: ['alpha'] } }, { caller: 'user' });
    await registry.dispatch('removeChart', { chartId }, { caller: 'user' });
    expect(store.getState()).toMatchObject({ charts: [], selections: {}, layout: { cards: [] } });
    await registry.dispatch('undo', {}, { caller: 'user' });
    expect(store.getState().selections[chartId]).toBeDefined();
    await expect(registry.dispatch('removeChart', { chartId: 'chart_77' }, { caller: 'ai' })).rejects.toThrow('Unknown chart "chart_77"');
  });

  it('sets shelves; the aggregate lives in the y field', async () => {
    const { registry, store } = await opened();
    const { state } = await registry.dispatch('addChart', { spec: { mark: 'bar', x: { column: 'category' } } }, { caller: 'user' });
    const chartId = state.charts[0]?.id ?? '';
    await registry.dispatch('setShelf', { chartId, shelf: 'y', field: { column: 'amount', aggregate: 'avg' } }, { caller: 'user' });
    await registry.dispatch('setShelf', { chartId, shelf: 'color', field: { column: 'created_on' } }, { caller: 'user' });
    expect(store.getState().charts[0]?.spec).toEqual({
      mark: 'bar',
      x: { column: 'category' },
      y: { column: 'amount', aggregate: 'avg' },
      color: { column: 'created_on' },
      filters: [],
    });
    await registry.dispatch('setShelf', { chartId, shelf: 'y', field: null }, { caller: 'user' });
    await registry.dispatch('setShelf', { chartId, shelf: 'color', field: null }, { caller: 'user' });
    expect(store.getState().charts[0]?.spec).toEqual({ mark: 'bar', x: { column: 'category' }, filters: [] });
    await expect(registry.dispatch('setShelf', { chartId, shelf: 'x', field: null }, { caller: 'ai' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});
