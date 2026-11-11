import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EngineResponseSchema,
  LIVE_FLIGHTS_FINGERPRINT,
  LIVE_FLIGHTS_HANDLE,
  LIVE_FLIGHTS_TABLE_ID,
  compileWhere,
  type EngineEvent,
  type EngineResponse,
  type FlightPoint,
  type LiveClock,
} from '@glassgrid/core';
import { QueryService, type QueryServiceOptions } from '../query-service';
import { EngineSession, prepareCrossfilter, runAggregate, runMapQuery, toFragment } from '../session';
import { columnValues, decode, testDriver } from '../test-support';
import { memoryFixtureReader } from './replay-source';

/*
 * The live table (docs/live-flights-l3-data.md): `flight_states` opened and
 * queried like any table under LIVE_FLIGHTS_HANDLE / LIVE_FLIGHTS_TABLE_ID,
 * with every cached result, cube, sort index and profile statistic dropped
 * (or versioned away) on each ingested batch, before the batch is reported.
 * Runs on both drivers; the replay plays a small synthetic fixture on a
 * manual clock, so each batch is exactly one `fire()`.
 */

const T = Date.parse('2026-11-09T23:00:00.000Z');
const HEXES = ['a00001', 'a00002', 'a00003', 'a00004'];

/** Four aircraft, one fix every 10 s for 10 minutes; two categories, climbing. */
function synthetic(): FlightPoint[] {
  const points: FlightPoint[] = [];
  for (const [i, hex] of HEXES.entries()) {
    for (let j = 0; j <= 60; j += 1) {
      points.push({
        ts: T + j * 10_000,
        hex,
        flight: `TST${i}`,
        registration: null,
        typeCode: 'B738',
        lat: Math.round((37.5 + i * 0.1 + j * 0.001) * 1e5) / 1e5,
        lon: Math.round((-122.3 + j * 0.001) * 1e5) / 1e5,
        altBaroFt: 1_000 + i * 5_000 + j * 100,
        altGeomFt: null,
        onGround: false,
        gsKt: 250,
        trackDeg: 45,
        baroRateFpm: 600,
        geomRateFpm: null,
        category: i % 2 === 0 ? 'A3' : 'A1',
        squawk: null,
        posType: null,
        source: 'archive',
      });
    }
  }
  return points;
}

/** Timers that fire only when the test says so. */
function manualClock() {
  let now = Date.parse('2026-11-10T20:00:00.000Z');
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: LiveClock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      nextId += 1;
      timers.set(nextId, { at: now + ms, callback });
      return nextId;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  };
  return {
    clock,
    fire() {
      const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined || !timer) throw new Error('no timer');
      timers.delete(id);
      now = Math.max(now, timer.at);
      timer.callback();
    },
  };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassgrid-live-table-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setup(options: Partial<QueryServiceOptions> = {}) {
  const time = manualClock();
  const service = await QueryService.create(await testDriver(), {
    cacheDir: join(dir, `c${Math.random()}`, 'parquet'),
    ...options,
    live: { clock: time.clock, fixtureReader: () => Promise.resolve(memoryFixtureReader(synthetic())) },
  });
  const events: EngineEvent[] = [];
  service.on('event', (event) => events.push(event));
  /** Fire the next tick and wait until the feed reports its batch (data clock `T + k minutes`). */
  const tick = async (k: number) => {
    time.fire();
    for (let i = 0; i < 2_000; i += 1) {
      if (service.live.state().lastBatch?.dataClockMs === T + k * 60_000) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no batch ${k}`);
  };
  /** One minute of fixture per tick: tick 0 holds the first fix of each aircraft, tick k everything up to T + k min. */
  const start = (fixture: 'flights-bay-30min' | 'flights-bay-day' = 'flights-bay-30min') =>
    service.live.start({ kind: 'replay', fixture, intervalMs: 1_000, speed: 60, retentionMs: null });
  const sql = async (query: string) => {
    const store = service.live.flightStore;
    if (!store) throw new Error('no store');
    const connection = await store.connect();
    try {
      return (await connection.query(query)).rows.map((row) => row.map((value) => (typeof value === 'bigint' ? Number(value) : value)));
    } finally {
      connection.close();
    }
  };
  return { service, events, tick, start, sql };
}

const id = LIVE_FLIGHTS_TABLE_ID;

describe('the live table', () => {
  it('opens under the reserved handle once the feed has a table, with the fixture types, a constant fingerprint and the row count', async () => {
    const { service, tick, start } = await setup();
    try {
      await expect(service.open(LIVE_FLIGHTS_HANDLE)).rejects.toMatchObject({ code: 'unknown_table' });
      await start();
      await tick(0);
      const handle = await service.open(LIVE_FLIGHTS_HANDLE);
      expect(handle).toMatchObject({ id, file: LIVE_FLIGHTS_HANDLE, fileName: 'flight_states', rowCount: 4, fingerprint: LIVE_FLIGHTS_FINGERPRINT, usingParquetCache: false });
      expect(Object.fromEntries(handle.columns.map((column) => [column.name, `${column.type} ${column.duckdbType}`]))).toMatchObject({
        ts: 'timestamp TIMESTAMP',
        hex: 'text VARCHAR',
        lat: 'decimal DECIMAL(7,5)',
        lon: 'decimal DECIMAL(8,5)',
        altBaroFt: 'integer INTEGER',
        onGround: 'boolean BOOLEAN',
        gsKt: 'float DOUBLE',
      });
      expect((await service.profile(id)).value.rowCount).toBe(4);

      await tick(1);
      // Six more fixes of each aircraft; the open handle, the count and the profile follow.
      expect((await service.count(id)).value).toBe(28);
      expect((await service.open(LIVE_FLIGHTS_HANDLE)).rowCount).toBe(28);
      expect((await service.profile(id)).value.columns.find((column) => column.name === 'altBaroFt')).toMatchObject({ min: 1_000, max: 16_600, nullFraction: 0 });
      expect((await service.open(LIVE_FLIGHTS_HANDLE)).fingerprint).toEqual(LIVE_FLIGHTS_FINGERPRINT);

      // No Parquet copy of a table that changes every batch.
      await expect(service.ensureParquetCache(id)).rejects.toMatchObject({ code: 'not_implemented' });
      expect((await service.parquetCacheStats()).files).toBe(0);
    } finally {
      service.close();
    }
  });

  it('every cached result, cube, sort index and profile statistic is dropped on each batch, before the batch is reported', async () => {
    const { service, events, tick, start, sql } = await setup({ pagingStrategy: 'index' });
    try {
      await start();
      await tick(0);
      await tick(1);
      const columns = await service.columns(id);
      const where = toFragment(compileWhere([{ kind: 'in', column: 'category', values: ['A3'] }], columns));
      const queries = {
        count: async () => (await service.count(id, where)).cached,
        rows: async () => (await service.rows(id, { offset: 0, limit: 5, sort: [{ column: 'ts', direction: 'desc' }] })).cached,
        aggregate: async () => (await runAggregate(service, id, { mark: 'bar', x: { column: 'category' }, filters: [] }, {})).cached,
        map: async () => (await runMapQuery(service, { table: id, spec: { kind: 'map', lat: 'lat', lon: 'lon', id: 'hex', time: 'ts', filters: [], trailMinutes: 5 }, query: 'latest', dataClockMs: T + 60_000 }, {})).cached,
        profile: async () => (await service.profile(id)).cached,
      };
      const run = async () => Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([name, query]) => [name, await query()] as const)));
      const cubes = () => prepareCrossfilter(service, id, { column: 'altBaroFt', bin: { kind: 'width', width: 1_000 } }, [{ kind: 'count', filters: [] }], {});

      expect(await run()).toEqual({ count: false, rows: false, aggregate: false, map: false, profile: false });
      expect(await run()).toEqual({ count: true, rows: true, aggregate: true, map: true, profile: true });
      expect(await cubes()).toEqual([{ status: 'ready', rows: expect.any(Number) as number }]);
      expect(service.resultCacheStats().entries).toBeGreaterThan(0);
      expect(service.cubeStats().cubes).toBe(1);
      expect(service.debugState().sortIndexes).toBe(1);

      // What is cached when the feed reports the next batch (its liveState event): nothing of the table.
      const atReport: Array<{ entries: number; cubes: number; sortIndexes: number; order: string[] }> = [];
      service.on('event', (event) => {
        if (event.type === 'liveState' && event.state.lastBatch?.dataClockMs === T + 120_000 && atReport.length === 0) {
          atReport.push({
            entries: service.resultCacheStats().entries,
            cubes: service.cubeStats().cubes,
            sortIndexes: service.debugState().sortIndexes,
            order: events.slice(-2).map((e) => e.type),
          });
        }
      });
      const before = events.length;
      await tick(2);
      expect(atReport).toEqual([{ entries: 0, cubes: 0, sortIndexes: 0, order: ['tableUpdated', 'liveState'] }]);
      expect(events.slice(before).find((event) => event.type === 'tableUpdated')).toMatchObject({ table: { id, rowCount: 52 } });

      // The same requests run again, on the new rows, and agree with SQL on the table itself.
      expect(await run()).toEqual({ count: false, rows: false, aggregate: false, map: false, profile: false });
      expect((await service.count(id, where)).value).toBe((await sql(`SELECT count(*) FROM flight_states WHERE category = 'A3'`))[0]?.[0]);
      expect((await service.count(id)).value).toBe(52);
      const newest = decode((await service.rows(id, { offset: 0, limit: 1, sort: [{ column: 'ts', direction: 'desc' }] })).value);
      expect(columnValues(newest, 'hex')).toHaveLength(1);
      expect(String(columnValues(newest, 'ts')[0])).toBe(String(T + 120_000));
      const bars = decode((await runAggregate(service, id, { mark: 'bar', x: { column: 'category' }, filters: [] }, {})).value);
      expect(Object.fromEntries(columnValues(bars, 'x').map((x, i) => [x, columnValues(bars, 'y')[i]]))).toEqual({ A1: 26, A3: 26 });
      expect(await cubes()).toEqual([{ status: 'ready', rows: expect.any(Number) as number }]);
      expect(service.cubeStats().cubes).toBe(1);
    } finally {
      service.close();
    }
  });

  it('a new source is a new table: nothing of the old one is served; closing the table keeps the rows', async () => {
    const { service, tick, start } = await setup();
    try {
      await start('flights-bay-30min');
      await tick(0);
      await tick(1);
      expect((await service.count(id)).value).toBe(28);
      expect((await service.count(id)).cached).toBe(true);

      // Another fixture: the feed empties the table (a new store), and the live table follows it.
      await start('flights-bay-day');
      await tick(0);
      expect((await service.count(id)).value).toBe(4);
      expect((await service.open(LIVE_FLIGHTS_HANDLE)).rowCount).toBe(4);

      // The app closes the table (another file opened, a window closed): the feed's rows stay.
      await service.closeTable(id);
      expect(service.live.state().rowCount).toBe(4);
      expect(service.resultCacheStats().entries).toBe(0);
      expect((await service.count(id)).value).toBe(4);
      await tick(1);
      expect((await service.count(id)).value).toBe(28);
    } finally {
      service.close();
    }
  });

  it('answers open and map requests through the protocol', async () => {
    const { service, tick, start } = await setup();
    const sent: EngineResponse[] = [];
    const session = new EngineSession(Promise.resolve(service), (message) => sent.push(EngineResponseSchema.parse(message)));
    const request = async (body: Record<string, unknown>) => {
      const requestId = `r${sent.length}-${Math.random()}`;
      session.handle({ ...body, requestId });
      for (let i = 0; i < 2_000; i += 1) {
        const reply = sent.find((message) => message.kind !== 'event' && message.requestId === requestId);
        if (reply) return reply;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('no reply');
    };
    try {
      await start();
      await tick(0);
      await tick(1);
      expect(await request({ kind: 'open', file: LIVE_FLIGHTS_HANDLE })).toMatchObject({ kind: 'opened', table: { id, rowCount: 28 } });
      const latest = await request({ kind: 'map', table: id, viewId: 'map:m1:latest', seq: 1, spec: { kind: 'map' }, query: 'latest', dataClockMs: T + 60_000 });
      if (latest.kind !== 'arrow') throw new Error(`expected arrow, got ${JSON.stringify(latest)}`);
      const aircraft = decode(latest.ipc);
      expect(aircraft.schema.fields.map((field) => field.name)).toEqual(['hex', 'flight', 'typeCode', 'category', 'lat', 'lon', 'altBaroFt', 'altGeomFt', 'onGround', 'gsKt', 'trackDeg', 'baroRateFpm', 'ts', 'registration']);
      expect(columnValues(aircraft, 'ts')).toEqual(HEXES.map(() => T + 60_000));
      expect(columnValues(aircraft, 'hex')).toEqual(HEXES);
      expect(columnValues(aircraft, 'lat')).toEqual([37.506, 37.606, 37.706, 37.806]);
      expect(typeof columnValues(aircraft, 'altBaroFt')[0]).toBe('number');
      const trails = await request({ kind: 'map', table: id, viewId: 'map:m1:trails', seq: 1, spec: { kind: 'map', trailMinutes: 1 }, query: 'trails', dataClockMs: T + 60_000 });
      if (trails.kind !== 'arrow') throw new Error('expected arrow');
      // One minute back from the clock, exclusive: fixes at +10 s .. +60 s, six per aircraft, by aircraft then time.
      const trail = decode(trails.ipc);
      expect(trail.numRows).toBe(24);
      expect(columnValues(trail, 'hex').slice(0, 7)).toEqual([...Array<string>(6).fill('a00001'), 'a00002']);
      expect(columnValues(trail, 'ts').slice(0, 6)).toEqual([1, 2, 3, 4, 5, 6].map((j) => T + j * 10_000));
      expect(await request({ kind: 'map', table: id, viewId: 'map:m1:latest', seq: 2, spec: { kind: 'map', lat: 'hex' }, query: 'latest', dataClockMs: 0 })).toMatchObject({
        kind: 'error',
        code: 'bad_request',
        path: 'lat',
      });
    } finally {
      session.dispose();
      service.close();
    }
  });
});
