import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceFileError, type DataReference } from '@glassgrid/core';
import {
  compareFingerprints,
  dataReferencePaths,
  defaultWorkspaceName,
  findDataFile,
  readWorkspaceFile,
  relinkCandidates,
  withWorkspaceExtension,
  WorkspaceIoError,
} from './workspace-io';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gg-io-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fingerprint = { sizeBytes: 10, mtimeMs: 1_000, headTailSha256: 'a'.repeat(64), key: 'b'.repeat(32) };

describe('data reference paths', () => {
  it('records the absolute path and a forward-slash path relative to the workspace folder', () => {
    expect(dataReferencePaths('/w/project/a.glassgrid', '/w/data/trips.csv', path.posix)).toEqual({
      absolutePath: '/w/data/trips.csv',
      relativePath: '../data/trips.csv',
    });
    expect(dataReferencePaths('/w/a.glassgrid', '/w/trips.csv', path.posix).relativePath).toBe('trips.csv');
    expect(dataReferencePaths(null, '/w/trips.csv', path.posix)).toEqual({ absolutePath: '/w/trips.csv', relativePath: null });
  });

  it('uses forward slashes on Windows and no relative path across drives', () => {
    expect(dataReferencePaths('C:\\Users\\ada\\work\\a.glassgrid', 'C:\\Users\\ada\\data\\trips.csv', path.win32).relativePath).toBe('../data/trips.csv');
    expect(dataReferencePaths('C:\\work\\a.glassgrid', 'D:\\data\\trips.csv', path.win32).relativePath).toBeNull();
  });
});

describe('relinking', () => {
  const data = (overrides: Partial<DataReference> = {}): DataReference => ({
    fileName: 'trips.csv',
    absolutePath: join(dir, 'old', 'trips.csv'),
    relativePath: 'data/trips.csv',
    fingerprint,
    ...overrides,
  });

  it('tries the relative path first, then the absolute one', () => {
    const workspace = join(dir, 'moved', 'a.glassgrid');
    expect(relinkCandidates(workspace, data())).toEqual([
      { via: 'relative', path: join(dir, 'moved', 'data', 'trips.csv') },
      { via: 'absolute', path: join(dir, 'old', 'trips.csv') },
    ]);
    expect(relinkCandidates(null, data())).toEqual([{ via: 'absolute', path: join(dir, 'old', 'trips.csv') }]);
    expect(relinkCandidates(workspace, data({ relativePath: null, absolutePath: 'C:\\elsewhere\\trips.csv' })).length).toBeLessThanOrEqual(1);
  });

  it('finds the file next to a moved workspace, falls back to the absolute path, and gives up otherwise', async () => {
    const workspace = join(dir, 'moved', 'a.glassgrid');
    expect(await findDataFile(workspace, data())).toBeNull();

    await mkdir(join(dir, 'old'), { recursive: true });
    await writeFile(join(dir, 'old', 'trips.csv'), 'a\n1\n');
    expect(await findDataFile(workspace, data())).toEqual({ via: 'absolute', path: join(dir, 'old', 'trips.csv') });

    await mkdir(join(dir, 'moved', 'data'), { recursive: true });
    await writeFile(join(dir, 'moved', 'data', 'trips.csv'), 'a\n1\n');
    expect(await findDataFile(workspace, data())).toEqual({ via: 'relative', path: join(dir, 'moved', 'data', 'trips.csv') });
  });

  it('never auto-opens a file whose name differs from the saved one, or a folder', async () => {
    await mkdir(join(dir, 'old'), { recursive: true });
    await writeFile(join(dir, 'old', 'secrets.txt'), 'x');
    await mkdir(join(dir, 'old', 'trips.csv'));
    const crafted = data({ relativePath: '../old/secrets.txt', absolutePath: join(dir, 'old', 'secrets.txt') });
    expect(await findDataFile(join(dir, 'w', 'a.glassgrid'), crafted)).toBeNull();
    expect(await findDataFile(join(dir, 'w', 'a.glassgrid'), data({ relativePath: null }))).toBeNull();
  });
});

describe('fingerprint comparison', () => {
  it('reports exactly what differs, ignoring the cache key', () => {
    expect(compareFingerprints(fingerprint, { ...fingerprint, key: 'c'.repeat(32) })).toBeNull();
    expect(compareFingerprints(fingerprint, { ...fingerprint, mtimeMs: 2_000 })).toEqual({
      sizeBytes: null,
      mtimeMs: { expected: 1_000, actual: 2_000 },
      contentChanged: false,
    });
    expect(compareFingerprints(fingerprint, { ...fingerprint, sizeBytes: 11, headTailSha256: 'f'.repeat(64) })).toEqual({
      sizeBytes: { expected: 10, actual: 11 },
      mtimeMs: null,
      contentChanged: true,
    });
  });
});

describe('names', () => {
  it('derives the default workspace name from the data file', () => {
    expect(defaultWorkspaceName('/d/trips 2026.csv')).toBe('trips 2026.glassgrid');
    expect(defaultWorkspaceName('/d/sales.csv.gz')).toBe('sales.glassgrid');
    expect(defaultWorkspaceName('/d/README')).toBe('README.glassgrid');
    expect(defaultWorkspaceName('/d/.csv')).toBe('Untitled.glassgrid');
  });

  it('adds the extension when the dialog did not', () => {
    expect(withWorkspaceExtension('/d/a')).toBe('/d/a.glassgrid');
    expect(withWorkspaceExtension('/d/a.GLASSGRID')).toBe('/d/a.GLASSGRID');
    expect(withWorkspaceExtension('/d/a.csv')).toBe('/d/a.csv.glassgrid');
  });
});

describe('readWorkspaceFile', () => {
  it('distinguishes unreadable files from invalid ones', async () => {
    await expect(readWorkspaceFile(join(dir, 'missing.glassgrid'))).rejects.toThrow(new WorkspaceIoError('Could not read missing.glassgrid: the file does not exist'));
    await expect(readWorkspaceFile(dir)).rejects.toBeInstanceOf(WorkspaceIoError);
    const big = join(dir, 'big.glassgrid');
    await writeFile(big, '');
    await truncate(big, 33 * 1024 * 1024);
    await expect(readWorkspaceFile(big)).rejects.toThrow(/too large/);
    const bad = join(dir, 'bad.glassgrid');
    await writeFile(bad, 'not json');
    await expect(readWorkspaceFile(bad)).rejects.toBeInstanceOf(WorkspaceFileError);
  });
});
