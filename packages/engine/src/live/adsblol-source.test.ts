import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlightBatch, FlightsApiResponse } from '@glassgrid/core';
import { AdsbLolSource, DEFAULT_LIVE_TIMEOUT_MS, backoffDelayMs, relayNoData, retryAfterMs, type LiveFetch } from './adsblol-source';

/*
 * The live source against a mocked `fetch` under Vitest's fake timers: the
 * cadence, `cache: 'no-store'`, the mapping (`now` in ms), the stale flag
 * and the 30 s staleness, 503 + Retry-After, backoff with jitter, timeouts,
 * malformed bodies, and pause/resume. Nothing here touches the network.
 */

const URL = 'https://site.example/api/flights';
const T0 = Date.parse('2026-11-10T20:00:00.000Z');

function body(overrides: Partial<FlightsApiResponse> = {}): FlightsApiResponse {
  return {
    now: Date.now(),
    fetchedAt: Date.now(),
    stale: false,
    source: 'adsb.lol',
    attribution: 'Data © adsb.lol contributors, ODbL 1.0',
    license: 'ODbL-1.0',
    ac: [
      { hex: 'A1B2C3', flight: 'UAL123  ', lat: 37.61, lon: -122.38, alt_baro: 3025, gs: 180.4, track: 280.1, seen_pos: 1.3, seen: 0.2, type: 'adsb_icao' },
      { hex: 'abc123', lat: 37.62, lon: -122.39, alt_baro: 'ground', seen_pos: 0 },
      { hex: 'def456', lat: 40.0, lon: -122.0, seen_pos: 0 }, // outside the box
      { hex: 'bad' }, // no position
    ],
    ...overrides,
  };
}

const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

interface Harness {
  source: AdsbLolSource;
  fetch: ReturnType<typeof vi.fn<LiveFetch>>;
  batches: FlightBatch[];
  /** Fake time of each fetch call, relative to the start. */
  calls(): number[];
}

function harness(
  responder: (n: number) => Response | Promise<Response>,
  options: { intervalMs?: number; random?: () => number; staleAfterMs?: number; lastPollAt?: number } = {},
): Harness {
  const times: number[] = [];
  const fetch = vi.fn<LiveFetch>((_url, _init) => {
    times.push(Date.now() - T0);
    return Promise.resolve(responder(times.length));
  });
  const batches: FlightBatch[] = [];
  const source = new AdsbLolSource({
    url: URL,
    fetch,
    sink: (batch) => {
      batches.push(batch);
      return Promise.resolve();
    },
    random: options.random ?? (() => 0),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
    ...(options.lastPollAt === undefined ? {} : { lastPollAt: options.lastPollAt }),
  });
  return { source, fetch, batches, calls: () => [...times] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AdsbLolSource', () => {
  it('polls at once, then every 20 s, with cache: no-store, and maps the aircraft (now in ms)', async () => {
    const h = harness(() => json(body()));
    expect(h.source.state().status).toBe('stopped');
    h.source.start();
    expect(h.source.state().status).toBe('connecting');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0] ?? [];
    expect(url).toBe(URL);
    expect(init).toMatchObject({ cache: 'no-store', headers: { Accept: 'application/json' } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const [batch] = h.batches;
    expect(batch?.dataClockMs).toBe(T0);
    expect(batch?.points.map((point) => [point.hex, point.ts, point.flight, point.onGround, point.source])).toEqual([
      ['a1b2c3', T0 - 1_300, 'UAL123', false, 'live'],
      ['abc123', T0, null, true, 'live'],
    ]);
    expect(h.source.state()).toMatchObject({
      status: 'live',
      attribution: 'Data © adsb.lol contributors, ODbL 1.0',
      license: 'ODbL-1.0',
      lastSuccessAt: T0,
      dataClockMs: T0,
      nextAttemptAt: T0 + 20_000,
      failures: 0,
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.calls()).toEqual([0, 20_000, 40_000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls()).toEqual([0, 20_000, 40_000, 60_000]);
    h.source.stop();
  });

  it('never polls faster than the 10 s CDN window', async () => {
    const h = harness(() => json(body()), { intervalMs: 1_000 });
    expect(h.source.intervalMs).toBe(10_000);
    h.source.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls()).toEqual([0, 10_000, 20_000, 30_000]);
    h.source.stop();
  });

  it('reports stale when the endpoint says so, and live again when it recovers', async () => {
    const h = harness((n) => json(body({ stale: n === 2 })));
    h.source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.source.state().status).toBe('live');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.source.state().status).toBe('stale');
    // Stale data is still data: it was ingested.
    expect(h.batches).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.source.state().status).toBe('live');
    h.source.stop();
  });

  it('reports stale after its threshold without a successful update', async () => {
    const h = harness(() => json(body()), { intervalMs: 60_000, staleAfterMs: 30_000 });
    h.source.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.source.state().status).toBe('live');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.source.state().status).toBe('stale');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.calls()).toEqual([0, 60_000]);
    expect(h.source.state().status).toBe('live');
    h.source.stop();
  });

  it('waits for Retry-After on a 503 (never less than 10 s), then carries on', async () => {
    const responses: Array<() => Response> = [
      () => new Response('no data', { status: 503, headers: { 'retry-after': '45' } }),
      () => new Response('no data', { status: 503, headers: { 'retry-after': '3' } }),
      () => new Response('no data', { status: 503, headers: { 'retry-after': new Date(T0 + 45_000 + 10_000 + 30_000).toUTCString() } }),
      () => json(body()),
    ];
    const h = harness((n) => (responses[n - 1] ?? (() => json(body())))());
    h.source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.source.state()).toMatchObject({ status: 'backoff', failures: 1, error: `${URL}: no data (HTTP 503)`, nextAttemptAt: T0 + 45_000 });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls()).toEqual([0, 45_000]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls()).toEqual([0, 45_000, 55_000]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls()).toEqual([0, 45_000, 55_000, 85_000]);
    expect(h.source.state()).toMatchObject({ status: 'live', failures: 0, error: null });
    expect(h.batches).toHaveLength(1);
    h.source.stop();
  });

  it('backs off exponentially with jitter on errors, and resumes the cadence after a success', async () => {
    let random = 0;
    const failing = 4;
    const h = harness((n) => (n <= failing ? Promise.reject(new TypeError('fetch failed')) : json(body())), { random: () => random });
    h.source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.source.state()).toMatchObject({ status: 'backoff', failures: 1, error: 'fetch failed' });
    // random 0: half of the ceiling (20 s, 40 s, 80 s, ...), never under 10 s.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls()).toEqual([0, 10_000]);
    random = 1; // the full ceiling from now on: 80 s after the third failure, 160 s after the fourth
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.calls()).toEqual([0, 10_000, 30_000]);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(h.calls()).toEqual([0, 10_000, 30_000, 110_000]);
    expect(h.source.state().failures).toBe(4);
    await vi.advanceTimersByTimeAsync(160_000);
    expect(h.calls()).toEqual([0, 10_000, 30_000, 110_000, 270_000]);
    expect(h.source.state()).toMatchObject({ status: 'live', failures: 0 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.calls().at(-1)).toBe(290_000);
    h.source.stop();
  });

  it('words the relay’s 503 reasons: a timeout is adsb.lol being slow, a 429 its rate limit, others their code', () => {
    expect(relayNoData(null)).toBe('no data (HTTP 503)');
    expect(relayNoData('timeout')).toBe('adsb.lol is slow to respond (HTTP 503)');
    expect(relayNoData('HTTP 429')).toBe('adsb.lol is rate-limiting the relay (HTTP 503)');
    expect(relayNoData('network ENOTFOUND')).toBe('no data: network ENOTFOUND (HTTP 503)');
  });

  it('caps the backoff at 5 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map((n) => backoffDelayMs(n, 20_000, () => 1))).toEqual([20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
    expect(backoffDelayMs(1, 10_000, () => 0)).toBe(10_000);
  });

  it('reports a 429 (and a 503 whose reason is the upstream’s HTTP 429) as rate-limited, waits for Retry-After, then recovers (L5)', async () => {
    const relay503 = (reason: string) =>
      new Response(JSON.stringify({ error: 'Live flight data is temporarily unavailable.', reason, retryAfter: 30 }), { status: 503, headers: { 'retry-after': '30', 'content-type': 'application/json' } });
    const responses: Array<() => Response> = [
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
      () => relay503('HTTP 429'),
      () => relay503('network ENOTFOUND'),
      () => new Response('slow down', { status: 429 }),
      () => json(body()),
    ];
    const h = harness((n) => (responses[n - 1] ?? (() => json(body())))());
    h.source.start();
    await vi.advanceTimersByTimeAsync(0);
    // The wait is reported as a delay too (retryDelayMs), so a reader needs no clock of its own to judge it.
    expect(h.source.state()).toMatchObject({ status: 'rate-limited', failures: 1, error: `${URL}: rate-limited (HTTP 429)`, nextAttemptAt: T0 + 120_000, retryDelayMs: 120_000 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.source.state()).toMatchObject({ status: 'rate-limited', failures: 2, error: `${URL}: adsb.lol is rate-limiting the relay (HTTP 503)`, nextAttemptAt: T0 + 150_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    // Any other reason is the relay's "no data", with its short code.
    expect(h.source.state()).toMatchObject({ status: 'backoff', failures: 3, error: `${URL}: no data: network ENOTFOUND (HTTP 503)`, retryDelayMs: 30_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    // A 429 without Retry-After backs off like any failure (random 0: half of 20 s × 2³, 80 s).
    expect(h.source.state()).toMatchObject({ status: 'rate-limited', failures: 4, nextAttemptAt: T0 + 180_000 + 80_000 });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(h.source.state()).toMatchObject({ status: 'live', failures: 0, error: null, retryDelayMs: null });
    expect(h.calls()).toEqual([0, 120_000, 150_000, 180_000, 260_000]);
    h.source.stop();
  });

  it('treats other statuses, timeouts and bodies off the contract as failures', async () => {
    const hang: LiveFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError'))));
    let mode: 'hang' | '404' | 'html' | 'shape' = 'hang';
    const fetch = vi.fn<LiveFetch>((url, init) => {
      if (mode === 'hang') return hang(url, init);
      if (mode === '404') return Promise.resolve(new Response('Not found', { status: 404 }));
      if (mode === 'html') return Promise.resolve(new Response('<!doctype html>', { status: 200 }));
      return Promise.resolve(json({ ...body(), now: 'soon' }));
    });
    const source = new AdsbLolSource({ url: URL, fetch, sink: () => Promise.resolve(), random: () => 0 });
    source.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_LIVE_TIMEOUT_MS);
    expect(source.state()).toMatchObject({ status: 'backoff', error: `${URL}: no answer within ${DEFAULT_LIVE_TIMEOUT_MS / 1000} s` });
    mode = '404';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.state()).toMatchObject({ status: 'backoff', failures: 2, error: `${URL}: HTTP 404` });
    mode = 'html';
    await vi.advanceTimersByTimeAsync(20_000);
    expect(source.state().error).toMatch(/JSON/);
    mode = 'shape';
    await vi.advanceTimersByTimeAsync(40_000);
    expect(source.state()).toMatchObject({ status: 'backoff', failures: 4 });
    expect(source.state().error).toContain('now');
    source.stop();
  });

  it('pauses (no requests, the one in flight aborted) and resumes no sooner than one interval after the last poll', async () => {
    let signal: AbortSignal | null = null;
    let hang = false;
    const fetch = vi.fn<LiveFetch>((_url, init) => {
      signal = init.signal;
      if (!hang) return Promise.resolve(json(body()));
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    const batches: FlightBatch[] = [];
    const source = new AdsbLolSource({ url: URL, fetch, sink: (batch) => Promise.resolve(void batches.push(batch)) });
    source.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Hidden 5 s after a poll, shown again 5 s later: the next poll still waits for 20 s after the last.
    source.pause();
    expect(source.state()).toMatchObject({ paused: true, status: 'live', nextAttemptAt: null });
    await vi.advanceTimersByTimeAsync(5_000);
    source.resume();
    expect(source.state()).toMatchObject({ paused: false, nextAttemptAt: T0 + 20_000 });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);

    // Hidden for ten minutes: nothing is fetched, and nothing turns stale while nobody looks.
    source.pause();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(source.state().status).toBe('live');
    source.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(3);

    // A request in flight when the page is hidden is aborted and its result dropped.
    hang = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    source.pause();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.state()).toMatchObject({ status: 'live', failures: 0, error: null });
    expect(batches).toHaveLength(3);
    source.stop();
    expect(source.state()).toMatchObject({ status: 'stopped', paused: true });
  });

  it('stop ends polling for good; start again polls at once when the last poll is 10 s old', async () => {
    const h = harness(() => json(body()));
    h.source.start();
    await vi.advanceTimersByTimeAsync(0);
    h.source.stop();
    expect(h.source.state()).toMatchObject({ status: 'stopped', nextAttemptAt: null });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.source.stop();
  });

  it('never polls sooner than 10 s after the previous poll, however often it is stopped and started', async () => {
    const h = harness(() => json(body()));
    for (let i = 0; i < 20; i += 1) {
      h.source.start();
      await vi.advanceTimersByTimeAsync(1);
      h.source.stop();
    }
    expect(h.calls()).toEqual([0]);
    h.source.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls()).toEqual([0, 10_000]);
    h.source.stop();
    // A new source told when the endpoint was last polled (the feed passes it on) waits too.
    const next = harness(() => json(body()), { lastPollAt: Date.now() - 3_000 });
    next.source.start();
    await vi.advanceTimersByTimeAsync(6_999);
    expect(next.calls()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(next.calls()).toEqual([Date.now() - T0]);
    expect(next.source.lastPollStartedAt).toBe(Date.now());
    next.source.stop();
  });

  it('does not flicker to stale between polls when the interval is longer than 30 s', async () => {
    const h = harness(() => json(body()), { intervalMs: 60_000 });
    h.source.start();
    const statuses = new Set<string>();
    for (let t = 0; t < 180_000; t += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      statuses.add(h.source.state().status);
    }
    expect(h.calls()).toEqual([0, 60_000, 120_000, 180_000]);
    expect([...statuses]).toEqual(['live']);
    h.source.stop();
    // Without polls it still turns stale: one interval, the timeout and a margin after the last success.
    const stalled = harness((n) => (n === 1 ? json(body()) : new Promise<Response>(() => undefined)), { intervalMs: 60_000 });
    stalled.source.start();
    await vi.advanceTimersByTimeAsync(60_000 + DEFAULT_LIVE_TIMEOUT_MS + 2_000);
    expect(stalled.source.state().status).not.toBe('stale');
    await vi.advanceTimersByTimeAsync(1);
    expect(stalled.source.state().status).toBe('stale');
    stalled.source.stop();
  });

  it('clamps a relay clock far ahead of this machine before it drives retention', async () => {
    const h = harness(() => json(body({ now: Date.now() + 2 * 3_600_000 })));
    h.source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.batches[0]?.dataClockMs).toBe(T0 + 5_000);
    expect(h.source.state().dataClockMs).toBe(T0 + 5_000);
    // Fix times still come from the relay's own clock, so re-reports keep matching.
    expect(h.batches[0]?.points[0]?.ts).toBe(T0 + 2 * 3_600_000 - 1_300);
    h.source.stop();
  });
});

describe('retryAfterMs', () => {
  it('reads delta seconds and HTTP dates', () => {
    expect(retryAfterMs('30', T0)).toBe(30_000);
    expect(retryAfterMs(' 7 ', T0)).toBe(7_000);
    expect(retryAfterMs(new Date(T0 + 90_000).toUTCString(), T0)).toBe(90_000);
    expect(retryAfterMs(new Date(T0 - 90_000).toUTCString(), T0)).toBe(0);
    expect(retryAfterMs('soon', T0)).toBeNull();
    expect(retryAfterMs(null, T0)).toBeNull();
  });
});
