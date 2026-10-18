import type { Fingerprint } from '@glassgrid/core';
import type { DriverFiles } from './driver';
import { sha256Hex } from './hash';

export const FINGERPRINT_EDGE_BYTES = 1024 * 1024;

/**
 * Bumped whenever the way a CSV is converted to Parquet changes (reader
 * options, column layout), so older cache entries stop matching.
 */
export const PARQUET_FORMAT_VERSION = 1;

/**
 * Fingerprint a file from its size, mtime and the SHA-256 of its first and
 * last 1 MB. Cheap on multi-GB files (reads at most 2 MB) and stable across
 * reads, renames and copies that preserve mtime; any edit that changes the
 * size, the mtime or the bytes at either end changes it.
 *
 * In the browser the "file" is a picked `File` (size and `lastModified`) or
 * a sample dataset URL (Content-Length and Last-Modified, edges read with
 * Range requests); see the WASM driver's files. The key is the same function
 * of the same inputs on every platform.
 */
export async function fingerprintFile(files: DriverFiles, path: string, edgeBytes = FINGERPRINT_EDGE_BYTES): Promise<Fingerprint> {
  const info = await files.stat(path);
  if (!info.isFile) throw new Error('Not a regular file');
  const sizeBytes = info.sizeBytes;
  const mtimeMs = Math.trunc(info.mtimeMs);

  const headLength = Math.min(edgeBytes, sizeBytes);
  const head = await files.readRange(path, 0, headLength);
  // The tail overlaps the head for files under 2 MB; hashing both is still deterministic.
  const tailStart = Math.max(0, sizeBytes - edgeBytes);
  const tail = await files.readRange(path, tailStart, sizeBytes - tailStart);
  const headTailSha256 = await files.sha256([head, tail]);

  const key = sha256Hex(`glassgrid-parquet-v${PARQUET_FORMAT_VERSION}\n${sizeBytes}\n${mtimeMs}\n${headTailSha256}`).slice(0, 32);
  return { sizeBytes, mtimeMs, headTailSha256, key };
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.key === b.key;
}
