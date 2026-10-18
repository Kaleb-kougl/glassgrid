import { describe, expect, it, vi } from 'vitest';
import { tableIdForFile, toFileHandle, type OpenCsvResult, type TableHandle } from '@glassgrid/core';
import { createAppWorkspace } from '../workspace';
import { openFileAction, type OpenFileDeps } from './open-file';

const handle = toFileHandle('0b6c8f0e-6d0a-4f43-9d3e-2f1f1a0d9c11');
const fingerprint = { sizeBytes: 31_857_926, mtimeMs: 1_760_000_000_000, headTailSha256: 'a'.repeat(64), key: 'b'.repeat(32) };
const table: TableHandle = {
  id: tableIdForFile(handle),
  file: handle,
  fileName: 'trips.csv',
  fingerprint,
  usingParquetCache: false,
  columns: [
    { name: 'id', type: 'integer', duckdbType: 'BIGINT' },
    { name: 'amount', type: 'float', duckdbType: 'DOUBLE' },
  ],
};

function setup(picked: OpenCsvResult, open: OpenFileDeps['engine']['open'] = () => Promise.resolve({ table, engineMs: 12 })) {
  let id = 0;
  const workspace = createAppWorkspace({ clock: () => 1_000, newId: (prefix) => `${prefix}_${++id}` });
  const engine = { open: vi.fn(open) };
  const deps = { bridge: { openCsv: () => Promise.resolve(picked) }, engine, registry: workspace.registry };
  return { workspace, engine, deps };
}

const opened: OpenCsvResult = { status: 'opened', file: { handle, displayName: 'trips.csv', sizeBytes: 31_857_926 } };

describe('openFileAction', () => {
  it('opens in the engine, then records openFile with the engine metadata as one undoable entry', async () => {
    const { workspace, engine, deps } = setup(opened);
    const onEngineOpened = vi.fn(() => expect(workspace.store.getState().dataSource).toBeNull());

    const outcome = await openFileAction({ ...deps, onEngineOpened });

    expect(engine.open).toHaveBeenCalledWith(handle);
    expect(onEngineOpened).toHaveBeenCalledWith(table, 12);
    expect(outcome).toMatchObject({ status: 'opened', table, openEngineMs: 12, entryId: 'entry_1' });
    const state = workspace.store.getState();
    expect(state.dataSource).toEqual({ handleId: handle, fileName: 'trips.csv', fingerprint });
    expect(state.columns).toEqual([
      { name: 'id', inferredType: 'integer', typeOverride: null },
      { name: 'amount', inferredType: 'float', typeOverride: null },
    ]);
    expect(workspace.store.getHistory().past.map((e) => [e.name, e.caller])).toEqual([['openFile', 'user']]);

    await workspace.registry.dispatch('setColumnType', { column: 'amount', type: 'text' }, { caller: 'user' });
    await workspace.registry.dispatch('undo', {}, { caller: 'user' });
    expect(workspace.store.getState().columns[1]?.typeOverride).toBeNull();
    await workspace.registry.dispatch('undo', {}, { caller: 'user' });
    expect(workspace.store.getState().dataSource).toBeNull();
    expect(engine.open).toHaveBeenCalledTimes(1); // undo never re-runs engine work
  });

  it('opens a dropped file through the injected picker instead of the dialog', async () => {
    const { workspace, engine, deps } = setup({ status: 'cancelled' });
    const pick = vi.fn(() => Promise.resolve(opened));
    const outcome = await openFileAction({ ...deps, pick });
    expect(pick).toHaveBeenCalledOnce();
    expect(engine.open).toHaveBeenCalledWith(handle);
    expect(outcome.status).toBe('opened');
    expect(workspace.store.getState().dataSource?.fileName).toBe('trips.csv');
  });

  it('does nothing when the dialog is cancelled', async () => {
    const { workspace, engine, deps } = setup({ status: 'cancelled' });
    expect(await openFileAction(deps)).toEqual({ status: 'cancelled' });
    expect(engine.open).not.toHaveBeenCalled();
    expect(workspace.store.getHistory().past).toEqual([]);
  });

  it('records nothing when main or the engine fails', async () => {
    const failed = setup({ status: 'failed', message: 'EACCES' });
    await expect(openFileAction(failed.deps)).rejects.toThrow('Could not open file: EACCES');
    expect(failed.engine.open).not.toHaveBeenCalled();

    const broken = setup(opened, () => Promise.reject(new Error('io_failed')));
    await expect(openFileAction(broken.deps)).rejects.toThrow('io_failed');
    expect(broken.workspace.store.getState().dataSource).toBeNull();
    expect(broken.workspace.store.getHistory().past).toEqual([]);
  });
});

describe('desktop policy', () => {
  it('lets a person confirm writes by clicking, refuses AI writes and raw reads', async () => {
    const { desktopPolicy } = await import('../workspace');
    const request = { command: 'saveWorkspace', tier: 'write' as const, input: {} };
    expect(await desktopPolicy.confirmWrite?.({ ...request, caller: 'user' })).toBe(true);
    expect(await desktopPolicy.confirmWrite?.({ ...request, caller: 'ai' })).toBe(false);
    expect(await desktopPolicy.allowRaw?.({ ...request, tier: 'raw', caller: 'user' })).toBe(false);
  });
});
