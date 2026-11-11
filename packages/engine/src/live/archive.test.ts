import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIVE_FIXTURES,
  LIVE_FLIGHTS_TABLE_ID,
  MAP_TRAIL_FIELDS,
  MAP_TRACK_SPAN_MS,
  MAX_MAP_TRACK_POINTS,
  MIN_MAP_TRACK_BUCKET_MS,
  MapSpecSchema,
  type FlightPoint,
  type LiveClock,
  type LiveState,
  type MapQueryKind,
} from '@glassgrid/core';
import { createNativeDriver } from '../native/driver';
import { QueryService } from '../query-service';
import { runMapQuery } from '../session';
import { quoteLiteral } from '../sql-text';
import { decode, isWasm, testDriver } from '../test-support';
import { EngineFailure } from '../errors';
import { ArchiveSource, isPermanentLoadFailure } from './archive-source';
import { FLIGHT_POINT_SELECT, pointFromRow } from './flight-store';
import { memoryFixtureReader, type FixtureReader } from './replay-source';

/*
 * L4's archive source (docs/live-flights-l4.md) on both drivers: the whole
 * 30-minute fixture loaded at once into flight_states (retention off),
 * then the map's queries "as of T" at clocks anywhere in it, in any order
 * (a seek is a re-query, nothing is re-ingested), and the selected
 * aircraft's track up to T with its bounds. Native loads the Parquet file
 * itself (`loadParquet`); the wasm run gets the rows from native DuckDB as
 * one batch (DuckDB-WASM's Node runtime has no Parquet extension here).
 */

const FIXTURE_ID = 'flights-bay-30min';
const FIXTURE = resolve(import.meta.dirname, '../../../../apps/web/public/samples/flights', LIVE_FIXTURES[FIXTURE_ID].file);
const DAY = resolve(import.meta.dirname, '../../../../apps/web/public/samples/flights', LIVE_FIXTURES['flights-bay-day'].file);
const FIRST = Date.parse('2026-11-09T23:27:00.000Z');
const LAST_FIX = Date.parse('2026-11-09T23:57:59.990Z');
/** L3's three clocks: 187 / 171 / 186 aircraft, now reached by seeking, not by replaying. */
const SEEKS: readonly [string, number][] = [
  ['2026-11-09T23:58:00.000Z', 186],
  ['2026-11-09T23:30:00.000Z', 187],
  ['2026-11-09T23:45:00.500Z', 171],
];

function instantClock(start = 1_800_000_000_000): LiveClock {
  let now = start;
  return {
    now: () => now,
    setTimeout: (callback, ms) => {
      const due = now + ms;
      return setTimeout(() => {
        now = Math.max(now, due);
        callback();
      }, 0);
    },
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

let dir: string;
let service: QueryService;
const states: LiveState[] = [];

async function parquetPoints(path: string): Promise<FlightPoint[]> {
  const native = createNativeDriver();
  const db = await native.createDatabase({ allowedPaths: [path], allowedDirectories: [], tempDirectory: join(dir, 'points'), memoryLimitBytes: 512 * 1024 ** 2 });
  const connection = await db.connect();
  try {
    return (await connection.query(`SELECT ${FLIGHT_POINT_SELECT} FROM read_parquet(${quoteLiteral(path)})`)).rows.map(pointFromRow);
  } finally {
    connection.close();
    await db.close();
  }
}

/** Independent SQL on flight_states itself (the feed's own database). */
async function sql(query: string): Promise<unknown[][]> {
  const store = service.live.flightStore;
  if (!store) throw new Error('no store');
  const connection = await store.connect();
  try {
    return (await connection.query(query)).rows.map((row) => row.map((value) => (typeof value === 'bigint' ? Number(value) : value)));
  } finally {
    connection.close();
  }
}

const at = (ms: number) => `epoch_ms(CAST(${ms} AS BIGINT))`;

async function mapQuery(query: MapQueryKind, dataClockMs: number, aircraft?: string) {
  const request = { table: LIVE_FLIGHTS_TABLE_ID, spec: MapSpecSchema.parse({ kind: 'map' }), query, dataClockMs, ...(aircraft === undefined ? {} : { aircraft }) };
  const { value } = await runMapQuery(service, request, {});
  const table = decode(value);
  return { table, rows: table.toArray().map((row) => (row as { toJSON(): Record<string, unknown> }).toJSON()) };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassgrid-archive-'));
  const points = isWasm ? await parquetPoints(FIXTURE) : null;
  service = await QueryService.create(await testDriver(), {
    cacheDir: join(dir, 'cache', 'parquet'),
    live: {
      clock: instantClock(),
      ...(points ? { fixtureReader: () => Promise.resolve(memoryFixtureReader(points)) } : { fixturePath: (id) => Promise.resolve(id === 'flights-bay-day' ? DAY : FIXTURE) }),
    },
  });
  service.on('event', (event) => {
    if (event.type === 'liveState') states.push(event.state);
  });
}, 120_000);

afterAll(async () => {
  service.close();
  await rm(dir, { recursive: true, force: true });
});

describe(`the archive source (${isWasm ? 'wasm' : 'native'})`, () => {
  it('loads the whole fixture as one batch, retention off, ordered by time; then reports live (never ended)', async () => {
    const started = performance.now();
    await service.live.start({ kind: 'archive', fixture: FIXTURE_ID });
    await expect.poll(() => service.live.state().feed?.status, { timeout: 60_000 }).toBe('live');
    const loadMs = performance.now() - started;
    const state = service.live.state();
    expect(state.rowCount).toBe(LIVE_FIXTURES[FIXTURE_ID].rows);
    expect(state.feed).toMatchObject({ kind: 'archive', status: 'live', ended: false, dataClockMs: LAST_FIX, error: null });
    expect(state.lastBatch).toEqual({ received: 71_595, inserted: 71_595, expired: 0, dataClockMs: LAST_FIX });
    expect(state.source).toEqual({ kind: 'archive', fixture: FIXTURE_ID });
    console.info(`[archive] ${isWasm ? 'wasm (one batch)' : 'native (loadParquet)'}: ${state.rowCount} rows in ${loadMs.toFixed(0)} ms`);
    // One batch was reported, after `connecting`.
    expect(states.filter((s) => s.lastBatch !== null).map((s) => s.lastBatch?.dataClockMs)).toContain(LAST_FIX);
    const [[first, last]] = (await sql('SELECT epoch_ms(min(ts)), epoch_ms(max(ts)) FROM flight_states')) as [[number, number]];
    expect(last).toBe(LAST_FIX);
    expect(first).toBeGreaterThanOrEqual(FIRST);
    expect(first).toBeLessThan(FIRST + 1_000);
    if (!isWasm) {
      // Native: equal to the file, value for value, and stored in time order (zone maps prune the map's windows).
      const [[missing, extra]] = (await sql(
        `SELECT (SELECT count(*) FROM (SELECT * FROM read_parquet(${quoteLiteral(FIXTURE)}) EXCEPT ALL SELECT * FROM flight_states)),
                (SELECT count(*) FROM (SELECT * FROM flight_states EXCEPT ALL SELECT * FROM read_parquet(${quoteLiteral(FIXTURE)})))`,
      )) as [[number, number]];
      expect([missing, extra]).toEqual([0, 0]);
      const [[ordered]] = (await sql('SELECT bool_and(ts >= prev) FROM (SELECT ts, lag(ts) OVER (ORDER BY rowid) AS prev FROM flight_states) WHERE prev IS NOT NULL')) as [[boolean]];
      expect(ordered).toBe(true);
    }
  });

  it('starting the same archive again loads nothing; another table query sees the same rows', async () => {
    const before = service.live.state().lastBatch;
    await service.live.start({ kind: 'archive', fixture: FIXTURE_ID });
    expect(service.live.state().lastBatch).toBe(before);
    expect(service.live.state().rowCount).toBe(71_595);
  });

  it.each(SEEKS)('as of %s (seeking in any order): every aircraft at its latest fix ≤ T, the L3 counts', async (iso, count) => {
    const clock = Date.parse(iso);
    const { rows } = await mapQuery('latest', clock);
    expect(rows.length).toBe(count);
    const newest = new Map(
      (await sql(`SELECT hex, epoch_ms(max(ts)) FROM flight_states WHERE ts > ${at(clock - 90_000)} AND ts <= ${at(clock)} GROUP BY hex`)).map(([hex, ts]) => [hex as string, ts as number]),
    );
    expect(rows.length).toBe(newest.size);
    for (const row of rows) expect(row['ts']).toBe(newest.get(row['hex'] as string));
    // Registration (L4, the details panel) comes with the fix.
    const sample = rows.find((row) => row['registration'] !== null);
    expect(sample).toBeDefined();
    const [[registration]] = (await sql(`SELECT registration FROM flight_states WHERE hex = ${quoteLiteral(String(sample?.['hex']))} AND ts = ${at(sample?.['ts'] as number)}`)) as [[string]];
    expect(sample?.['registration']).toBe(registration);
    // Trails up to T too, never past it.
    const trails = (await mapQuery('trails', clock)).rows;
    expect(trails.length).toBeGreaterThan(rows.length);
    expect(trails.every((row) => (row['ts'] as number) <= clock && (row['ts'] as number) > clock - 5 * 60_000)).toBe(true);
  });

  it('the selected track: every fix of the aircraft up to T, thinned to one per 2 s bucket, first to latest, ordered', async () => {
    const [[hex, fixes]] = (await sql('SELECT hex, count(*) AS n FROM flight_states GROUP BY hex ORDER BY n DESC, hex LIMIT 1')) as [[string, number]];
    expect(hex).toBe('a783b4');
    expect(fixes).toBe(1_721);
    for (const clock of [Date.parse('2026-11-09T23:40:00.000Z'), LAST_FIX]) {
      const { table, rows } = await mapQuery('track', clock, hex);
      expect(table.schema.fields.map((field) => field.name)).toEqual([...MAP_TRAIL_FIELDS]);
      expect(rows.every((row) => row['hex'] === hex && (row['ts'] as number) <= clock)).toBe(true);
      const times = rows.map((row) => row['ts'] as number);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      const [[first, latest, buckets]] = (await sql(
        `WITH f AS (SELECT epoch_ms(ts) AS ms FROM flight_states WHERE hex = ${quoteLiteral(hex)} AND ts <= ${at(clock)})
         SELECT min(ms), max(ms), (SELECT count(DISTINCT floor((ms - (SELECT min(ms) FROM f)) / ${MIN_MAP_TRACK_BUCKET_MS})) FROM f) FROM f`,
      )) as [[number, number, number]];
      // A span under 2,000 × 2 s: 2 s buckets; one point per bucket, the newest in it, so the latest fix is the last point.
      expect(rows.length).toBe(buckets);
      expect(times.at(-1)).toBe(latest);
      expect(times[0]).toBeGreaterThanOrEqual(first);
      expect(times[0]).toBeLessThan(first + MIN_MAP_TRACK_BUCKET_MS);
      expect(rows.length).toBeLessThanOrEqual(MAX_MAP_TRACK_POINTS);
      for (let i = 1; i < times.length; i += 1) expect(Math.floor(((times[i] as number) - first) / 2000)).toBeGreaterThan(Math.floor(((times[i - 1] as number) - first) / 2000));
    }
    // Before its first fix: no track. An unknown aircraft: none either.
    expect((await mapQuery('track', FIRST - 1, hex)).rows).toEqual([]);
    expect((await mapQuery('track', LAST_FIX, 'nope99')).rows).toEqual([]);
  });

  it('stop keeps the rows; a failing load backs off and retries', async () => {
    await service.live.stop();
    expect(service.live.state().feed?.status).toBe('stopped');
    expect(service.live.state().rowCount).toBe(71_595);
    let attempts = 0;
    const clock = instantClock();
    const source = new ArchiveSource({
      clock,
      load: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error('HTTP 503')) : Promise.resolve(LAST_FIX);
      },
    });
    source.start();
    await expect.poll(() => source.state().status).toBe('backoff');
    expect(source.state()).toMatchObject({ error: 'HTTP 503', failures: 1 });
    await expect.poll(() => source.state().status).toBe('live');
    expect(source.state()).toMatchObject({ dataClockMs: LAST_FIX, failures: 0, error: null, ended: false });
    source.stop();
    expect(source.state().status).toBe('stopped');
  });

  it('a load that cannot succeed (out of memory, a missing file) stops with its error instead of retrying forever', async () => {
    expect(isPermanentLoadFailure(new EngineFailure('out_of_memory', 'This file is too large for the web demo'))).toBe(true);
    expect(isPermanentLoadFailure(new Error('IO Error: Unable to connect to URL ".../flights-bay-day.parquet": 404 (Not Found)'))).toBe(true);
    expect(isPermanentLoadFailure(new EngineFailure('not_implemented', 'Recorded flight data needs Parquet'))).toBe(true);
    expect(isPermanentLoadFailure(new Error('HTTP 503'))).toBe(false);
    expect(isPermanentLoadFailure(new Error('Failed to fetch'))).toBe(false);
    let attempts = 0;
    const source = new ArchiveSource({
      clock: instantClock(),
      load: () => {
        attempts += 1;
        return Promise.reject(new EngineFailure('out_of_memory', 'This file is too large for the web demo (Out of Memory Error: could not allocate block)'));
      },
    });
    source.start();
    await expect.poll(() => source.state().status).toBe('stopped');
    expect(source.state()).toMatchObject({ failures: 1, error: expect.stringMatching(/too large/) as unknown, nextAttemptAt: null, ended: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(attempts).toBe(1);
    // Starting it again tries again (the person's "Retry").
    source.start();
    await expect.poll(() => attempts).toBe(2);
  });
});

describe(`a failed archive load (${isWasm ? 'wasm' : 'native'})`, () => {
  it('stops with its error, leaves the table empty, and versions the live table so nothing cached while it loaded survives', async () => {
    let fail: (error: Error) => void = () => undefined;
    const reading = new Promise<never>((_, reject) => (fail = reject));
    const reader: FixtureReader = {
      range: () => Promise.resolve({ firstTs: FIRST, lastTs: LAST_FIX, rows: 10 }),
      read: () => reading,
      close: () => Promise.resolve(),
    };
    const local = await QueryService.create(await testDriver(), { cacheDir: join(dir, 'cache', 'failed'), live: { clock: instantClock(), fixtureReader: () => Promise.resolve(reader) } });
    try {
      const events: { type: string }[] = [];
      local.on('event', (event) => events.push(event));
      await local.live.start({ kind: 'archive', fixture: FIXTURE_ID });
      // A view asks while the day loads: the empty table's answer is cached.
      expect((await local.count(LIVE_FLIGHTS_TABLE_ID)).value).toBe(0);
      expect((await local.count(LIVE_FLIGHTS_TABLE_ID)).cached).toBe(true);
      fail(new EngineFailure('out_of_memory', 'This file is too large for the web demo'));
      await expect.poll(() => local.live.state().feed?.status).toBe('stopped');
      expect(local.live.state()).toMatchObject({ rowCount: 0, lastBatch: null, feed: { error: expect.stringMatching(/too large/) as unknown } });
      expect(events.some((event) => event.type === 'tableUpdated')).toBe(true);
      expect((await local.count(LIVE_FLIGHTS_TABLE_ID)).cached).toBe(false);
    } finally {
      local.close();
    }
  });
});

describe(`an archive whose file cannot be found (${isWasm ? 'wasm' : 'native'})`, () => {
  it('the start fails, and the state says so (stopped, with the error) instead of a feed that never reports', async () => {
    const local = await QueryService.create(await testDriver(), {
      cacheDir: join(dir, 'cache', 'missing'),
      live: { clock: instantClock(), fixturePath: () => Promise.reject(new Error('HTTP 404 (Not Found) for /samples/flights/flights-bay-day.parquet')) },
    });
    try {
      const reported: LiveState[] = [];
      local.on('event', (event) => {
        if (event.type === 'liveState') reported.push(event.state);
      });
      await expect(local.live.start({ kind: 'archive', fixture: 'flights-bay-day' })).rejects.toThrow(/404/);
      const expected = { source: { kind: 'archive', fixture: 'flights-bay-day' }, rowCount: 0, lastBatch: null, feed: { kind: 'archive', status: 'stopped', failures: 1, error: expect.stringMatching(/404/) as unknown } };
      expect(local.live.state()).toMatchObject(expected);
      expect(reported.at(-1)).toMatchObject(expected);
      // The live table reads as empty (not the old source's rows, nor an error) until a retry.
      expect((await local.count(LIVE_FLIGHTS_TABLE_ID)).value).toBe(0);
    } finally {
      local.close();
    }
  });
});

describe(`the live table's grid pages (${isWasm ? 'wasm' : 'native'})`, () => {
  it('filtered, unsorted pages of the live table use LIMIT / OFFSET, never a row-number index (a copy of the table)', async () => {
    await service.live.start({ kind: 'archive', fixture: FIXTURE_ID });
    await expect.poll(() => service.live.state().feed?.status, { timeout: 60_000 }).toBe('live');
    const where = { sql: '"lon" BETWEEN -122.6 AND -121.9', params: [] };
    const page = async (offset: number) => decode((await service.rows(LIVE_FLIGHTS_TABLE_ID, { offset, limit: 1000, where }, { viewId: 'grid' })).value);
    const first = await page(0);
    const deep = await page(20_000);
    expect(first.numRows).toBe(1000);
    expect(deep.numRows).toBe(1000);
    // The same rows as the filtered table in insertion order (time order for an archive).
    const [[ts]] = (await sql(`SELECT epoch_ms(ts) FROM flight_states WHERE lon BETWEEN -122.6 AND -121.9 LIMIT 1 OFFSET 20000`)) as [[number]];
    expect(Number(deep.getChild('ts')?.get(0))).toBe(ts);
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    expect(service.debugState().sortIndexes).toBe(0);
  });
});

describe.skipIf(isWasm)('the day fixture (native): load time and memory', () => {
  it('loads flights-bay-day.parquet whole: 1,456,777 rows, ordered by time; reports the time and DuckDB memory', async () => {
    const local = await QueryService.create(await testDriver(), { cacheDir: join(dir, 'cache', 'day'), live: { clock: instantClock(), fixturePath: () => Promise.resolve(DAY) } });
    try {
      const started = performance.now();
      await local.live.start({ kind: 'archive', fixture: 'flights-bay-day' });
      await expect.poll(() => local.live.state().feed?.status, { timeout: 60_000 }).toBe('live');
      const ms = performance.now() - started;
      expect(local.live.state().rowCount).toBe(LIVE_FIXTURES['flights-bay-day'].rows);
      const store = local.live.flightStore;
      if (!store) throw new Error('no store');
      const connection = await store.connect();
      try {
        const [[bytes]] = (await connection.query('SELECT sum(memory_usage_bytes) FROM duckdb_memory()')).rows.map((row) => row.map(Number)) as [[number]];
        console.info(`[archive] native day load: ${local.live.state().rowCount} rows in ${ms.toFixed(0)} ms, DuckDB memory ${(bytes / 1024 ** 2).toFixed(1)} MB`);
        expect(bytes).toBeGreaterThan(0);
      } finally {
        connection.close();
      }
    } finally {
      local.close();
    }
  }, 120_000);
});

describe('a track over a long span is thinned to its bucket limit', () => {
  it('a day of fixes every second: its last two hours, at most 2,001 points, the first and the latest kept', async () => {
    const local = await QueryService.create(await testDriver(), {
      cacheDir: join(dir, 'cache', 'long'),
      live: {
        clock: instantClock(),
        fixtureReader: () => {
          const start = Date.parse('2026-11-09T00:00:00.000Z');
          const points: FlightPoint[] = [];
          for (let s = 0; s < 86_400; s += 1) {
            points.push({ ts: start + s * 1000, hex: 'abc123', flight: 'TEST1', registration: 'N1', typeCode: 'B738', lat: 37 + s / 1e6, lon: -122, altBaroFt: 10_000, altGeomFt: null, onGround: false, gsKt: 300, trackDeg: 90, baroRateFpm: 0, geomRateFpm: null, category: 'A3', squawk: null, posType: null, source: 'archive' });
          }
          return Promise.resolve(memoryFixtureReader(points));
        },
      },
    });
    try {
      await local.live.start({ kind: 'archive', fixture: 'flights-bay-day' });
      await expect.poll(() => local.live.state().feed?.status, { timeout: 60_000 }).toBe('live');
      expect(local.live.state().rowCount).toBe(86_400);
      const end = Date.parse('2026-11-09T23:59:59.000Z');
      const { value } = await runMapQuery(local, { table: LIVE_FLIGHTS_TABLE_ID, spec: MapSpecSchema.parse({ kind: 'map' }), query: 'track', dataClockMs: end, aircraft: 'abc123' }, {});
      const times = decode(value).toArray().map((row) => (row as { toJSON(): { ts: number } }).toJSON().ts);
      // The two hours up to the clock (MAP_TRACK_SPAN_MS: a bounded scan of the day), in buckets of
      // ceil(7,199,000 / 2,000) = 3.6 s, so 2,000 buckets.
      expect(times.length).toBe(2_000);
      expect(times.length).toBeLessThanOrEqual(MAX_MAP_TRACK_POINTS);
      expect(times.at(-1)).toBe(end);
      expect(times[0]).toBeGreaterThan(end - MAP_TRACK_SPAN_MS);
      expect(times[0]).toBeLessThanOrEqual(end - MAP_TRACK_SPAN_MS + 1_000 + 3_600);
    } finally {
      local.close();
    }
  }, 120_000);
});
