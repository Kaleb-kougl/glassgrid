import { describe, expect, it } from 'vitest';
import { createInitialWorkspaceState, effectiveColumnType } from '../state/workspace.js';
import { CommandError } from './errors.js';
import { WorkspaceStore } from './store.js';
import { fakeClock, openFileInput, sequentialIds, testWorkspace } from './test-support.js';

describe('openFile', () => {
  it('starts a fresh workspace over the file', async () => {
    const { registry } = testWorkspace();
    const { state } = await registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    expect(state.dataSource).toEqual({
      handleId: 'fh_0123456789abcdef',
      fileName: 'sales.csv',
      fingerprint: { sizeBytes: 31_000_000, mtimeMs: 1_760_000_000_000, headTailSha256: 'a'.repeat(64), key: 'b'.repeat(32) },
    });
    expect(state.columns[2]).toEqual({ name: 'amount', inferredType: 'float', typeOverride: null });
    expect(state.charts).toEqual([]);
  });

  it('can be undone back to the previous workspace', async () => {
    const { registry, store } = testWorkspace();
    await registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    await registry.dispatch('setColumnType', { column: 'id', type: 'text' }, { caller: 'user' });
    const before = store.getState();
    await registry.dispatch('openFile', openFileInput({ fileName: 'other.csv', columns: [] }), { caller: 'user' });
    expect(store.getState().columns).toEqual([]);
    await registry.dispatch('undo', {}, { caller: 'user' });
    expect(store.getState()).toEqual(before);
  });
});

describe('setColumnType', () => {
  it('records an override and clears it when set back to the inferred type', async () => {
    const { registry } = testWorkspace();
    await registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    let { state } = await registry.dispatch('setColumnType', { column: 'amount', type: 'decimal' }, { caller: 'ai' });
    expect(state.columns[2]).toMatchObject({ typeOverride: 'decimal' });
    expect(effectiveColumnType(state.columns[2] ?? { inferredType: 'text', typeOverride: null })).toBe('decimal');

    ({ state } = await registry.dispatch('setColumnType', { column: 'amount', type: 'float' }, { caller: 'ai' }));
    expect(state.columns[2]).toMatchObject({ typeOverride: null });
  });

  it('names the known columns when the column does not exist', async () => {
    const { registry } = testWorkspace();
    await registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    const error: unknown = await registry
      .dispatch('setColumnType', { column: 'Amount', type: 'text' }, { caller: 'ai' })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ code: 'precondition_failed', command: 'setColumnType' });
    expect((error as CommandError).message).toBe(
      'Unknown column "Amount"; columns are "id", "category", "amount", "created_on"',
    );
  });

  it('explains when no file is open', async () => {
    const { registry } = testWorkspace();
    await expect(registry.dispatch('setColumnType', { column: 'a', type: 'text' }, { caller: 'ai' })).rejects.toThrow(
      'No file is open',
    );
  });
});

describe('undo and redo', () => {
  it('step back and forward through every change, whoever made it', async () => {
    const { registry, store } = testWorkspace();
    const s0 = store.getState();
    const { state: s1 } = await registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    const { state: s2, entryId: e2 } = await registry.dispatch(
      'setColumnType',
      { column: 'id', type: 'text' },
      { caller: 'ai' },
    );

    const undone = await registry.dispatch('undo', {}, { caller: 'user' });
    expect(undone.entryId).toBe(e2);
    expect(undone.state).toEqual(s1);
    expect((await registry.dispatch('undo', {}, { caller: 'ai' })).state).toEqual(s0);
    expect((await registry.dispatch('undo', {}, { caller: 'ai' })).entryId).toBeNull();

    await registry.dispatch('redo', {}, { caller: 'ai' });
    const redone = await registry.dispatch('redo', {}, { caller: 'user' });
    expect(redone.entryId).toBe(e2);
    expect(redone.state).toEqual(s2);
    expect(store.canRedo()).toBe(false);
  });

  it('are not recorded as entries themselves', async () => {
    const { registry, store } = testWorkspace();
    await registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    await registry.dispatch('undo', {}, { caller: 'user' });
    await registry.dispatch('redo', {}, { caller: 'user' });
    expect(store.getHistory().past.map((entry) => entry.name)).toEqual(['openFile']);
    expect(store.getHistory().future).toEqual([]);
  });

  it('a new command clears the redo stack', async () => {
    const { registry, store } = testWorkspace();
    await registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    await registry.dispatch('setColumnType', { column: 'id', type: 'text' }, { caller: 'user' });
    await registry.dispatch('undo', {}, { caller: 'user' });
    expect(store.getHistory().future.map((entry) => entry.name)).toEqual(['setColumnType']);

    await registry.dispatch('setColumnType', { column: 'amount', type: 'text' }, { caller: 'ai' });
    expect(store.canRedo()).toBe(false);
    expect((await registry.dispatch('redo', {}, { caller: 'user' })).entryId).toBeNull();
    expect(store.getState().columns.map((column) => column.typeOverride)).toEqual([null, null, 'text', null]);
  });

  it('a no-op command keeps the redo stack', async () => {
    const { registry, store } = testWorkspace();
    await registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    await registry.dispatch('setColumnType', { column: 'id', type: 'text' }, { caller: 'user' });
    await registry.dispatch('undo', {}, { caller: 'user' });
    const noop = await registry.dispatch('setColumnType', { column: 'id', type: 'integer' }, { caller: 'user' });
    expect(noop.entryId).toBeNull();
    expect(store.canRedo()).toBe(true);
  });
});

describe('WorkspaceStore', () => {
  it('drops the oldest entries beyond the history limit', () => {
    const store = new WorkspaceStore(createInitialWorkspaceState(), {
      clock: fakeClock(),
      newId: sequentialIds(),
      historyLimit: 2,
    });
    for (const name of ['a', 'b', 'c']) {
      store.commit({ name: 'test', caller: 'user', input: name }, (draft) => {
        draft.grid.sort.push({ column: name, direction: 'asc' });
      });
    }
    expect(store.getHistory().past.map((entry) => entry.input)).toEqual(['b', 'c']);
    store.undo();
    store.undo();
    expect(store.undo()).toBeNull();
    expect(store.getState().grid.sort).toEqual([{ column: 'a', direction: 'asc' }]);
  });

  it('keeps snapshots stable between changes, as useSyncExternalStore requires', () => {
    const store = new WorkspaceStore(createInitialWorkspaceState(), { clock: fakeClock(), newId: sequentialIds() });
    expect(store.getState()).toBe(store.getState());
    expect(store.getHistory()).toBe(store.getHistory());
  });

  it('does not freeze or alias the initial state it was given', () => {
    const initial = createInitialWorkspaceState();
    const store = new WorkspaceStore(initial, { clock: fakeClock(), newId: sequentialIds() });
    expect(Object.isFrozen(initial)).toBe(false);
    expect(store.getState()).not.toBe(initial);
    expect(store.getState()).toEqual(initial);
  });

  it('passes the injected clock and id generator to commands', () => {
    const store = new WorkspaceStore(createInitialWorkspaceState(), {
      clock: fakeClock(5_000),
      newId: sequentialIds(),
    });
    const entry = store.commit({ name: 'test', caller: 'ai', input: {} }, (draft, ctx) => {
      const id = ctx.newId('chart');
      draft.charts.push({ id, spec: { mark: 'bar', x: { column: ctx.caller }, filters: [] } });
      draft.filters[id] = { kind: 'range', column: 'at', min: ctx.now, minInclusive: true, maxInclusive: true };
    });
    expect(store.getState().charts).toEqual([{ id: 'chart_1', spec: { mark: 'bar', x: { column: 'ai' }, filters: [] } }]);
    expect(store.getState().filters).toEqual({
      chart_1: { kind: 'range', column: 'at', min: 5_000, minInclusive: true, maxInclusive: true },
    });
    expect(entry).toMatchObject({ id: 'entry_2', at: 5_000, caller: 'ai' });
  });
});
