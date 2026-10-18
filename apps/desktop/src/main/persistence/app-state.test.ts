import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecentWorkspaceIdSchema } from '@glassgrid/core';
import { AppStateStore, MAX_RECENT_WORKSPACES, recentWorkspaceId } from './app-state';

let dir: string;
let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 18, 9, 0, tick++));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gg-state-'));
  tick = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function workspaceFiles(count: number): Promise<string[]> {
  const paths = Array.from({ length: count }, (_, i) => join(dir, `w${i}.glassgrid`));
  for (const path of paths) await writeFile(path, '{}');
  return paths;
}

describe('AppStateStore: recent workspaces', () => {
  it('keeps the newest first, deduplicated, at most 10, in a versioned state.json', async () => {
    const paths = await workspaceFiles(12);
    const store = new AppStateStore(join(dir, 'state.json'), { now });
    for (const path of paths) await store.recordRecentWorkspace(path);
    await store.recordRecentWorkspace(paths[5] ?? '');

    const recent = await store.listRecentWorkspaces();
    expect(recent).toHaveLength(MAX_RECENT_WORKSPACES);
    expect(recent.map((entry) => entry.fileName)).toEqual(['w5', 'w11', 'w10', 'w9', 'w8', 'w7', 'w6', 'w4', 'w3', 'w2'].map((n) => `${n}.glassgrid`));
    expect(recent[0]).toEqual({ id: recentWorkspaceId(paths[5] ?? ''), fileName: 'w5.glassgrid', directory: dir, lastOpenedAt: '2026-10-18T09:00:12.000Z' });
    expect(recent.every((entry) => RecentWorkspaceIdSchema.safeParse(entry.id).success)).toBe(true);

    const onDisk = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as { version: number; recentWorkspaces: { path: string }[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.recentWorkspaces[0]?.path).toBe(paths[5]);
    expect((await readdir(dir)).filter((name) => name.includes('tmp'))).toEqual([]);

    // A new process reads the same list back.
    const again = new AppStateStore(join(dir, 'state.json'), { now });
    expect(await again.listRecentWorkspaces()).toEqual(recent);
    expect(await again.recentWorkspacePath(recent[1]?.id ?? '')).toBe(paths[11]);
    expect(await again.recentWorkspacePath(`rw_${'0'.repeat(24)}`)).toBeUndefined();
  });

  it('prunes files that disappeared, on disk too', async () => {
    const paths = await workspaceFiles(3);
    const store = new AppStateStore(join(dir, 'state.json'), { now });
    for (const path of paths) await store.recordRecentWorkspace(path);
    await unlink(paths[1] ?? '');
    expect((await store.listRecentWorkspaces()).map((entry) => entry.fileName)).toEqual(['w2.glassgrid', 'w0.glassgrid']);
    const onDisk = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as { recentWorkspaces: unknown[] };
    expect(onDisk.recentWorkspaces).toHaveLength(2);
  });

  it('starts fresh from a corrupt or newer state file and replaces it on the next write', async () => {
    const file = join(dir, 'state.json');
    await writeFile(file, '{"version": 9, "recentWorkspaces": "?"}');
    const store = new AppStateStore(file, { now });
    expect(await store.listRecentWorkspaces()).toEqual([]);
    const [path] = await workspaceFiles(1);
    await store.recordRecentWorkspace(path ?? '');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, recentWorkspaces: [{ path }] });

    await writeFile(file, 'garbage');
    expect(await new AppStateStore(file).listRecentWorkspaces()).toEqual([]);
  });

  it('serialises concurrent writes', async () => {
    const paths = await workspaceFiles(5);
    const store = new AppStateStore(join(dir, 'state.json'), { now });
    await Promise.all(paths.map((path) => store.recordRecentWorkspace(path)));
    const again = new AppStateStore(join(dir, 'state.json'));
    expect((await again.listRecentWorkspaces()).map((entry) => entry.fileName).sort()).toEqual(paths.map((_, i) => `w${i}.glassgrid`));
  });
});
