import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { BAY_AREA_BBOX, type FlightPoint } from '@glassgrid/core';
import { describe, expect, it, vi } from 'vitest';
import { extractFixes, releaseFor, resolveRelease, splitSuffix, streamAssets, type FetchLike, type StreamedAsset } from './globe-history.ts';
import { chunksOf, makeTar } from './test-support.ts';

/*
 * The globe_history pipeline without the network: release naming, asset
 * discovery (API, then probing), resumable streaming of split parts, and
 * extraction of in-box, in-day fixes from gzipped trace files in a tar.
 */

const enc = new TextEncoder();
const DAY = Date.UTC(2026, 10, 9) / 1000;

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of source) parts.push(chunk);
  return Buffer.concat(parts);
}

/** A fake server for one asset body: honours Range, and cuts the first full transfer off after `cutAt` bytes. */
function server(body: Uint8Array, cutAt: number | null) {
  let cut = cutAt;
  const requests: (string | null)[] = [];
  const fetchImpl: FetchLike = (_url, init) => {
    const range = init?.headers?.['Range'] ?? null;
    requests.push(range);
    const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1]) : 0;
    const slice = body.subarray(start);
    const limit = cut;
    cut = null;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        if (limit === null) {
          controller.enqueue(slice);
          controller.close();
        } else if (pulls === 1) {
          controller.enqueue(slice.subarray(0, limit));
        } else {
          // The connection drops once the first chunk has been read.
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.error(new TypeError('terminated'));
        }
      },
    });
    const headers: Record<string, string> = { 'content-length': String(slice.length) };
    if (range) headers['content-range'] = `bytes ${start}-${body.length - 1}/${body.length}`;
    return Promise.resolve(new Response(stream, { status: range ? 206 : 200, headers }));
  };
  return { fetchImpl, requests };
}

describe('release naming', () => {
  it('maps a day and instance to the yearly repo and tag', () => {
    expect(releaseFor('2026-11-09', 'prod-0')).toEqual({ repo: 'adsblol/globe_history_2026', tag: 'v2026.11.09-planes-readsb-prod-0' });
    expect(() => releaseFor('2026-11-9', 'prod-0')).toThrow();
    expect([0, 1, 25, 26].map(splitSuffix)).toEqual(['aa', 'ab', 'az', 'ba']);
  });
});

describe('resolveRelease', () => {
  const ref = releaseFor('2026-11-09', 'prod-0');

  it('uses the releases API when it answers', async () => {
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve(
        Response.json({
          assets: [
            { name: `${ref.tag}.tar.ab`, size: 5, browser_download_url: 'https://x/ab', digest: 'sha256:bb' },
            { name: `${ref.tag}.tar.aa`, size: 7, browser_download_url: 'https://x/aa' },
            { name: 'notes.txt', size: 1 },
          ],
        }),
      ),
    );
    expect(await resolveRelease(ref, fetchImpl)).toEqual({
      discoveredBy: 'github-api',
      assets: [
        { name: `${ref.tag}.tar.aa`, url: 'https://x/aa', bytes: 7, githubDigest: null },
        { name: `${ref.tag}.tar.ab`, url: 'https://x/ab', bytes: 5, githubDigest: 'sha256:bb' },
      ],
    });
  });

  it('probes .tar.aa, .tar.ab, ... until a 404 when the API is refused', async () => {
    const fetchImpl = vi.fn<FetchLike>((url) => {
      if (url.startsWith('https://api.github.com/')) return Promise.resolve(new Response('forbidden', { status: 403 }));
      if (url.endsWith('.tar.aa')) return Promise.resolve(new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/2000000000' } }));
      if (url.endsWith('.tar.ab')) return Promise.resolve(new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/1723313664' } }));
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });
    const resolved = await resolveRelease(ref, fetchImpl);
    expect(resolved.discoveredBy).toBe('probe');
    expect(resolved.assets.map((a) => [a.name, a.bytes, a.url])).toEqual([
      [`${ref.tag}.tar.aa`, 2000000000, `https://github.com/adsblol/globe_history_2026/releases/download/${ref.tag}/${ref.tag}.tar.aa`],
      [`${ref.tag}.tar.ab`, 1723313664, `https://github.com/adsblol/globe_history_2026/releases/download/${ref.tag}/${ref.tag}.tar.ab`],
    ]);
  });
});

describe('streamAssets', () => {
  it('resumes a cut-off part with a Range request and hashes every byte once', async () => {
    const a = enc.encode('first part, ');
    const b = new Uint8Array(5000).map((_, i) => i % 251);
    const sa = server(a, null);
    const sb = server(b, 1234);
    const fetchImpl: FetchLike = (url, init) => (url === 'a' ? sa.fetchImpl(url, init) : sb.fetchImpl(url, init));
    const done: StreamedAsset[] = [];
    const sleep = vi.fn(() => Promise.resolve());
    const bytes = await collect(
      streamAssets(
        [
          { name: 'p.tar.aa', url: 'a', bytes: a.length, githubDigest: null },
          { name: 'p.tar.ab', url: 'b', bytes: b.length, githubDigest: null },
        ],
        done,
        { fetchImpl, sleep },
      ),
    );
    expect(Buffer.compare(Buffer.from(bytes), Buffer.concat([a, b]))).toBe(0);
    expect(sb.requests).toEqual([null, 'bytes=1234-']);
    expect(sleep).toHaveBeenCalledOnce();
    expect(done.map((d) => [d.name, d.bytes, d.resumes])).toEqual([
      ['p.tar.aa', a.length, 0],
      ['p.tar.ab', b.length, 1],
    ]);
    expect(done[1]?.sha256).toBe(createHash('sha256').update(b).digest('hex'));
  });

  it('gives up on a missing asset at once', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(new Response('Not Found', { status: 404 }));
    await expect(collect(streamAssets([{ name: 'x', url: 'x', bytes: null, githubDigest: null }], [], { fetchImpl, sleep: () => Promise.resolve() }))).rejects.toThrow(/404/);
  });
});

describe('extractFixes', () => {
  it('keeps the in-box fixes of the day from gzipped and plain trace files, and skips the rest', async () => {
    const sfo = (dt: number, extra: unknown[] = []) => [dt, 37.6189, -122.375, 1500, 150, 280, 0, -700, ...extra];
    const traces = {
      a1b2c3: { icao: 'a1b2c3', r: 'N1', t: 'B738', timestamp: DAY, trace: [sfo(10, [{ flight: 'SWA1' }]), sfo(20), [30, 40.6, -73.8, 30000, 450, 90, 0, 0]] },
      // Before the day starts and at its end (exclusive): dropped; at 00:00: kept.
      d4e5f6: { icao: 'd4e5f6', timestamp: DAY - 3600, trace: [sfo(0), sfo(3600), sfo(3600 + 86_400)] },
      // Nowhere near the box.
      '0abcde': { icao: '0abcde', timestamp: DAY, trace: [[5, 51.47, -0.45, 'ground', 0, 0, 0, null]] },
    };
    const tar = makeTar([
      { path: './heatmap/0.bin.ttf', body: new Uint8Array(3000) },
      { path: './traces/c3/trace_full_a1b2c3.json', body: gzipSync(JSON.stringify(traces.a1b2c3)) },
      { path: './traces/f6/trace_full_d4e5f6.json', body: enc.encode(JSON.stringify(traces.d4e5f6)) },
      { path: './traces/de/trace_full_0abcde.json', body: gzipSync(JSON.stringify(traces['0abcde'])) },
      { path: './traces/xx/trace_full_123456.json', body: enc.encode('{not json') },
      { path: './README', body: enc.encode('hi') },
    ]);
    const got: FlightPoint[] = [];
    const stats = await extractFixes(chunksOf(tar, 777), { bbox: BAY_AREA_BBOX, startMs: DAY * 1000, endMs: (DAY + 86_400) * 1000, onPoints: (p) => got.push(...p) });
    expect(stats).toEqual({
      tarEntries: 6,
      traceFiles: 4,
      unreadableTraceFiles: 1,
      aircraftInBox: 2,
      fixesInBox: 5,
      fixesKept: 3,
      otherPaths: ['README'],
    });
    expect(got.map((p) => [p.hex, p.ts / 1000 - DAY, p.flight, p.registration])).toEqual([
      ['a1b2c3', 10, 'SWA1', 'N1'],
      ['a1b2c3', 20, 'SWA1', 'N1'],
      ['d4e5f6', 0, null, null],
    ]);
  });
});
