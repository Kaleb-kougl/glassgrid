import type { ResultCacheStats } from '@glassgrid/core';

export const DEFAULT_RESULT_CACHE_BYTES = 256 * 1024 * 1024;

interface Entry<T> {
  value: T;
  bytes: number;
}

/**
 * LRU cache of query results, bounded by total payload bytes (Arrow IPC
 * bytes for pages; a small estimate for scalar results). Keys are the exact
 * SQL plus its bound parameters, prefixed with the table id so a table's
 * entries can be dropped together.
 *
 * A Map iterates in insertion order, so re-inserting on access keeps the
 * least recently used entry first.
 */
export class ResultCache<T = unknown> {
  private readonly entries = new Map<string, Entry<T>>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly maxBytes = DEFAULT_RESULT_CACHE_BYTES) {}

  static key(tableId: string, sql: string, params: string): string {
    return `${tableId}\u0000${sql}\u0000${params}`;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Store a value. Values larger than the whole cache are not stored. */
  set(key: string, value: T, bytes: number): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.bytes -= previous.bytes;
    }
    if (bytes > this.maxBytes) return;

    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    for (const [oldestKey, oldest] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldestKey);
      this.bytes -= oldest.bytes;
      this.evictions += 1;
    }
  }

  /** Drop every entry for one table (its source changed). */
  invalidateTable(tableId: string): void {
    const prefix = `${tableId}\u0000`;
    for (const [key, entry] of this.entries) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        this.bytes -= entry.bytes;
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  stats(): ResultCacheStats {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}
