import { describe, expect, it, vi } from 'vitest';
import { gridColumnOrder } from '../state/workspace.js';
import { desktopLikePolicy, openFileInput, testWorkspace } from './test-support.js';

async function opened(policy = desktopLikePolicy) {
  const workspace = testWorkspace(policy);
  await workspace.registry.dispatch('openFile', openFileInput(), { caller: 'user' });
  return workspace;
}

const cell = (row: number, column: string) => ({ row, column });

describe('resizeColumn', () => {
  it('records widths by column name and undoes them', async () => {
    const { registry, store } = await opened();
    await registry.dispatch('resizeColumn', { column: 'amount', width: 180 }, { caller: 'user' });
    await registry.dispatch('resizeColumn', { column: 'id', width: 60 }, { caller: 'ai' });
    await registry.dispatch('resizeColumn', { column: 'amount', width: 200 }, { caller: 'user' });
    expect(store.getState().grid.columnWidths).toEqual([
      { column: 'amount', width: 200 },
      { column: 'id', width: 60 },
    ]);
    await registry.dispatch('undo', {}, { caller: 'user' });
    expect(store.getState().grid.columnWidths).toEqual([
      { column: 'amount', width: 180 },
      { column: 'id', width: 60 },
    ]);
  });

  it('rejects unknown columns and widths out of bounds', async () => {
    const { registry } = await opened();
    await expect(registry.dispatch('resizeColumn', { column: 'nope', width: 100 }, { caller: 'ai' })).rejects.toThrow('Unknown column "nope"');
    await expect(registry.dispatch('resizeColumn', { column: 'id', width: 10 }, { caller: 'ai' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(registry.dispatch('resizeColumn', { column: 'id', width: 120.5 }, { caller: 'ai' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('reorderColumn', () => {
  it('moves a column to its index after the move, starting from file order', async () => {
    const { registry, store } = await opened();
    expect(gridColumnOrder(store.getState())).toEqual(['id', 'category', 'amount', 'created_on']);
    await registry.dispatch('reorderColumn', { column: 'amount', toIndex: 0 }, { caller: 'user' });
    expect(store.getState().grid.columnOrder).toEqual(['amount', 'id', 'category', 'created_on']);
    await registry.dispatch('reorderColumn', { column: 'amount', toIndex: 3 }, { caller: 'ai' });
    expect(gridColumnOrder(store.getState())).toEqual(['id', 'category', 'created_on', 'amount']);
    await registry.dispatch('undo', {}, { caller: 'user' });
    expect(gridColumnOrder(store.getState())).toEqual(['amount', 'id', 'category', 'created_on']);
  });

  it('records nothing for a move to the same place and refuses an index past the end', async () => {
    const { registry, store } = await opened();
    const { entryId } = await registry.dispatch('reorderColumn', { column: 'category', toIndex: 1 }, { caller: 'user' });
    expect(entryId).toBeNull();
    expect(store.getState().grid.columnOrder).toEqual([]);
    await expect(registry.dispatch('reorderColumn', { column: 'id', toIndex: 4 }, { caller: 'ai' })).rejects.toThrow('toIndex must be below 4');
  });

  it('opening a file resets order, widths and selection', async () => {
    const { registry, store } = await opened();
    await registry.dispatch('reorderColumn', { column: 'amount', toIndex: 0 }, { caller: 'user' });
    await registry.dispatch('resizeColumn', { column: 'id', width: 90 }, { caller: 'user' });
    await registry.dispatch('setSelection', { selection: { anchor: cell(1, 'id'), focus: cell(2, 'amount') } }, { caller: 'user' });
    await registry.dispatch('openFile', openFileInput({ fileName: 'other.csv' }), { caller: 'user' });
    expect(store.getState().grid).toEqual({ sort: [], columnOrder: [], columnWidths: [], selection: null });
  });
});

describe('setSelection', () => {
  it('changes the selection without an undo entry and keeps the redo stack', async () => {
    const { registry, store } = await opened();
    await registry.dispatch('sortGrid', { sort: [{ column: 'id', direction: 'desc' }] }, { caller: 'user' });
    await registry.dispatch('undo', {}, { caller: 'user' });
    const history = store.getHistory();
    const listener = vi.fn();
    store.subscribe(listener);

    const selection = { anchor: cell(3, 'category'), focus: cell(7, 'amount') };
    const result = await registry.dispatch('setSelection', { selection }, { caller: 'user' });
    expect(result.entryId).toBeNull();
    expect(result.state.grid.selection).toEqual(selection);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getHistory()).toBe(history);
    expect(store.canRedo()).toBe(true);

    // Undo and redo step over it: the selection stays as set.
    await registry.dispatch('redo', {}, { caller: 'user' });
    expect(store.getState().grid).toMatchObject({ sort: [{ column: 'id', direction: 'desc' }], selection });
    await registry.dispatch('undo', {}, { caller: 'user' });
    expect(store.getState().grid).toMatchObject({ sort: [], selection });

    await registry.dispatch('setSelection', { selection: null }, { caller: 'ai' });
    expect(store.getState().grid.selection).toBeNull();
    expect(store.getHistory().past.map((entry) => entry.name)).toEqual(['openFile']);
  });

  it('validates column names and rows', async () => {
    const { registry } = await opened();
    await expect(
      registry.dispatch('setSelection', { selection: { anchor: cell(0, 'id'), focus: cell(0, 'Amount') } }, { caller: 'ai' }),
    ).rejects.toMatchObject({ code: 'precondition_failed', issues: [{ path: 'selection.focus.column' }] });
    await expect(
      registry.dispatch('setSelection', { selection: { anchor: cell(-1, 'id'), focus: cell(0, 'id') } }, { caller: 'ai' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('copySelection', () => {
  it('runs the host handler for a person, with the state, and returns its value', async () => {
    const { registry } = await opened();
    const handler = vi.fn(() => Promise.resolve({ rows: 2, columns: 1 }));
    registry.provide('copySelection', handler);
    await registry.dispatch('setSelection', { selection: { anchor: cell(0, 'id'), focus: cell(1, 'id') } }, { caller: 'user' });
    const result = await registry.dispatch('copySelection', {}, { caller: 'user' });
    expect(result).toMatchObject({ entryId: null, value: { rows: 2, columns: 1 } });
    expect(handler).toHaveBeenCalledWith({}, expect.objectContaining({ caller: 'user' }));
    const ctx = (handler.mock.calls[0] as unknown[] | undefined)?.[1] as { state: { grid: { selection: unknown } } };
    expect(ctx.state.grid.selection).toEqual({ anchor: cell(0, 'id'), focus: cell(1, 'id') });
  });

  it('is write tier: the desktop policy refuses AI callers before the handler runs', async () => {
    const { registry } = await opened();
    const handler = vi.fn();
    registry.provide('copySelection', handler);
    expect(registry.list().find((info) => info.name === 'copySelection')).toMatchObject({ tier: 'write', mcp: { exposed: true } });
    await expect(registry.dispatch('copySelection', {}, { caller: 'ai' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('is unavailable until the host provides it, and provide only takes effect commands', async () => {
    const { registry } = await opened();
    await expect(registry.dispatch('copySelection', {}, { caller: 'user' })).rejects.toMatchObject({ code: 'unavailable' });
    const remove = registry.provide('copySelection', () => 'ok');
    expect((await registry.dispatch('copySelection', {}, { caller: 'user' })).value).toBe('ok');
    remove();
    await expect(registry.dispatch('copySelection', {}, { caller: 'user' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(() => registry.provide('sortGrid', () => undefined)).toThrow('not a registered effect command');
  });
});
