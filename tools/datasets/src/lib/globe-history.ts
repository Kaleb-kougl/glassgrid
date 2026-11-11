/**
 * adsb.lol `globe_history` releases: finding a day's tar parts, streaming
 * them as one tar (resuming a part with an HTTP Range request when a
 * transfer is cut off), and pulling the fixes inside a box out of the trace
 * files on the fly. Nothing is written to disk but the extracted points.
 *
 * A release (e.g. `v2026.11.09-planes-readsb-prod-0` in
 * github.com/adsblol/globe_history_2026) is one tar split into parts
 * `<tag>.tar.aa`, `<tag>.tar.ab`, ... that concatenate to the tar. It holds
 * `heatmap/*` and `traces/<xx>/trace_full_<hex>.json`: one readsb trace
 * file per aircraft seen that day, gzip-compressed despite the name
 * (README-json.md, "trace jsons").
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { gunzipSync } from 'node:zlib';
import { fromTrace, type FlightBbox, type FlightPoint } from '@glassgrid/core';
import { readTar } from './tar.ts';

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; method?: string }) => Promise<Response>;

export interface ReleaseRef {
  /** GitHub `owner/name`, e.g. `adsblol/globe_history_2026`. */
  repo: string;
  /** Release tag, e.g. `v2026.11.09-planes-readsb-prod-0`. */
  tag: string;
}

/** The release that holds `date` (YYYY-MM-DD, a UTC day) for a readsb instance such as `prod-0`. */
export function releaseFor(date: string, release: string): ReleaseRef {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`--date must be YYYY-MM-DD, got "${date}"`);
  if (!/^[a-z0-9-]+$/.test(release)) throw new Error(`--release must look like prod-0, got "${release}"`);
  const [, y, mo, d] = m;
  return { repo: `adsblol/globe_history_${y}`, tag: `v${y}.${mo}.${d}-planes-readsb-${release}` };
}

export function releasePageUrl(ref: ReleaseRef): string {
  return `https://github.com/${ref.repo}/releases/tag/${ref.tag}`;
}

export function assetDownloadUrl(ref: ReleaseRef, name: string): string {
  return `https://github.com/${ref.repo}/releases/download/${ref.tag}/${name}`;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  /** Size in bytes, when GitHub reported it before the download. */
  bytes: number | null;
  /** GitHub's own `sha256:` digest of the asset, when the API gave one. */
  githubDigest: string | null;
}

export interface ResolvedRelease {
  assets: ReleaseAsset[];
  /** `github-api` (the releases API listed the assets) or `probe` (found by trying `.tar.aa`, `.tar.ab`, ... until a 404). */
  discoveredBy: 'github-api' | 'probe';
}

/** `aa`, `ab`, ..., `zz`: the suffixes `split` gives its parts. */
export function splitSuffix(index: number): string {
  const a = 'a'.charCodeAt(0);
  return String.fromCharCode(a + Math.floor(index / 26), a + (index % 26));
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already closed
  }
}

/**
 * The tar parts of a release, in order. Tries the GitHub releases API first;
 * when it is unavailable (rate limits, or a network that only allows release
 * downloads) probes `<tag>.tar.aa`, `.ab`, ... with one-byte Range requests.
 */
export async function resolveRelease(ref: ReleaseRef, fetchImpl: FetchLike = fetch): Promise<ResolvedRelease> {
  const prefix = `${ref.tag}.tar.`;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${ref.repo}/releases/tags/${ref.tag}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const json = (await res.json()) as { assets?: { name?: unknown; size?: unknown; digest?: unknown; browser_download_url?: unknown }[] };
      const assets = (json.assets ?? [])
        .filter((a): a is { name: string; size?: unknown; digest?: unknown; browser_download_url?: unknown } => typeof a.name === 'string' && a.name.startsWith(prefix))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((a) => ({
          name: a.name,
          url: typeof a.browser_download_url === 'string' ? a.browser_download_url : assetDownloadUrl(ref, a.name),
          bytes: typeof a.size === 'number' ? a.size : null,
          githubDigest: typeof a.digest === 'string' ? a.digest : null,
        }));
      if (assets.length > 0) return { assets, discoveredBy: 'github-api' };
    } else {
      await discard(res);
    }
  } catch {
    // fall through to probing
  }

  const assets: ReleaseAsset[] = [];
  for (let i = 0; i < 26 * 26; i += 1) {
    const name = `${prefix}${splitSuffix(i)}`;
    const url = assetDownloadUrl(ref, name);
    const res = await fetchImpl(url, { headers: { Range: 'bytes=0-0' } });
    await discard(res);
    if (res.status === 404) break;
    if (res.status !== 206 && res.status !== 200) throw new Error(`GET ${url}: HTTP ${res.status}`);
    const total = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1];
    assets.push({ name, url, bytes: total === undefined ? null : Number(total), githubDigest: null });
  }
  if (assets.length === 0) throw new Error(`No ${prefix}* assets in ${releasePageUrl(ref)} (is the release published yet?)`);
  return { assets, discoveredBy: 'probe' };
}

export interface StreamedAsset {
  name: string;
  url: string;
  bytes: number;
  sha256: string;
  /** Times the transfer was resumed after a failure. */
  resumes: number;
}

export interface StreamOptions {
  fetchImpl?: FetchLike;
  /** Retries per part before giving up (default 8). */
  maxRetries?: number;
  /** Waits between retries (default: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (bytes: number) => void;
  onRetry?: (asset: string, offset: number, error: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The bytes of `assets`, one after the other, as one stream. A part that
 * fails mid-transfer is re-requested from the byte it stopped at
 * (`Range: bytes=<offset>-`, which must be answered with a 206 starting
 * there), with exponential backoff. Each part's size and SHA-256 are pushed
 * to `done` as it completes.
 */
export async function* streamAssets(assets: readonly ReleaseAsset[], done: StreamedAsset[], options: StreamOptions = {}): AsyncGenerator<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? 8;
  let streamed = 0;
  for (const asset of assets) {
    const hash = createHash('sha256');
    let offset = 0;
    let failures = 0;
    let resumes = 0;
    let total = asset.bytes;
    for (;;) {
      try {
        const res = await fetchImpl(asset.url, offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : undefined);
        if (offset > 0) {
          const range = res.headers.get('content-range') ?? '';
          if (res.status !== 206 || !range.startsWith(`bytes ${offset}-`)) {
            await discard(res);
            throw new Error(`resume at ${offset}: HTTP ${res.status} ${range}`);
          }
          const t = /\/(\d+)$/.exec(range)?.[1];
          if (t !== undefined) total ??= Number(t);
        } else {
          if (!res.ok) {
            await discard(res);
            const err = new Error(`GET ${asset.url}: HTTP ${res.status}`);
            if (res.status === 404 || res.status === 403) throw Object.assign(err, { fatal: true });
            throw err;
          }
          const len = res.headers.get('content-length');
          if (len !== null && total === null) total = Number(len);
        }
        if (!res.body) throw new Error(`GET ${asset.url}: no body`);
        for await (const chunk of Readable.fromWeb(res.body as WebReadableStream<Uint8Array>) as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
          offset += chunk.length;
          streamed += chunk.length;
          options.onProgress?.(streamed);
          yield chunk;
        }
        if (total !== null && offset !== total) throw new Error(`${asset.name}: connection closed at ${offset} of ${total} bytes`);
        break;
      } catch (err) {
        if ((err as { fatal?: boolean }).fatal === true) throw err;
        failures += 1;
        if (failures > maxRetries) throw new Error(`${asset.name}: giving up after ${maxRetries} retries at byte ${offset}`, { cause: err });
        options.onRetry?.(asset.name, offset, err);
        if (offset > 0) resumes += 1;
        await sleep(Math.min(60_000, 1000 * 2 ** (failures - 1)));
      }
    }
    done.push({ name: asset.name, url: asset.url, bytes: offset, sha256: hash.digest('hex'), resumes });
  }
}

/** `traces/<xx>/trace_full_<hex>.json`, the per-aircraft full-day traces. */
export const TRACE_PATH = /^traces\/[^/]+\/trace_full_(~?[0-9a-f]{6})\.json$/;

export interface ExtractStats {
  tarEntries: number;
  traceFiles: number;
  /** Trace files that could not be gunzipped or parsed. */
  unreadableTraceFiles: number;
  /** Trace files with at least one kept fix. */
  aircraftInBox: number;
  /** Fixes in the box (all times) and those kept (inside the day). */
  fixesInBox: number;
  fixesKept: number;
  /** The first few paths outside `traces/` and `heatmap/` (`acas/`, README and licence files; a format change would show up here). */
  otherPaths: string[];
}

export interface ExtractOptions {
  bbox: FlightBbox;
  /** Keep fixes with startMs <= ts < endMs. */
  startMs: number;
  endMs: number;
  /** Receives each trace file's kept fixes. */
  onPoints: (points: FlightPoint[]) => void;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Walks a globe_history tar stream and hands the in-box, in-day fixes of every trace file to `onPoints`. */
export async function extractFixes(tar: AsyncIterable<Uint8Array>, options: ExtractOptions): Promise<ExtractStats> {
  const stats: ExtractStats = { tarEntries: 0, traceFiles: 0, unreadableTraceFiles: 0, aircraftInBox: 0, fixesInBox: 0, fixesKept: 0, otherPaths: [] };
  const decoder = new TextDecoder('utf-8');
  for await (const entry of readTar(tar, { wantBody: (h) => h.typeflag === '0' && TRACE_PATH.test(h.path) })) {
    stats.tarEntries += 1;
    if (entry.body === null) {
      if (entry.path !== '' && !entry.path.startsWith('heatmap/') && !entry.path.startsWith('traces/') && stats.otherPaths.length < 10) {
        stats.otherPaths.push(entry.path);
      }
      continue;
    }
    stats.traceFiles += 1;
    let json: unknown;
    try {
      json = JSON.parse(decoder.decode(isGzip(entry.body) ? gunzipSync(entry.body) : entry.body));
    } catch {
      stats.unreadableTraceFiles += 1;
      continue;
    }
    const inBox = fromTrace(json, { bbox: options.bbox });
    if (inBox.length === 0) continue;
    stats.fixesInBox += inBox.length;
    const kept = inBox.filter((p) => p.ts >= options.startMs && p.ts < options.endMs);
    if (kept.length === 0) continue;
    stats.aircraftInBox += 1;
    stats.fixesKept += kept.length;
    options.onPoints(kept);
  }
  return stats;
}
