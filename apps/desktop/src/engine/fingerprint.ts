import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import type { Fingerprint } from '@glassgrid/core';

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
 */
export async function fingerprintFile(path: string, edgeBytes = FINGERPRINT_EDGE_BYTES): Promise<Fingerprint> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Not a regular file');
    const sizeBytes = info.size;
    const mtimeMs = Math.trunc(info.mtimeMs);

    const hash = createHash('sha256');
    const headLength = Math.min(edgeBytes, sizeBytes);
    hash.update(await readRange(file, 0, headLength));
    // The tail overlaps the head for files under 2 MB; hashing both is still deterministic.
    const tailStart = Math.max(0, sizeBytes - edgeBytes);
    hash.update(await readRange(file, tailStart, sizeBytes - tailStart));
    const headTailSha256 = hash.digest('hex');

    const key = createHash('sha256')
      .update(`glassgrid-parquet-v${PARQUET_FORMAT_VERSION}\n${sizeBytes}\n${mtimeMs}\n${headTailSha256}`)
      .digest('hex')
      .slice(0, 32);

    return { sizeBytes, mtimeMs, headTailSha256, key };
  } finally {
    await file.close();
  }
}

async function readRange(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) break; // file shrank while reading
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.key === b.key;
}
