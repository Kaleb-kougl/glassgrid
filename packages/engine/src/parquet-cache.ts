import type { ParquetCacheStats } from '@glassgrid/core';
import type { DriverFiles } from './driver';

export const DEFAULT_PARQUET_CACHE_BYTES = 20 * 1024 ** 3;
/** Temp files untouched for this long are leftovers of a crashed conversion. */
const STALE_TEMP_MS = 60 * 60 * 1000;

const ENTRY_SUFFIX = '.parquet';
const TEMP_SUFFIX = '.tmp';
const KEY_PATTERN = /^[0-9a-f]{32}$/;

export interface CacheEntry {
  key: string;
  path: string;
  sizeBytes: number;
}

/**
 * Parquet copies of CSV files, one `<fingerprint key>.parquet` per file
 * content. The folder is a rebuildable cache: deleting any part of it only
 * costs a reconversion.
 *
 * - Writes are atomic: DuckDB writes `<key>.parquet.<random>.tmp` in the
 *   same folder and the file is renamed into place only after COPY
 *   succeeds, so a crash never leaves a truncated entry behind.
 * - Recency is the entry's mtime, bumped on every hit (atime is unreliable
 *   with `noatime`/`relatime` mounts). Eviction removes the oldest entries
 *   until the total fits the cap, skipping entries open tables still read.
 */
export class ParquetCache {
  private readyPromise: Promise<void> | null = null;

  constructor(
    private readonly files: DriverFiles,
    readonly dir: string,
    readonly maxBytes = DEFAULT_PARQUET_CACHE_BYTES,
  ) {}

  /** Create the folder and drop stale temp files. Idempotent. */
  ready(): Promise<void> {
    this.readyPromise ??= (async () => {
      await this.files.mkdir(this.dir);
      await this.removeStaleTemps();
    })();
    return this.readyPromise;
  }

  pathFor(key: string): string {
    assertKey(key);
    return this.files.join(this.dir, `${key}${ENTRY_SUFFIX}`);
  }

  tempPathFor(key: string): string {
    assertKey(key);
    return this.files.join(this.dir, `${key}${ENTRY_SUFFIX}.${randomHex(6)}${TEMP_SUFFIX}`);
  }

  /** Return the entry for `key` and mark it recently used, or undefined on a miss. */
  async lookup(key: string): Promise<CacheEntry | undefined> {
    await this.ready();
    const path = this.pathFor(key);
    try {
      const info = await this.files.stat(path);
      if (!info.isFile) return undefined;
      await this.files.touch(path).catch(() => undefined);
      return { key, path, sizeBytes: info.sizeBytes };
    } catch {
      return undefined;
    }
  }

  /** Atomically move a finished temp file into place, then enforce the cap. */
  async commit(key: string, tempPath: string, protectedKeys: ReadonlySet<string> = new Set()): Promise<CacheEntry> {
    const path = this.pathFor(key);
    await this.files.rename(tempPath, path);
    const info = await this.files.stat(path);
    await this.evict(new Set([...protectedKeys, key]));
    return { key, path, sizeBytes: info.sizeBytes };
  }

  async discardTemp(tempPath: string): Promise<void> {
    await this.files.remove(tempPath);
  }

  /** Remove least recently used entries until the total size fits `maxBytes`. */
  async evict(protectedKeys: ReadonlySet<string> = new Set()): Promise<string[]> {
    const entries = await this.list();
    let total = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    const evicted: string[] = [];
    for (const entry of entries) {
      if (total <= this.maxBytes) break;
      if (protectedKeys.has(entry.key)) continue;
      await this.files.remove(entry.path);
      total -= entry.sizeBytes;
      evicted.push(entry.key);
    }
    return evicted;
  }

  /** Delete every entry except `keep`; returns the keys removed. */
  async clear(keep: ReadonlySet<string> = new Set()): Promise<string[]> {
    const removed: string[] = [];
    for (const entry of await this.list()) {
      if (keep.has(entry.key)) continue;
      await this.files.remove(entry.path);
      removed.push(entry.key);
    }
    return removed;
  }

  async stats(): Promise<ParquetCacheStats> {
    const entries = await this.list();
    return {
      files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      maxBytes: this.maxBytes,
    };
  }

  /** Entries sorted least recently used first. */
  private async list(): Promise<Array<CacheEntry & { usedAt: number }>> {
    await this.ready();
    const entries: Array<CacheEntry & { usedAt: number }> = [];
    for (const name of await this.files.readdir(this.dir)) {
      if (!name.endsWith(ENTRY_SUFFIX)) continue;
      const key = name.slice(0, -ENTRY_SUFFIX.length);
      if (!KEY_PATTERN.test(key)) continue;
      const path = this.files.join(this.dir, name);
      try {
        const info = await this.files.stat(path);
        if (info.isFile) entries.push({ key, path, sizeBytes: info.sizeBytes, usedAt: info.mtimeMs });
      } catch {
        // Removed concurrently; nothing to account for.
      }
    }
    return entries.sort((a, b) => a.usedAt - b.usedAt);
  }

  private async removeStaleTemps(): Promise<void> {
    const now = Date.now();
    for (const name of await this.files.readdir(this.dir)) {
      if (!name.endsWith(TEMP_SUFFIX)) continue;
      const path = this.files.join(this.dir, name);
      try {
        const info = await this.files.stat(path);
        if (now - info.mtimeMs > STALE_TEMP_MS) await this.files.remove(path);
      } catch {
        // Already gone.
      }
    }
  }
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error(`Invalid cache key: ${key}`);
}
