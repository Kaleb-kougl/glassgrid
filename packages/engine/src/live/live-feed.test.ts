import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EngineResponseSchema,
  INITIAL_LIVE_STATE,
  LiveStateSchema,
  type EngineResponse,
  type FlightPoint,
  type FlightsApiResponse,
  type LiveClock,
  type LiveState,
} from '@glassgrid/core';
import { QueryService, type QueryServiceOptions } from '../query-service';
import { EngineSession } from '../session';
import { testDriver } from '../test-support';
import type { LiveFetch } from './adsblol-source';
import { memoryFixtureReader } from './replay-source';

/*
 * The live feed through the engine protocol (EngineSession on the real
 * driver): liveStart / liveStop / liveSetSource / liveState /
 * liveVisibility, `liveState` events to every connection, dedup of a
 * re-polled response, table resets when the source changes, visibility
 * across connections, and `not_implemented` on hosts without live data.
 * Timers run on a manual clock, the endpoint is a mocked fetch.
 */

const T0 = Date.parse('2026-11-10T20:00:00.000Z');
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassgrid-live-feed-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Timers that fire only when the test says so (`fire`: the earliest one). */
function manualClock() {
  let now = T0;
  let nextId = 0;
  let failTimers = false;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: LiveClock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      if (failTimers) throw new Error('no timers left');
      nextId += 1;
      timers.set(nextId, { at: now + ms, callback });
      return nextId;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  };
  return {
    clock,
    /** Run the earliest timer (moving time to it). */
    fire() {
      const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined || !timer) throw new Error('no timer');
      timers.delete(id);
      now = Math.max(now, timer.at);
      timer.callback();
    },
    get now() {
      return now;
    },
    /** When the earliest timer is due, or null. */
    get nextAt() {
      const ats = [...timers.values()].map((timer) => timer.at);
      return ats.length === 0 ? null : Math.min(...ats);
    },
    /** Make every setTimeout throw (a source that cannot start). */
    set failing(value: boolean) {
      failTimers = value;
    },
  };
}

function apiBody(nowMs: number, seenPos: number): FlightsApiResponse {
  return {
    now: nowMs,
    fetchedAt: nowMs,
    stale: false,
    source: 'adsb.lol',
    attribution: 'Data © adsb.lol contributors, ODbL 1.0',
    license: 'ODbL-1.0',
    ac: [
      { hex: 'a1b2c3', flight: 'UAL1', lat: 37.612344, lon: -122.381236, alt_baro: 3_000, seen_pos: seenPos },
      { hex: 'a1b2c4', flight: 'SWA2', lat: 37.7, lon: -122.2, alt_baro: 'ground', seen_pos: seenPos + 0.5 },
    ],
  };
}

function archivePoint(ts: number, hex: string): FlightPoint {
  return { ...{ ts, hex, flight: null, registration: null, typeCode: null, lat: 37.5, lon: -122.1, altBaroFt: null, altGeomFt: null, onGround: true }, gsKt: null, trackDeg: null, baroRateFpm: null, geomRateFpm: null, category: null, squawk: null, posType: null, source: 'archive' };
}

const FIXTURE = [archivePoint(T0 - 86_400_000, 'b00001'), archivePoint(T0 - 86_400_000 + 1_000, 'b00002'), archivePoint(T0 - 86_400_000 + 60_000, 'b00001')];

async function engine(live: QueryServiceOptions['live']) {
  return QueryService.create(await testDriver(), { cacheDir: join(dir, `c${Math.random()}`, 'parquet'), ...(live === undefined ? {} : { live }) });
}

function connect(service: QueryService) {
  const sent: EngineResponse[] = [];
  const session = new EngineSession(Promise.resolve(service), (message) => sent.push(message));
  let next = 0;
  const request = async (body: Record<string, unknown>) => {
    next += 1;
    const requestId = `q${next}`;
    session.handle({ ...body, requestId });
    for (let i = 0; i < 2_000; i += 1) {
      const reply = sent.find((m) => m.kind !== 'event' && m.requestId === requestId);
      if (reply) return reply;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no reply to ${requestId}`);
  };
  const states = () => sent.flatMap((m) => (m.kind === 'event' && m.event.type === 'liveState' ? [m.event.state] : []));
  const until = async (predicate: (state: LiveState) => boolean) => {
    for (let i = 0; i < 2_000; i += 1) {
      const state = states().at(-1);
      if (state && predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no such state; last: ${JSON.stringify(states().at(-1))}`);
  };
  return { session, sent, request, states, until };
}

describe('the live feed through the engine protocol', () => {
  it('answers not_implemented on a host without live data or fixtures', async () => {
    const service = await engine(undefined);
    const a = connect(service);
    expect(await a.request({ kind: 'liveState' })).toEqual({ kind: 'liveState', requestId: 'q1', state: INITIAL_LIVE_STATE });
    expect(await a.request({ kind: 'liveStart', source: { kind: 'live' } })).toMatchObject({ kind: 'error', code: 'not_implemented' });
    expect(await a.request({ kind: 'liveSetSource', source: { kind: 'replay', fixture: 'flights-bay-30min' } })).toMatchObject({ kind: 'error', code: 'not_implemented' });
    expect(await a.request({ kind: 'liveStart', source: { kind: 'live', intervalMs: 1_000 } })).toMatchObject({ kind: 'error', code: 'bad_request' });
    expect(await a.request({ kind: 'liveVisibility', visible: false })).toMatchObject({ kind: 'ack' });
    a.session.dispose();
    service.close();
  });

  it('polls, ingests once per fix across polls, reports to every connection, and switches sources', async () => {
    const time = manualClock();
    const urls: string[] = [];
    const fetch: LiveFetch = (url, init) => {
      urls.push(`${url} ${init.cache}`);
      // Each poll: the same two fixes, re-reported 20 s later with seen_pos 20 s larger (and a rounding wobble).
      const polls = urls.length - 1;
      return Promise.resolve(new Response(JSON.stringify(apiBody(time.now, 0.3 + polls * 20 + (polls % 2) * 0.004))));
    };
    const service = await engine({ url: 'https://site.example/api/flights', fetch, clock: time.clock, fixtureReader: () => Promise.resolve(memoryFixtureReader(FIXTURE)) });
    const a = connect(service);
    const b = connect(service);

    const started = await a.request({ kind: 'liveStart', source: { kind: 'live' } });
    expect(started).toMatchObject({ kind: 'liveState', state: { source: { kind: 'live' }, feed: { kind: 'live', status: 'connecting' }, rowCount: 0 } });
    time.fire();
    await a.until((state) => state.rowCount === 2);
    expect(urls).toEqual(['https://site.example/api/flights no-store']);
    // The other connection sees the same events.
    expect(b.states().at(-1)).toMatchObject({ rowCount: 2, feed: { status: 'live', attribution: 'Data © adsb.lol contributors, ODbL 1.0' }, lastBatch: { received: 2, inserted: 2, expired: 0 } });

    for (let poll = 1; poll <= 3; poll += 1) {
      time.fire();
      await a.until((state) => state.lastBatch?.dataClockMs === T0 + poll * 20_000);
    }
    expect(urls).toHaveLength(4);
    expect(a.states().at(-1)).toMatchObject({ rowCount: 2, lastBatch: { received: 2, inserted: 0 } });

    // Stop keeps the rows; starting the same live source again keeps them too.
    expect(await a.request({ kind: 'liveStop' })).toMatchObject({ state: { feed: { status: 'stopped' }, rowCount: 2 } });
    expect(await b.request({ kind: 'liveStart', source: { kind: 'live', intervalMs: 30_000 } })).toMatchObject({ state: { rowCount: 2, source: { intervalMs: 30_000 } } });

    // Switching a running feed to a replay empties the table and plays the fixture.
    const switched = await a.request({ kind: 'liveSetSource', source: { kind: 'replay', fixture: 'flights-bay-30min', intervalMs: 1_000, speed: 120, retentionMs: null } });
    expect(switched).toMatchObject({ state: { source: { kind: 'replay' }, feed: { kind: 'replay', status: 'connecting' }, rowCount: 0 } });
    time.fire();
    await a.until((state) => state.feed?.kind === 'replay' && state.lastBatch !== null);
    time.fire();
    const done = await a.until((state) => state.feed?.ended === true);
    expect(done).toMatchObject({ rowCount: 3, feed: { status: 'stopped' } });
    expect((await service.live.flightStore?.points())?.map((point) => point.hex)).toEqual(['b00001', 'b00001', 'b00002']);

    // setSource on a stopped feed only chooses; the next start uses it.
    await a.request({ kind: 'liveStop' });
    // (The replay's state no longer describes the chosen source, so there is none until it starts.)
    expect(await a.request({ kind: 'liveSetSource', source: { kind: 'live' } })).toMatchObject({ state: { source: { kind: 'live' }, feed: null, rowCount: 0 } });
    a.session.dispose();
    b.session.dispose();
    service.close();
  });

  it('pauses while every connection that reported is hidden', async () => {
    const time = manualClock();
    let polls = 0;
    const fetch: LiveFetch = () => {
      polls += 1;
      return Promise.resolve(new Response(JSON.stringify(apiBody(time.now, 0))));
    };
    const service = await engine({ url: 'https://site.example/api/flights', fetch, clock: time.clock });
    const page = connect(service);
    const other = connect(service);
    await page.request({ kind: 'liveStart', source: { kind: 'live' } });
    time.fire();
    await page.until((state) => state.lastBatch !== null);

    expect(await page.request({ kind: 'liveVisibility', visible: false })).toMatchObject({ kind: 'ack' });
    // `other` never reported its visibility, so it does not keep the feed running.
    expect(page.states().at(-1)?.feed).toMatchObject({ paused: true, nextAttemptAt: null });
    expect(() => time.fire()).toThrow('no timer');
    expect(polls).toBe(1);

    await other.request({ kind: 'liveVisibility', visible: true });
    expect(page.states().at(-1)?.feed).toMatchObject({ paused: false });
    await other.request({ kind: 'liveVisibility', visible: false });
    expect(page.states().at(-1)?.feed?.paused).toBe(true);
    // The hidden page goes away: the other one (hidden too) still holds the pause; then it goes too.
    page.session.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.live.paused).toBe(true);
    other.session.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.live.paused).toBe(false);
    time.fire();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(polls).toBe(2);
    service.close();
  });

  it('never polls the endpoint more than once per 10 s, whatever start, stop and setSource do', async () => {
    const time = manualClock();
    let polls = 0;
    const fetch: LiveFetch = () => {
      polls += 1;
      return Promise.resolve(new Response(JSON.stringify(apiBody(time.now, 0))));
    };
    const service = await engine({ url: 'https://site.example/api/flights', fetch, clock: time.clock });
    const a = connect(service);
    await a.request({ kind: 'liveStart', source: { kind: 'live' } });
    time.fire();
    await a.until((state) => state.lastBatch !== null);
    for (let i = 0; i < 10; i += 1) {
      await a.request({ kind: 'liveStop' });
      await a.request({ kind: 'liveStart', source: { kind: 'live', intervalMs: 10_000 + i * 1_000 } });
      await a.request({ kind: 'liveSetSource', source: { kind: 'live', intervalMs: 30_000 } });
    }
    // Every new source waits for 10 s after the first poll; nothing is due before that.
    expect(time.nextAt).toBe(T0 + 10_000);
    expect(polls).toBe(1);
    a.session.dispose();
    service.close();
  });

  it('replays at a fractional speed with whole-millisecond clocks and every state on the contract', async () => {
    const time = manualClock();
    const service = await engine({ clock: time.clock, fixtureReader: () => Promise.resolve(memoryFixtureReader(FIXTURE)) });
    const a = connect(service);
    await a.request({ kind: 'liveStart', source: { kind: 'replay', fixture: 'flights-bay-30min', intervalMs: 1_000, speed: 1.0005, retentionMs: 3_600_000 } });
    for (let tick = 0; tick < 70 && !a.states().at(-1)?.feed?.ended; tick += 1) {
      const before = a.states().length;
      time.fire();
      await a.until(() => a.states().length > before && a.states().at(-1)?.feed?.status !== 'connecting');
    }
    const last = a.states().at(-1);
    expect(last).toMatchObject({ rowCount: 3, ingestError: null, feed: { ended: true } });
    for (const state of a.states()) expect(LiveStateSchema.safeParse(state).success).toBe(true);
    // The reply the client validates (before the fix, fractional clocks made it fail and the client hung).
    expect(EngineResponseSchema.safeParse(await a.request({ kind: 'liveState' })).success).toBe(true);
    a.session.dispose();
    service.close();
  });

  it('keeps the rows of the same live source when restarting it fails, and reports a consistent state after setSource', async () => {
    const time = manualClock();
    const fetch: LiveFetch = () => Promise.resolve(new Response(JSON.stringify(apiBody(time.now, 0))));
    const service = await engine({ url: 'https://site.example/api/flights', fetch, clock: time.clock, fixtureReader: () => Promise.resolve(memoryFixtureReader(FIXTURE)) });
    const a = connect(service);
    await a.request({ kind: 'liveStart', source: { kind: 'live' } });
    time.fire();
    await a.until((state) => state.rowCount === 2);
    time.failing = true;
    expect(await a.request({ kind: 'liveStart', source: { kind: 'live', intervalMs: 30_000 } })).toMatchObject({ kind: 'error' });
    time.failing = false;
    expect(service.live.state().rowCount).toBe(2);

    // Stopped, then another source chosen: the table and the feed state both start afresh.
    await a.request({ kind: 'liveStop' });
    const chosen = await a.request({ kind: 'liveSetSource', source: { kind: 'replay', fixture: 'flights-bay-30min' } });
    expect(chosen).toMatchObject({ state: { source: { kind: 'replay' }, feed: null, rowCount: 0 } });
    a.session.dispose();
    service.close();
  });
});
