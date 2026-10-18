import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeWorkspace, toFileHandle, type RecoveryUpdate, type WorkspaceSnapshot } from '@glassgrid/core';
import { Autosaver, DEFAULT_AUTOSAVE_INTERVAL_MS, newRecoveryId, RecoveryStore } from './recovery';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gg-recovery-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const snapshot = (sort: 'asc' | 'desc' | null = null): WorkspaceSnapshot => ({
  dataSource: {
    handleId: toFileHandle('00000000-0000-0000-0000-000000000001'),
    fileName: 'trips.csv',
    fingerprint: { sizeBytes: 1, mtimeMs: 1, headTailSha256: 'a'.repeat(64), key: 'b'.repeat(32) },
  },
  workspace: {
    columns: [{ name: 'id', inferredType: 'integer', typeOverride: null }],
    charts: [],
    selections: {},
    userFilters: [],
    grid: { sort: sort === null ? [] : [{ column: 'id', direction: sort }], columnOrder: [], columnWidths: [] },
    layout: { cards: [] },
  },
});
const update = (sort: 'asc' | 'desc' | null = null): RecoveryUpdate => ({ documentId: null, snapshot: snapshot(sort) });
const META = { app: { name: 'Glassgrid', version: '1' }, absolutePath: '/d/trips.csv', relativePath: null };

describe('RecoveryStore', () => {
  it('lists recovery snapshots newest first and deletes what is not one', async () => {
    const store = new RecoveryStore(dir);
    const [older, newer, live] = [newRecoveryId(), newRecoveryId(), newRecoveryId()];
    await store.write(older, serializeWorkspace(snapshot(), { ...META, savedAt: '2026-10-18T08:00:00.000Z', recoveryOf: { workspacePath: null } }));
    await store.write(newer, serializeWorkspace(snapshot(), { ...META, savedAt: '2026-10-18T09:00:00.000Z', recoveryOf: { workspacePath: '/nowhere/a.glassgrid' } }));
    await store.write(live, serializeWorkspace(snapshot(), { ...META, savedAt: '2026-10-18T09:30:00.000Z', recoveryOf: { workspacePath: null } }));
    const notRecovery = newRecoveryId();
    await store.write(notRecovery, serializeWorkspace(snapshot(), { ...META, savedAt: '2026-10-18T09:00:00.000Z' }));
    const corrupt = newRecoveryId();
    await writeFile(store.pathOf(corrupt), '{"formatVersion": 1');
    await writeFile(join(dir, 'unrelated.txt'), 'keep me');

    const listed = await store.list(new Set([live]));
    expect(listed.map((entry) => entry.id)).toEqual([newer, older]);
    expect(listed[0]?.workspacePath).toBe('/nowhere/a.glassgrid');
    expect((await readdir(dir)).sort()).toEqual([`${live}.glassgrid`, `${newer}.glassgrid`, `${older}.glassgrid`, 'unrelated.txt'].sort());
  });

  it('refuses ids that are not recovery ids', () => {
    const store = new RecoveryStore(dir);
    expect(() => store.pathOf('../state')).toThrow('Invalid recovery id');
  });

  it('a missing folder lists nothing', async () => {
    expect(await new RecoveryStore(join(dir, 'none')).list()).toEqual([]);
    await mkdir(join(dir, 'none'));
    expect(await new RecoveryStore(join(dir, 'none')).read(newRecoveryId())).toBeNull();
  });
});

describe('Autosaver', () => {
  function setup() {
    const writes: [string, RecoveryUpdate][] = [];
    const removes: string[] = [];
    let tick: () => void = () => undefined;
    const autosaver = new Autosaver({
      write: (id, u) => (writes.push([id, u]), Promise.resolve()),
      remove: (id) => (removes.push(id), Promise.resolve()),
      setInterval: (run, ms) => {
        expect(ms).toBe(DEFAULT_AUTOSAVE_INTERVAL_MS);
        tick = run;
        return {};
      },
      clearInterval: vi.fn(),
    });
    autosaver.start();
    const runTick = async () => {
      tick();
      await autosaver.flushAll();
    };
    return { autosaver, writes, removes, tick: runTick };
  }

  it('writes the latest work once per tick, only when it changed, every 5 s by default', async () => {
    const { autosaver, writes, tick } = setup();
    autosaver.update('rs_aaaaaaaa', update('asc'));
    autosaver.update('rs_aaaaaaaa', update('desc'));
    expect(writes).toEqual([]);
    await tick();
    expect(writes).toEqual([['rs_aaaaaaaa', update('desc')]]);
    await tick();
    expect(writes).toHaveLength(1);
    expect(autosaver.hasSnapshot('rs_aaaaaaaa')).toBe(true);
  });

  it('removes the snapshot once clean, and only if one was written', async () => {
    const { autosaver, removes, tick } = setup();
    autosaver.update('rs_bbbbbbbb', null);
    await tick();
    expect(removes).toEqual([]);
    autosaver.update('rs_bbbbbbbb', update());
    await tick();
    autosaver.update('rs_bbbbbbbb', null);
    await tick();
    expect(removes).toEqual(['rs_bbbbbbbb']);
  });

  it('a save deletes the snapshot unless newer work was reported', async () => {
    const { autosaver, removes, tick } = setup();
    autosaver.update('rs_cccccccc', update('desc'));
    await tick();
    await autosaver.saved('rs_cccccccc', update('asc'));
    expect(removes).toEqual([]);
    await autosaver.saved('rs_cccccccc', update('desc'));
    expect(removes).toEqual(['rs_cccccccc']);
    // A pending update dropped by the save is not written afterwards.
    autosaver.update('rs_cccccccc', update('asc'));
    await autosaver.saved('rs_cccccccc', update('asc'));
    await tick();
    expect(autosaver.hasSnapshot('rs_cccccccc')).toBe(false);
  });

  it('stop clears the timer', () => {
    const clear = vi.fn();
    const autosaver = new Autosaver({ write: () => Promise.resolve(), remove: () => Promise.resolve(), setInterval: () => ({}), clearInterval: clear, intervalMs: 1_000 });
    autosaver.start();
    autosaver.stop();
    autosaver.stop();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
