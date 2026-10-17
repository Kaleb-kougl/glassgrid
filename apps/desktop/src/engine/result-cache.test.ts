import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ResultCache } from './result-cache';
import { createHarness, writeFixtureCsv } from './test-support';

describe('ResultCache', () => {
  it('evicts least recently used entries by byte size and keeps stats', () => {
    const cache = new ResultCache<string>(100);
    cache.set('a', 'A', 40);
    cache.set('b', 'B', 40);
    expect(cache.get('a')).toBe('A'); // a is now most recent
    cache.set('c', 'C', 40); // over budget: evict b
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('A');
    expect(cache.get('c')).toBe('C');
    expect(cache.stats()).toEqual({ entries: 2, bytes: 80, maxBytes: 100, hits: 3, misses: 1, evictions: 1 });
  });

  it('does not store values larger than the whole cache, and replaces same-key entries', () => {
    const cache = new ResultCache<string>(100);
    cache.set('big', 'X', 101);
    expect(cache.stats().entries).toBe(0);
    cache.set('k', 'v1', 10);
    cache.set('k', 'v2', 30);
    expect(cache.get('k')).toBe('v2');
    expect(cache.stats().bytes).toBe(30);
  });

  it('drops a table’s entries together', () => {
    const cache = new ResultCache<string>(1000);
    cache.set(ResultCache.key('tb_1', 'SELECT 1', ''), 'x', 10);
    cache.set(ResultCache.key('tb_2', 'SELECT 1', ''), 'y', 10);
    cache.invalidateTable('tb_1');
    expect(cache.stats()).toMatchObject({ entries: 1, bytes: 10 });
  });
});

describe('QueryService result cache', () => {
  it('serves repeated pages from cache and evicts by Arrow bytes under a small cap', async () => {
    const h = await createHarness({ resultCacheMaxBytes: 40_000 });
    try {
      const path = join(h.dir, 'pages.csv');
      await writeFixtureCsv(path, 10_000);
      const { file, table } = h.register(path);
      await h.service.open(file, { parquet: 'never' });

      const first = await h.service.rows(table, { offset: 0, limit: 1000 });
      expect(first.cached).toBe(false);
      const again = await h.service.rows(table, { offset: 0, limit: 1000 });
      expect(again.cached).toBe(true);
      expect(again.value).toBe(first.value);
      const pageBytes = first.value.byteLength;
      expect(pageBytes).toBeGreaterThan(10_000);

      for (let offset = 1000; offset < 6000; offset += 1000) await h.service.rows(table, { offset, limit: 1000 });
      const stats = h.service.resultCacheStats();
      expect(stats.bytes).toBeLessThanOrEqual(40_000);
      expect(stats.evictions).toBeGreaterThan(0);
      expect(stats.hits).toBe(1);
      // The first page was evicted, so it is recomputed.
      expect((await h.service.rows(table, { offset: 0, limit: 1000 })).cached).toBe(false);
    } finally {
      await h.dispose();
    }
  });
});
