import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BAY_AREA_BBOX, FlightPointSchema } from '@glassgrid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adsbLolBboxUrl, adsbLolPointUrl, backoffMs, EndpointError, recordLive, type LiveFetch } from './adsblol.ts';
import { openDuck } from './duck.ts';
import { appendFlightPoints, createFlightTable, writeFlightParquet } from './flights.ts';

/*
 * The live recorder with a mocked fetch under fake timers: no network. A
 * fake adsb.lol answers each poll with a v2-style body (`now` in ms, `ac`)
 * built from the fake clock.
 */

const T0 = Date.UTC(2026, 10, 10, 18, 0, 0);
const SFO = { lat: 37.6189, lon: -122.375 };

function aircraft(hex: string, seenPos: number, extra: Record<string, unknown> = {}) {
  return { hex, flight: 'UAL1    ', alt_baro: 3000, gs: 180, track: 280, lat: SFO.lat, lon: SFO.lon, seen_pos: seenPos, type: 'adsb_icao', ...extra };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Runs recordLive to completion while advancing the fake clock. */
async function run(fetchImpl: LiveFetch, durationMs: number, extra: Partial<Parameters<typeof recordLive>[0]> = {}) {
  const promise = recordLive({ url: adsbLolBboxUrl(BAY_AREA_BBOX), bbox: BAY_AREA_BBOX, durationMs, fetch: fetchImpl, ...extra });
  await vi.advanceTimersByTimeAsync(durationMs + 120_000);
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('endpoint', () => {
  it('builds the point query around the box centre with a radius covering the box', () => {
    expect(adsbLolBboxUrl(BAY_AREA_BBOX)).toBe('https://api.adsb.lol/v2/point/37.75/-122.25/58');
    expect(adsbLolPointUrl(37.61894, -122.375, 1000, 'http://mirror/')).toBe('http://mirror/v2/point/37.6189/-122.375/250');
    expect(() => adsbLolPointUrl(Number.NaN, 0, 10)).toThrow();
  });

  it('backs off exponentially, or as long as Retry-After says', () => {
    expect([1, 2, 3, 4, 10].map((n) => backoffMs(n, null))).toEqual([2000, 4000, 8000, 16000, 60000]);
    expect(backoffMs(1, '30')).toBe(30_000);
    expect(backoffMs(3, 'Wed, 21 Oct 2026 07:28:00 GMT')).toBe(8000);
  });
});

describe('recordLive', () => {
  it('polls every 10 s for the duration, keeps in-box fixes and drops repeated (hex, ts)', async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn<LiveFetch>(() => {
      const now = Date.now();
      calls.push(now - T0);
      // a1: a new position every poll; a2: the same fix (seen_pos grows with now) all along; a3: outside the box; a4: no position.
      return Promise.resolve(
        json({
          now,
          total: 4,
          ac: [
            aircraft('A1A1A1', 0.5),
            aircraft('a2a2a2', (now - T0) / 1000 + 2),
            aircraft('a3a3a3', 0, { lat: 40.6, lon: -73.8 }),
            { hex: 'a4a4a4', seen: 1 },
          ],
        }),
      );
    });
    const result = await run(fetchImpl, 60_000);
    expect(calls).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000]);
    expect(result.polls).toBe(6);
    expect(result.okPolls).toBe(6);
    expect(result.errors).toEqual([]);
    expect(result.points.filter((p) => p.hex === 'a1a1a1').map((p) => p.ts - T0)).toEqual([-500, 9500, 19500, 29500, 39500, 49500]);
    expect(result.points.filter((p) => p.hex === 'a2a2a2').map((p) => p.ts - T0)).toEqual([-2000]);
    expect(result.points.some((p) => p.hex === 'a3a3a3' || p.hex === 'a4a4a4')).toBe(false);
    expect(result.skipped).toBe(12);
    for (const p of result.points) {
      expect(FlightPointSchema.parse(p).source).toBe('live');
      expect(p.flight).toBe('UAL1');
    }
  });

  it('backs off on 429 (honouring Retry-After) and on 5xx, then resumes on the 10 s grid', async () => {
    const calls: number[] = [];
    let n = 0;
    const fetchImpl = vi.fn<LiveFetch>(() => {
      calls.push(Date.now() - T0);
      n += 1;
      if (n === 2) return Promise.resolve(new Response('slow down', { status: 429, headers: { 'retry-after': '25' } }));
      if (n === 3) return Promise.resolve(new Response('oops', { status: 503 }));
      if (n === 4) return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(json({ now: Date.now(), ac: [aircraft('a1a1a1', 0)] }));
    });
    const result = await run(fetchImpl, 120_000);
    // 0 ok; 10 s 429 → wait 25 s → 40 s; 503 (2nd failure: 4 s) → 50 s; network error (3rd: 8 s) → 60 s; then every 10 s.
    expect(calls).toEqual([0, 10_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000, 100_000, 110_000]);
    expect(result.errors.map((e) => e.status)).toEqual([429, 503, null]);
    expect(result.okPolls).toBe(7);
    expect(result.points).toHaveLength(7);
  });

  it('treats a body without now/ac as a failed poll, and stops on a 404 (a wrong endpoint)', async () => {
    let n = 0;
    const flaky = vi.fn<LiveFetch>(() => {
      n += 1;
      return Promise.resolve(n === 1 ? json({ msg: 'unknown' }) : json({ now: Date.now(), ac: [] }));
    });
    const result = await run(flaky, 30_000);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/no now\/ac/);

    const missing = vi.fn<LiveFetch>(() => Promise.resolve(new Response('not found', { status: 404 })));
    const promise = recordLive({ url: 'https://api.adsb.lol/v2/nope', bbox: BAY_AREA_BBOX, durationMs: 30_000, fetch: missing });
    const assertion = expect(promise).rejects.toBeInstanceOf(EndpointError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging request and carries on', async () => {
    let n = 0;
    const fetchImpl = vi.fn<LiveFetch>((_url, init) => {
      n += 1;
      if (n === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return Promise.resolve(json({ now: Date.now(), ac: [aircraft('a1a1a1', 0)] }));
    });
    const result = await run(fetchImpl, 30_000, { timeoutMs: 5_000 });
    expect(result.errors[0]?.message).toMatch(/aborted/);
    expect(result.okPolls).toBeGreaterThan(0);
  });
});

describe('writing live points', () => {
  it('writes them as Parquet in the flight-point layout, sorted by time', async () => {
    vi.useRealTimers();
    const fetchImpl: LiveFetch = () => Promise.resolve(json({ now: T0, ac: [aircraft('b2b2b2', 1), aircraft('a1a1a1', 2, { alt_baro: 'ground' })] }));
    const { points } = await recordLive({ url: 'x', bbox: BAY_AREA_BBOX, durationMs: 1, fetch: fetchImpl, now: () => T0, sleep: () => Promise.resolve() });
    const dir = await mkdtemp(path.join(tmpdir(), 'glassgrid-flights-'));
    const duck = await openDuck({ tempDirectory: dir, threads: 1 });
    try {
      await createFlightTable(duck.conn, 'points');
      const appender = await duck.conn.createAppender('points');
      appendFlightPoints(appender, [...points, ...points]);
      appender.flushSync();
      appender.closeSync();
      const written = await writeFlightParquet(duck.conn, 'points', path.join(dir, 'live.parquet'));
      expect(written.rows).toBe(2);
      expect(written.columns.map((c) => c.name)).toEqual([
        'ts', 'hex', 'flight', 'registration', 'typeCode', 'lat', 'lon', 'altBaroFt', 'altGeomFt', 'onGround',
        'gsKt', 'trackDeg', 'baroRateFpm', 'geomRateFpm', 'category', 'squawk', 'posType', 'source',
      ]);
      expect(written.columns[0]?.type).toBe('TIMESTAMP');
      const rows = (await duck.conn.runAndReadAll(`SELECT epoch_ms(ts) AS ms, hex, "onGround", "altBaroFt", source FROM read_parquet('${path.join(dir, 'live.parquet')}')`)).getRowObjectsJson();
      expect(rows).toEqual([
        { ms: String(T0 - 2000), hex: 'a1a1a1', onGround: true, altBaroFt: null, source: 'live' },
        { ms: String(T0 - 1000), hex: 'b2b2b2', onGround: false, altBaroFt: 3000, source: 'live' },
      ]);
    } finally {
      duck.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
