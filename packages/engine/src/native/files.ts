import { createHash } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DriverFiles, FileInfo } from '../driver';

/** The engine's file operations on the local file system (native paths). */
export const nodeFiles: DriverFiles = {
  join: (...parts) => join(...parts),
  basename: (path) => basename(path),
  dirname: (path) => dirname(path),

  async stat(path): Promise<FileInfo> {
    const info = await stat(path);
    return { sizeBytes: info.size, mtimeMs: Math.trunc(info.mtimeMs), isFile: info.isFile() };
  },

  async readRange(path, position, length) {
    const file = await open(path, 'r');
    try {
      const buffer = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
        if (bytesRead === 0) break; // file shrank while reading
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    } finally {
      await file.close();
    }
  },

  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },

  async readdir(path) {
    try {
      return await readdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  },

  async rename(from, to) {
    await rename(from, to);
  },

  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },

  async touch(path) {
    const now = new Date();
    await utimes(path, now, now);
  },

  sha256(chunks) {
    const hash = createHash('sha256');
    for (const chunk of chunks) hash.update(chunk);
    return Promise.resolve(hash.digest('hex'));
  },
};
