import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { ensureDir, formatBytes, log } from './common.ts';

export interface CachedFile {
  url: string;
  path: string;
  bytes: number;
  sha256: string;
  fromCache: boolean;
}

interface CacheMeta {
  url: string;
  bytes: number;
  sha256: string;
  etag: string | null;
  lastModified: string | null;
  downloadedAt: string;
}

/** Cache file name: a short hash of the full URL plus the URL's base name. */
export function cacheKey(url: string): string {
  const digest = createHash('sha256').update(url).digest('hex').slice(0, 16);
  const base = path.basename(new URL(url).pathname) || 'download';
  return `${digest}-${base}`;
}

/**
 * Returns a local copy of `url` from `cacheDir`, downloading it on a miss.
 * A cache entry counts only if its sidecar `.meta.json` exists and the size
 * matches, so a half-written download is never reused.
 */
export async function fetchCached(url: string, cacheDir: string): Promise<CachedFile> {
  await ensureDir(cacheDir);
  const file = path.join(cacheDir, cacheKey(url));
  const metaFile = `${file}.meta.json`;

  try {
    const meta = JSON.parse(await readFile(metaFile, 'utf8')) as CacheMeta;
    const st = await stat(file);
    if (meta.url === url && st.size === meta.bytes) {
      return { url, path: file, bytes: meta.bytes, sha256: meta.sha256, fromCache: true };
    }
  } catch {
    // cache miss
  }

  log(`downloading ${url}`);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
    throw new Error(
      `GET ${url} failed (${err instanceof Error ? err.message : String(err)}${cause}). ` +
        'Behind a proxy? Set NODE_USE_ENV_PROXY=1. Using a mirror? Pass --base-url.',
      { cause: err },
    );
  }
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} failed: HTTP ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  const partial = `${file}.partial`;
  const hash = createHash('sha256');
  let received = 0;
  let lastReport = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      received += chunk.length;
      if (received - lastReport > 64 * 1024 * 1024) {
        lastReport = received;
        log(`  ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ''}`);
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), meter, createWriteStream(partial));
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  if (total && received !== total) {
    await rm(partial, { force: true });
    throw new Error(`GET ${url}: expected ${total} bytes, received ${received}`);
  }
  await rename(partial, file);
  const sha256 = hash.digest('hex');
  const meta: CacheMeta = {
    url,
    bytes: received,
    sha256,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    downloadedAt: new Date().toISOString(),
  };
  await writeFile(metaFile, JSON.stringify(meta, null, 2) + '\n');
  log(`  saved ${formatBytes(received)} -> ${path.relative(process.cwd(), file)}`);
  return { url, path: file, bytes: received, sha256, fromCache: false };
}
