import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIVE_FIXTURES,
  LIVE_FLIGHTS_TABLE_ID,
  MAP_AIRCRAFT_FIELDS,
  MAP_FRESHNESS_MS,
  MAP_TRAIL_FIELDS,
  MapSpecSchema,
  type EngineEvent,
  type LiveClock,
  type MapSpecInput,
} from '@glassgrid/core';
import { createNativeDriver } from '../native/driver';
import { QueryService } from '../query-service';
import { runMapQuery } from '../session';
import { quoteLiteral } from '../sql-text';
import { decode, isWasm, testDriver } from '../test-support';
import { FLIGHT_POINT_SELECT, pointFromRow } from './flight-store';
import { memoryFixtureReader } from './replay-source';

/*
 * The map view's two queries (docs/live-flights-l3-data.md) on the real
 * replayed fixture, on both drivers: flights-bay-30min played through the
 * feed into flight_states (retention off), then the latest-fix and trails
 * queries at known data clocks, each checked against independent SQL on
 * the same table. The wasm run gets the fixture's rows from native DuckDB
 * (DuckDB-WASM's Node runtime has no Parquet extension here), as the replay
 * gate does.
 */

const FIXTURE_ID = 'flights-bay-30min';
const FIXTURE = resolve(import.meta.dirname, '../../../../apps/web/public/samples/flights', LIVE_FIXTURES[FIXTURE_ID].file);
/** The busiest window starts 23:28 UTC (L0); its fixture has a 60 s lead-in from 23:27. */
const CLOCKS = ['2026-11-09T23:30:00.000Z', '2026-11-09T23:45:00.500Z', '2026-11-09T23:58:00.000Z'].map(Date.parse);

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

async function fixturePoints() {
  const native = createNativeDriver();
  const db = await native.createDatabase({ allowedPaths: [FIXTURE], allowedDirectories: [], tempDirectory: join(dir, 'points'), memoryLimitBytes: 512 * 1024 ** 2 });
  const connection = await db.connect();
  try {
    return (await connection.query(`SELECT ${FLIGHT_POINT_SELECT} FROM read_parquet(${quoteLiteral(FIXTURE)})`)).rows.map(pointFromRow);
  } finally {
    connection.close();
    await db.close();
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassgrid-map-queries-'));
  const reader = isWasm ? memoryFixtureReader(await fixturePoints()) : null;
  service = await QueryService.create(await testDriver(), {
    cacheDir: join(dir, 'cache', 'parquet'),
    live: { clock: instantClock(), ...(reader ? { fixtureReader: () => Promise.resolve(reader) } : { fixturePath: () => Promise.resolve(FIXTURE) }) },
  });
  const ended = new Promise<void>((done) => {
    service.on('event', (event: EngineEvent) => {
      if (event.type === 'liveState' && event.state.feed?.ended) done();
    });
  });
  await service.live.start({ kind: 'replay', fixture: FIXTURE_ID, intervalMs: 20_000, speed: 30, retentionMs: null });
  await ended;
  expect(service.live.state().rowCount).toBe(LIVE_FIXTURES[FIXTURE_ID].rows);
}, 120_000);

afterAll(async () => {
  service.close();
  await rm(dir, { recursive: true, force: true });
});

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

async function query(spec: MapSpecInput, kind: 'latest' | 'trails', dataClockMs: number) {
  const { value } = await runMapQuery(service, { table: LIVE_FLIGHTS_TABLE_ID, spec: MapSpecSchema.parse(spec), query: kind, dataClockMs }, {});
  const table = decode(value);
  return { table, rows: table.toArray().map((row) => (row as { toJSON(): Record<string, unknown> }).toJSON()) };
}

describe('map queries on the replayed 30-minute fixture', () => {
  it.each(CLOCKS)('latest fix per aircraft at %i: the aircraft seen in the last 90 s, at their newest fix', async (clock) => {
    const { table, rows } = await query({ kind: 'map' }, 'latest', clock);
    expect(table.schema.fields.map((field) => field.name)).toEqual([...MAP_AIRCRAFT_FIELDS]);
    // Independent: distinct aircraft with a fix in (clock - 90 s, clock], and each one's newest fix.
    const [[expected]] = (await sql(`SELECT count(DISTINCT hex) FROM flight_states WHERE ts > ${at(clock - MAP_FRESHNESS_MS)} AND ts <= ${at(clock)}`)) as [[number]];
    expect(rows.length).toBe(expected);
    console.info(`[map queries] ${isWasm ? 'wasm' : 'native'}: ${rows.length} aircraft at ${new Date(clock).toISOString()}`);
    // The busiest half hour of the day: L0 counted 169 aircraft in view at the median 10 s snapshot.
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.length).toBeLessThan(200);
    const newest = new Map(
      (await sql(`SELECT hex, epoch_ms(max(ts)) FROM flight_states WHERE ts > ${at(clock - MAP_FRESHNESS_MS)} AND ts <= ${at(clock)} GROUP BY hex`)).map(([hex, ts]) => [hex as string, ts as number]),
    );
    for (const row of rows) expect(row['ts']).toBe(newest.get(row['hex'] as string));
    // Shapes the map component takes as is: numbers (DECIMAL and INTEGER converted), epoch ms, booleans.
    const first = rows[0] ?? {};
    expect(typeof first['ts']).toBe('number');
    expect(typeof first['lat']).toBe('number');
    expect(typeof first['lon']).toBe('number');
    expect(typeof first['onGround']).toBe('boolean');
    expect(rows.every((row) => Number.isInteger(row['ts']) && (row['ts'] as number) <= clock && (row['ts'] as number) > clock - MAP_FRESHNESS_MS)).toBe(true);
    const [[lat, lon, alt]] = (await sql(
      `SELECT CAST(lat AS DOUBLE), CAST(lon AS DOUBLE), altBaroFt FROM flight_states WHERE hex = ${quoteLiteral(String(first['hex']))} AND ts = ${at(first['ts'] as number)}`,
    )) as [[number, number, number | null]];
    expect([first['lat'], first['lon'], first['altBaroFt']]).toEqual([lat, lon, alt]);
    // Freshest first.
    const times = rows.map((row) => row['ts'] as number);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('an aircraft stays on the map across a 60–90 s gap between its fixes (it blinked out at 60 s)', async () => {
    // Every gap of 61 to 89 s between consecutive fixes of one aircraft in the fixture; at least a few.
    const gaps = (await sql(
      `SELECT hex, prev, ts FROM (SELECT hex, epoch_ms(ts) AS ts, lag(epoch_ms(ts)) OVER (PARTITION BY hex ORDER BY ts) AS prev FROM flight_states)
       WHERE ts - prev > 61000 AND ts - prev < 89000 ORDER BY prev, hex LIMIT 40`,
    )) as [string, number, number][];
    expect(gaps.length).toBeGreaterThan(10);
    for (const [hex, prev, next] of gaps) {
      // A clock 61 s after the earlier fix, before the next: the earlier fix is still the newest.
      const clock = prev + 61_000;
      expect(clock).toBeLessThan(next);
      const { rows } = await query({ kind: 'map' }, 'latest', clock);
      const row = rows.find((candidate) => candidate['hex'] === hex);
      expect(row?.['ts'], `${hex} at ${new Date(clock).toISOString()}`).toBe(prev);
    }
    // An aircraft that stopped reporting stays 90 s after its last fix, and is gone after that.
    const [[hex, last]] = (await sql(
      `SELECT hex, epoch_ms(max(ts)) AS last FROM flight_states GROUP BY hex
       HAVING max(ts) < (SELECT max(ts) FROM flight_states) - INTERVAL 5 MINUTE ORDER BY last, hex LIMIT 1`,
    )) as [[string, number]];
    expect((await query({ kind: 'map' }, 'latest', last + 89_000)).rows.some((row) => row['hex'] === hex)).toBe(true);
    expect((await query({ kind: 'map' }, 'latest', last + 90_000)).rows.some((row) => row['hex'] === hex)).toBe(false);
  });

  it('applies the spec’s filters to the latest fix', async () => {
    const clock = CLOCKS[1] ?? 0;
    const { rows } = await query({ kind: 'map', filters: [{ kind: 'range', column: 'altBaroFt', min: 10_000 }, { kind: 'in', column: 'category', values: ['A3'] }] }, 'latest', clock);
    const [[expected]] = (await sql(
      `SELECT count(*) FROM (SELECT * FROM flight_states WHERE ts > ${at(clock - MAP_FRESHNESS_MS)} AND ts <= ${at(clock)} QUALIFY row_number() OVER (PARTITION BY hex ORDER BY ts DESC) = 1) WHERE altBaroFt >= 10000 AND category = 'A3'`,
    )) as [[number]];
    expect(expected).toBeGreaterThan(0);
    expect(rows.length).toBe(expected);
    expect(rows.every((row) => (row['altBaroFt'] as number) >= 10_000 && row['category'] === 'A3')).toBe(true);
  });

  it.each([5, 30])('trails of %i minutes: the shown aircraft, one fix per bucket, ordered by aircraft and time, ending at the latest fix', async (minutes) => {
    const clock = CLOCKS[2] ?? 0;
    const spec = { kind: 'map' as const, trailMinutes: minutes };
    const latest = (await query(spec, 'latest', clock)).rows;
    const { table, rows } = await query(spec, 'trails', clock);
    expect(table.schema.fields.map((field) => field.name)).toEqual([...MAP_TRAIL_FIELDS]);
    const shown = new Set(latest.map((row) => row['hex'] as string));
    expect(new Set(rows.map((row) => row['hex']))).toEqual(shown);
    // Ordered by (hex, ts), inside the window.
    const keys = rows.map((row) => `${String(row['hex'])} ${String(row['ts']).padStart(16, '0')}`);
    expect([...keys].sort()).toEqual(keys);
    const from = clock - minutes * 60_000;
    expect(rows.every((row) => (row['ts'] as number) > from && (row['ts'] as number) <= clock)).toBe(true);
    // Independent: one point per aircraft and bucket of trail/100, i.e. the distinct buckets of the shown aircraft's fixes.
    const bucket = (minutes * 60_000) / 100;
    const hexes = [...shown].map((hex) => quoteLiteral(hex)).join(', ');
    const [[expected]] = (await sql(
      `SELECT count(*) FROM (SELECT DISTINCT hex, floor(epoch_ms(ts) / ${bucket}) FROM flight_states WHERE ts > ${at(from)} AND ts <= ${at(clock)} AND hex IN (${hexes}))`,
    )) as [[number]];
    expect(rows.length).toBe(expected);
    console.info(`[map queries] ${isWasm ? 'wasm' : 'native'}: ${minutes}-minute trails of ${shown.size} aircraft, ${rows.length} points`);
    const perAircraft = new Map<string, number>();
    for (const row of rows) perAircraft.set(row['hex'] as string, (perAircraft.get(row['hex'] as string) ?? 0) + 1);
    expect(Math.max(...perAircraft.values())).toBeLessThanOrEqual(101);
    // Each trail ends at the aircraft's marker.
    const last = new Map(rows.map((row) => [row['hex'] as string, row]));
    for (const aircraft of latest) {
      const end = last.get(aircraft['hex'] as string);
      expect([end?.['ts'], end?.['lat'], end?.['lon'], end?.['altBaroFt']]).toEqual([aircraft['ts'], aircraft['lat'], aircraft['lon'], aircraft['altBaroFt']]);
    }
  });

  it('a clock before the first fix shows nothing; the clock is part of the cache key', async () => {
    expect((await query({ kind: 'map' }, 'latest', Date.parse('2026-11-09T22:00:00.000Z'))).rows).toEqual([]);
    const clock = CLOCKS[0] ?? 0;
    const spec = MapSpecSchema.parse({ kind: 'map' });
    const first = await runMapQuery(service, { table: LIVE_FLIGHTS_TABLE_ID, spec, query: 'latest', dataClockMs: clock }, {});
    const again = await runMapQuery(service, { table: LIVE_FLIGHTS_TABLE_ID, spec, query: 'latest', dataClockMs: clock }, {});
    const later = await runMapQuery(service, { table: LIVE_FLIGHTS_TABLE_ID, spec, query: 'latest', dataClockMs: clock + 1_000 }, {});
    expect([again.cached, later.cached]).toEqual([true, false]);
    expect(decode(again.value).numRows).toBe(decode(first.value).numRows);
  });
});
