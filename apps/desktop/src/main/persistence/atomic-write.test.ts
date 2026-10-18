import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeStaleTempFiles, TEMP_SUFFIX, writeFileAtomic } from './atomic-write';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gg-atomic-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const temps = async () => (await readdir(dir)).filter((name) => name.endsWith(TEMP_SUFFIX));

describe('writeFileAtomic', () => {
  it('creates and replaces files, leaving no temp file behind', async () => {
    const path = join(dir, 'w.glassgrid');
    await writeFileAtomic(path, 'first');
    expect(await readFile(path, 'utf8')).toBe('first');
    await writeFileAtomic(path, new TextEncoder().encode('second'));
    expect(await readFile(path, 'utf8')).toBe('second');
    await writeFileAtomic(path, '');
    expect(await readFile(path, 'utf8')).toBe('');
    expect(await temps()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('keeps an existing file\'s mode and gives new files the requested one', async () => {
    const path = join(dir, 'w.glassgrid');
    await writeFile(path, 'old');
    await chmod(path, 0o640);
    await writeFileAtomic(path, 'new');
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    const secret = join(dir, 'state.json');
    await writeFileAtomic(secret, '{}', { mode: 0o600 });
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('writes through a symlink and keeps the link', async () => {
    const real = join(dir, 'real.glassgrid');
    const link = join(dir, 'link.glassgrid');
    await writeFile(real, 'old');
    await symlink(real, link);
    await writeFileAtomic(link, 'new');
    expect(await readFile(real, 'utf8')).toBe('new');
    expect(await readlink(link)).toBe(real);
  });

  it('a failure mid-write leaves the old file untouched and removes the temp file', async () => {
    const path = join(dir, 'w.glassgrid');
    await writeFile(path, 'old content');
    const data = 'x'.repeat(10_000);
    await expect(
      writeFileAtomic(path, data, {
        chunkBytes: 1_000,
        hooks: {
          afterChunk: ({ written }) => {
            if (written >= 3_000) throw new Error('disk unplugged');
          },
        },
      }),
    ).rejects.toThrow('disk unplugged');
    expect(await readFile(path, 'utf8')).toBe('old content');
    expect(await temps()).toEqual([]);
  });

  it('a failure just before the rename leaves the old file untouched', async () => {
    const path = join(dir, 'w.glassgrid');
    await writeFile(path, 'old content');
    let tempSeen = '';
    await expect(
      writeFileAtomic(path, 'new content', {
        hooks: {
          beforeRename: async ({ tempPath }) => {
            tempSeen = await readFile(tempPath, 'utf8');
            throw new Error('power cut');
          },
        },
      }),
    ).rejects.toThrow('power cut');
    expect(tempSeen).toBe('new content');
    expect(await readFile(path, 'utf8')).toBe('old content');
    expect(await temps()).toEqual([]);
  });

  it('a process killed mid-write leaves the old file intact (fault-injection hook + SIGKILL)', async () => {
    const path = join(dir, 'w.glassgrid');
    const old = `${JSON.stringify({ formatVersion: 1, old: true })}\n`;
    await writeFile(path, old);
    // A child process writes 8 MB in 64 KB chunks and parks itself after the first one; then it is killed.
    const script = join(dir, 'writer.mts');
    await writeFile(
      script,
      `import { writeFileAtomic } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'atomic-write.ts')).href)};
const [target] = process.argv.slice(2);
await writeFileAtomic(target, 'y'.repeat(8 * 1024 * 1024), {
  chunkBytes: 64 * 1024,
  hooks: {
    afterChunk: async ({ written }) => {
      if (written === 64 * 1024) {
        process.stdout.write('mid-write\\n');
        await new Promise(() => setInterval(() => undefined, 1000));
      }
    },
  },
});
`,
    );
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script, path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('mid-write')) resolve();
      });
      child.on('exit', (code) => reject(new Error(`writer exited early (${code}): ${stderr}`)));
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;

    expect(await readFile(path, 'utf8')).toBe(old);
    const leftovers = await temps();
    expect(leftovers).toHaveLength(1);
    expect((await stat(join(dir, leftovers[0] ?? ''))).size).toBeLessThan(8 * 1024 * 1024);
    // The next write (or launch) sweeps the stray temp file once it is old enough.
    expect(await removeStaleTempFiles(dir, { minAgeMs: 60_000 })).toEqual([]);
    expect(await removeStaleTempFiles(dir, { minAgeMs: 0 })).toEqual(leftovers);
    expect(await temps()).toEqual([]);
  }, 30_000);
});

describe('removeStaleTempFiles', () => {
  it('only removes old temp files, optionally of one target', async () => {
    const old = new Date(Date.now() - 3_600_000);
    for (const name of [`.a.glassgrid.1${TEMP_SUFFIX}`, `.b.glassgrid.2${TEMP_SUFFIX}`, 'a.glassgrid', `.fresh.3${TEMP_SUFFIX}`]) {
      await writeFile(join(dir, name), 'x');
      if (!name.includes('fresh')) await utimes(join(dir, name), old, old);
    }
    expect(await removeStaleTempFiles(dir, { forName: 'a.glassgrid' })).toEqual([`.a.glassgrid.1${TEMP_SUFFIX}`]);
    expect((await removeStaleTempFiles(dir)).sort()).toEqual([`.b.glassgrid.2${TEMP_SUFFIX}`]);
    expect((await readdir(dir)).sort()).toEqual([`.fresh.3${TEMP_SUFFIX}`, 'a.glassgrid']);
    expect(await removeStaleTempFiles(join(dir, 'missing'))).toEqual([]);
  });
});
