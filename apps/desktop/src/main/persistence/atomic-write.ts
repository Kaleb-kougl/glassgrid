import { randomBytes } from 'node:crypto';
import { lstat, open, readdir, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/*
 * Crash-safe file replacement: write a temp file in the same folder, fsync
 * it, rename it over the target (atomic on one file system), then fsync the
 * folder so the rename itself survives a power cut. A crash at any point
 * leaves either the old file or the new one, never a half-written mix; at
 * worst a stray temp file, which `removeStaleTempFiles` sweeps up.
 *
 * Only Node built-ins and erasable TypeScript here: the fault-injection test
 * runs this file directly in a child process it then kills mid-write.
 */

/** Suffix of in-progress temp files (`.<name>.<random>.gg-tmp`). */
export const TEMP_SUFFIX = '.gg-tmp';

/** Test-only fault injection points. Throwing from a hook aborts the write. */
export interface AtomicWriteHooks {
  /** After each chunk reached the temp file, before fsync. */
  afterChunk?(info: { tempPath: string; written: number; total: number }): void | Promise<void>;
  /** After the temp file is complete and fsynced, just before the rename. */
  beforeRename?(info: { tempPath: string }): void | Promise<void>;
}

export interface AtomicWriteOptions {
  /** Permissions for a new file (default 0o666, less the umask). An existing file keeps its mode. */
  readonly mode?: number;
  /** Bytes per write call (default 1 MiB). */
  readonly chunkBytes?: number;
  readonly hooks?: AtomicWriteHooks;
}

const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

/** The temp file name used for `target` (exported for tests). */
export function tempPathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`);
}

/** Follows a symlink at `path`, so replacing the file keeps the link (and writes where it points). */
async function resolveTarget(path: string): Promise<string> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return await realpath(path);
  } catch {
    // Missing file: write it at `path`.
  }
  return path;
}

async function existingMode(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mode & 0o7777;
  } catch {
    return null;
  }
}

/** Windows may briefly lock the target (indexers, antivirus); retry a rename a few times. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || attempt >= 5 || !RETRYABLE_RENAME.has(errorCode(error) ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

/** Makes a rename durable. Not possible (and not needed) on Windows. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: FileHandle | null = null;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // Some file systems refuse to fsync a directory; the data itself is already synced.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Atomically replaces (or creates) `path` with `data`. Rejects without touching `path` if anything fails. */
export async function writeFileAtomic(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  const target = await resolveTarget(path);
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const chunkBytes = Math.max(1, options.chunkBytes ?? 1024 * 1024);
  const mode = await existingMode(target);
  const temp = tempPathFor(target);

  let handle: FileHandle | null = await open(temp, 'wx', mode ?? options.mode ?? 0o666);
  let renamed = false;
  try {
    let written = 0;
    while (written < bytes.length) {
      const length = Math.min(chunkBytes, bytes.length - written);
      const { bytesWritten } = await handle.write(bytes, written, length, written);
      written += bytesWritten;
      await options.hooks?.afterChunk?.({ tempPath: temp, written, total: bytes.length });
    }
    // open()'s mode is reduced by the umask; an existing file keeps exactly its own.
    if (mode !== null && process.platform !== 'win32') await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = null;
    await options.hooks?.beforeRename?.({ tempPath: temp });
    await renameWithRetry(temp, target);
    renamed = true;
    await syncDirectory(dirname(target));
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    if (!renamed) await unlink(temp).catch(() => undefined);
  }
}

/**
 * Deletes temp files a crashed write left in `dir` that are older than
 * `minAgeMs` (so a write in progress in another window is left alone). With
 * `forName`, only temp files of that target name. Returns the removed names.
 */
export async function removeStaleTempFiles(dir: string, options: { minAgeMs?: number; forName?: string; now?: number } = {}): Promise<string[]> {
  const minAgeMs = options.minAgeMs ?? 60_000;
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const prefix = options.forName === undefined ? '.' : `.${options.forName}.`;
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(TEMP_SUFFIX)) continue;
    const path = join(dir, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || now - info.mtimeMs < minAgeMs) continue;
      await unlink(path);
      removed.push(name);
    } catch {
      // Gone already, or not ours to delete.
    }
  }
  return removed;
}
