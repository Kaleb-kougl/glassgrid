import { readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineEvent, FileHandle } from '@glassgrid/core';
import { nodeFiles } from './native/files';
import { ParquetCache } from './parquet-cache';
import { columnValues, createHarness, decode, hasParquet, writeFixtureCsv, type Harness } from './test-support';

const KEY_A = 'a'.repeat(32);
const KEY_B = 'b'.repeat(32);
const KEY_C = 'c'.repeat(32);

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.dispose();
});

async function listCache(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [])).sort();
}

async function fakeEntry(cache: ParquetCache, key: string, bytes: number, usedAtSeconds: number): Promise<void> {
  await cache.ready();
  const path = cache.pathFor(key);
  await writeFile(path, Buffer.alloc(bytes));
  await utimes(path, usedAtSeconds, usedAtSeconds);
}

describe('ParquetCache (files only)', () => {
  it('evicts least recently used entries down to the cap, sparing protected keys', async () => {
    const cache = new ParquetCache(nodeFiles, h.cacheDir, 250);
    await fakeEntry(cache, KEY_A, 100, 1_000);
    await fakeEntry(cache, KEY_B, 100, 2_000);
    await fakeEntry(cache, KEY_C, 100, 3_000);

    expect(await cache.evict(new Set([KEY_A]))).toEqual([KEY_B]);
    expect(await listCache(h.cacheDir)).toEqual([`${KEY_A}.parquet`, `${KEY_C}.parquet`]);
    expect(await cache.stats()).toEqual({ files: 2, bytes: 200, maxBytes: 250 });
  });

  it('counts a lookup as a use', async () => {
    const cache = new ParquetCache(nodeFiles, h.cacheDir, 250);
    await fakeEntry(cache, KEY_A, 100, 1_000);
    await fakeEntry(cache, KEY_B, 100, 2_000);
    await fakeEntry(cache, KEY_C, 100, 3_000);
    expect(await cache.lookup(KEY_A)).toMatchObject({ key: KEY_A, sizeBytes: 100 });
    expect(await cache.evict()).toEqual([KEY_B]);
  });

  it('never serves temp files and removes only stale ones', async () => {
    const cache = new ParquetCache(nodeFiles, h.cacheDir);
    await cache.ready();
    const stale = cache.tempPathFor(KEY_A);
    const fresh = cache.tempPathFor(KEY_B);
    await writeFile(stale, 'partial');
    await writeFile(fresh, 'partial');
    const twoHoursAgo = Date.now() / 1000 - 2 * 3600;
    await utimes(stale, twoHoursAgo, twoHoursAgo);

    expect(await cache.lookup(KEY_A)).toBeUndefined();
    await new ParquetCache(nodeFiles, h.cacheDir).ready();
    const names = await listCache(h.cacheDir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^${KEY_B}\\.parquet\\.[0-9a-f]+\\.partial$`));
  });
});

describe.skipIf(!hasParquet)('QueryService Parquet cache', () => {
  async function openCsv(rows: number, name = 'data.csv') {
    const path = join(h.dir, name);
    await writeFixtureCsv(path, rows);
    const { file, table } = h.register(path);
    return { path, file, table, handle: await h.service.open(file, { parquet: 'never' }) };
  }

  it('converts on a miss, switches the views and serves identical rows', async () => {
    const { table, handle } = await openCsv(50_000);
    const before = decode((await h.service.rows(table, { offset: 49_000, limit: 1000 })).value);
    const events: EngineEvent[] = [];
    h.service.on('event', (event) => events.push(event));

    const outcome = await h.service.ensureParquetCache(table);
    expect(outcome.alreadyCached).toBe(false);
    expect(outcome.table.usingParquetCache).toBe(true);
    expect(outcome.table.rowCount).toBe(50_000);
    expect(await listCache(h.cacheDir)).toEqual([`${handle.fingerprint.key}.parquet`]);
    expect(outcome.sizeBytes).toBe((await stat(join(h.cacheDir, `${handle.fingerprint.key}.parquet`))).size);
    expect(events.some((event) => event.type === 'parquetReady' && event.table.usingParquetCache)).toBe(true);

    const after = decode((await h.service.rows(table, { offset: 49_000, limit: 1000 })).value);
    expect(columnValues(after, 'id')).toEqual(columnValues(before, 'id'));
    expect(after.schema.fields.map((f) => String(f.type))).toEqual(before.schema.fields.map((f) => String(f.type)));
    expect((await h.service.count(table)).value).toBe(50_000);
    expect(await h.service.ensureParquetCache(table)).toMatchObject({ alreadyCached: true });
  });

  it('uses a matching Parquet copy on the next open (cache hit after restart)', async () => {
    const { path, file, table } = await openCsv(20_000);
    await h.service.ensureParquetCache(table);

    const service = await h.restart();
    service.registerFile(file, path);
    const handle = await service.open(file);
    expect(handle.usingParquetCache).toBe(true);
    expect(handle.rowCount).toBe(20_000); // from Parquet metadata, no CSV scan
    const ids = columnValues(decode((await service.rows(table, { offset: 0, limit: 3 })).value), 'id');
    expect(ids).toEqual([1, 2, 3]);
  });

  it('misses when the CSV changed, and reopening picks up the new content', async () => {
    const { path, file, table } = await openCsv(1_000);
    await h.service.ensureParquetCache(table);
    await writeFixtureCsv(path, 1_500);
    const handle = await h.service.open(file, { parquet: 'never' });
    expect(handle.usingParquetCache).toBe(false);
    expect((await h.service.count(table)).value).toBe(1_500);
  });

  it('keeps answering queries from the CSV while converting', async () => {
    const { table } = await openCsv(400_000);
    const conversion = h.service.ensureParquetCache(table);
    const page = await h.service.rows(table, { offset: 100, limit: 5 });
    expect(columnValues(decode(page.value), 'id')).toEqual([101, 102, 103, 104, 105]);
    await conversion;
  });

  it('is atomic: an interrupted conversion leaves neither an entry nor a temp file', async () => {
    const { table } = await openCsv(1_500_000);
    const conversion = h.service.ensureParquetCache(table);
    // Let COPY start writing, then clear the cache, which interrupts it.
    await waitFor(async () => (await listCache(h.cacheDir)).some((name) => name.endsWith('.partial')));
    await h.service.clearCache('parquet');
    await expect(conversion).rejects.toMatchObject({ code: 'cancelled' });
    expect(await listCache(h.cacheDir)).toEqual([]);
    const handle = await h.service.open(`fh_${table.slice(3)}` as FileHandle, { parquet: 'never' });
    expect(handle.usingParquetCache).toBe(false);
  });

  it('evicts the least recently used entry when a new conversion exceeds the cap', async () => {
    const first = await openCsv(30_000, 'first.csv');
    const firstEntry = await h.service.ensureParquetCache(first.table);
    // A fresh engine with a cap that fits one entry; the first file is no longer open.
    const service = await h.restart({ parquetCacheMaxBytes: Math.ceil(firstEntry.sizeBytes * 1.5) });
    const secondPath = join(h.dir, 'second.csv');
    await writeFixtureCsv(secondPath, 30_001);
    const second = h.register(secondPath);
    await service.open(second.file, { parquet: 'never' });
    const secondEntry = await service.ensureParquetCache(second.table);
    expect(await listCache(h.cacheDir)).toEqual([`${secondEntry.table.fingerprint.key}.parquet`]);
    expect(firstEntry.table.fingerprint.key).not.toBe(secondEntry.table.fingerprint.key);
  });

  it('does not evict entries that open tables are reading', async () => {
    const first = await openCsv(30_000, 'a.csv');
    const firstEntry = await h.service.ensureParquetCache(first.table);
    const service = await h.restart({ parquetCacheMaxBytes: 1 });
    service.registerFile(first.file, first.path);
    expect((await service.open(first.file)).usingParquetCache).toBe(true);
    const secondPath = join(h.dir, 'b.csv');
    await writeFixtureCsv(secondPath, 30_001);
    const second = h.register(secondPath);
    await service.open(second.file, { parquet: 'never' });
    await service.ensureParquetCache(second.table);
    // Both are in use, so the cap is exceeded rather than breaking a live view.
    expect(await listCache(h.cacheDir)).toHaveLength(2);
    expect(firstEntry.alreadyCached).toBe(false);
  });

  it('converts in the background on open when asked, with progress events', async () => {
    const path = join(h.dir, 'auto.csv');
    await writeFixtureCsv(path, 1_500_000);
    const { file } = h.register(path);
    const events: EngineEvent[] = [];
    h.service.on('event', (event) => events.push(event));
    const handle = await h.service.open(file, { parquet: 'always' });
    expect(handle.usingParquetCache).toBe(false);
    await waitFor(() => Promise.resolve(events.some((event) => event.type === 'parquetReady')), 60_000);
    expect(events.some((event) => event.type === 'parquetProgress')).toBe(true);
    expect((await h.service.open(file)).usingParquetCache).toBe(true);
  });

  it('clearCache points tables back at their CSVs and empties the folder', async () => {
    const { table } = await openCsv(10_000);
    await h.service.ensureParquetCache(table);
    const events: EngineEvent[] = [];
    h.service.on('event', (event) => events.push(event));
    await h.service.clearCache('all');
    expect(await listCache(h.cacheDir)).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tableUpdated' }));
    expect((await h.service.count(table)).value).toBe(10_000);
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
