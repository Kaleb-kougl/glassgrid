import { copyFile, open, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FINGERPRINT_EDGE_BYTES, fingerprintFile } from './fingerprint';
import { nodeFiles } from './native/files';
import { createHarness, writeFixtureCsv, type Harness } from './test-support';

const FIXED_TIME = new Date('2026-01-01T00:00:00Z');
let h: Harness;
let big: string;

beforeAll(async () => {
  h = await createHarness();
  big = join(h.dir, 'big.csv');
  await writeFixtureCsv(big, 150_000); // ~4.5 MB: head, middle and tail are distinct
  // Whole-second mtimes survive utimes() exactly, so copies can share them.
  await utimes(big, FIXED_TIME, FIXED_TIME);
});

afterAll(async () => {
  await h.dispose();
});

async function patchByte(path: string, position: number): Promise<void> {
  const info = await stat(path);
  const file = await open(path, 'r+');
  try {
    const byte = Buffer.alloc(1);
    await file.read(byte, 0, 1, position);
    byte[0] = byte[0] === 0x30 ? 0x31 : 0x30;
    await file.write(byte, 0, 1, position);
  } finally {
    await file.close();
  }
  // Restore mtime so only the content differs.
  await utimes(path, info.atime, info.mtime);
}

describe('fingerprintFile', () => {
  it('is stable across reads and has the documented shape', async () => {
    const a = await fingerprintFile(nodeFiles, big);
    const b = await fingerprintFile(nodeFiles, big);
    expect(a).toEqual(b);
    expect(a.sizeBytes).toBe((await stat(big)).size);
    expect(a.headTailSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.key).toMatch(/^[0-9a-f]{32}$/);
  });

  it('matches for a copy with the same mtime (content identity, not path)', async () => {
    const copy = join(h.dir, 'copy.csv');
    await copyFile(big, copy);
    await utimes(copy, FIXED_TIME, FIXED_TIME);
    expect((await fingerprintFile(nodeFiles, copy)).key).toBe((await fingerprintFile(nodeFiles, big)).key);
    await rm(copy);
  });

  it('changes when the mtime changes', async () => {
    const copy = join(h.dir, 'touched.csv');
    await copyFile(big, copy);
    const before = await fingerprintFile(nodeFiles, copy);
    await utimes(copy, new Date(), new Date(Date.now() + 5_000));
    expect((await fingerprintFile(nodeFiles, copy)).key).not.toBe(before.key);
  });

  it('changes when a byte in the first or last megabyte changes', async () => {
    for (const position of [10, (await stat(big)).size - 3]) {
      const copy = join(h.dir, `edge-${position}.csv`);
      await copyFile(big, copy);
      await utimes(copy, FIXED_TIME, FIXED_TIME);
      const before = await fingerprintFile(nodeFiles, copy);
      await patchByte(copy, position);
      const after = await fingerprintFile(nodeFiles, copy);
      expect(after.sizeBytes).toBe(before.sizeBytes);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.headTailSha256).not.toBe(before.headTailSha256);
      expect(after.key).not.toBe(before.key);
    }
  });

  it('does not read the middle of large files (documented trade-off)', async () => {
    const copy = join(h.dir, 'middle.csv');
    await copyFile(big, copy);
    await utimes(copy, FIXED_TIME, FIXED_TIME);
    const info = await stat(copy);
    const before = await fingerprintFile(nodeFiles, copy);
    const middle = Math.floor(info.size / 2);
    expect(middle).toBeGreaterThan(FINGERPRINT_EDGE_BYTES);
    await patchByte(copy, middle);
    expect((await fingerprintFile(nodeFiles, copy)).key).toBe(before.key);
  });

  it('handles files smaller than the edge window, including empty files', async () => {
    const small = join(h.dir, 'small.csv');
    await writeFile(small, 'a,b\n1,2\n');
    const empty = join(h.dir, 'empty.csv');
    await writeFile(empty, '');
    const a = await fingerprintFile(nodeFiles, small);
    expect(a.sizeBytes).toBe(8);
    expect((await fingerprintFile(nodeFiles, empty)).sizeBytes).toBe(0);
    expect(a.key).not.toBe((await fingerprintFile(nodeFiles, empty)).key);
  });
});
