import { describe, expect, it } from 'vitest';
import { type CompileColumn } from '../spec/column.js';
import {
  MAP_FRESHNESS_MS,
  MAP_TRACK_BUCKETS,
  MAP_TRACK_SPAN_MS,
  MAX_MAP_AIRCRAFT,
  MAX_MAP_TRACK_POINTS,
  MAX_MAP_TRAIL_POINTS,
  MIN_MAP_TRACK_BUCKET_MS,
  MapSpecSchema,
  mapSpecColumns,
} from '../spec/map.js';
import { CompileError, type CompileErrorCode } from './errors.js';
import { compileMapLatestQuery, compileMapTrackQuery, compileMapTrailsQuery } from './map.js';

const TABLE = '"gg_tb_live-flight-states"';
const CLOCK = Date.UTC(2026, 10, 9, 23, 45, 0);

/** `flight_states` as the engine describes it (FlightPoint layout, the fixtures' types). */
const flightColumns: CompileColumn[] = [
  { name: 'ts', type: 'timestamp', duckdbType: 'TIMESTAMP' },
  { name: 'hex', type: 'text', duckdbType: 'VARCHAR' },
  { name: 'flight', type: 'text', duckdbType: 'VARCHAR' },
  { name: 'registration', type: 'text', duckdbType: 'VARCHAR' },
  { name: 'typeCode', type: 'text', duckdbType: 'VARCHAR' },
  { name: 'lat', type: 'decimal', duckdbType: 'DECIMAL(7,5)' },
  { name: 'lon', type: 'decimal', duckdbType: 'DECIMAL(8,5)' },
  { name: 'altBaroFt', type: 'integer', duckdbType: 'INTEGER' },
  { name: 'altGeomFt', type: 'integer', duckdbType: 'INTEGER' },
  { name: 'onGround', type: 'boolean', duckdbType: 'BOOLEAN' },
  { name: 'gsKt', type: 'float', duckdbType: 'DOUBLE' },
  { name: 'trackDeg', type: 'float', duckdbType: 'DOUBLE' },
  { name: 'baroRateFpm', type: 'integer', duckdbType: 'INTEGER' },
  { name: 'geomRateFpm', type: 'integer', duckdbType: 'INTEGER' },
  { name: 'category', type: 'text', duckdbType: 'VARCHAR' },
  { name: 'squawk', type: 'text', duckdbType: 'VARCHAR' },
  { name: 'posType', type: 'text', duckdbType: 'VARCHAR' },
  { name: 'source', type: 'text', duckdbType: 'VARCHAR' },
];

function compileError(fn: () => unknown): CompileError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CompileError) return error;
    throw error;
  }
  throw new Error('Expected a CompileError');
}

function expectCompileError(fn: () => unknown, code: CompileErrorCode, message: RegExp, path?: string): void {
  const error = compileError(fn);
  expect(error.code).toBe(code);
  expect(error.message).toMatch(message);
  if (path !== undefined) expect(error.path).toBe(path);
}

describe('MapSpecSchema', () => {
  it('fills the flight-point defaults', () => {
    expect(MapSpecSchema.parse({ kind: 'map' })).toEqual({ kind: 'map', lat: 'lat', lon: 'lon', id: 'hex', time: 'ts', filters: [], trailMinutes: 5 });
    expect(mapSpecColumns(MapSpecSchema.parse({ kind: 'map', filters: [{ kind: 'notNull', column: 'flight' }, { kind: 'notNull', column: 'lat' }] }))).toEqual([
      'lat',
      'lon',
      'hex',
      'ts',
      'flight',
    ]);
  });

  it('is strict and bounds the trail', () => {
    expect(MapSpecSchema.safeParse({ kind: 'map', colour: 'x' }).success).toBe(false);
    expect(MapSpecSchema.safeParse({ kind: 'chart' }).success).toBe(false);
    expect(MapSpecSchema.safeParse({ kind: 'map', trailMinutes: 31 }).success).toBe(false);
    expect(MapSpecSchema.safeParse({ kind: 'map', trailMinutes: 2.5 }).success).toBe(false);
    expect(MapSpecSchema.safeParse({ kind: 'map', trailMinutes: -1 }).success).toBe(false);
    expect(MapSpecSchema.safeParse({ kind: 'map', trailMinutes: 0 }).success).toBe(true);
    expect(MapSpecSchema.safeParse({ kind: 'map', lat: '' }).success).toBe(false);
  });
});

describe('compileMapLatestQuery', () => {
  it('takes the newest fix per aircraft in the freshness window, then filters it', () => {
    const query = compileMapLatestQuery(
      TABLE,
      { kind: 'map', filters: [{ kind: 'range', column: 'altBaroFt', min: 10_000 }, { kind: 'in', column: 'category', values: ['A3', null] }] },
      flightColumns,
      { dataClockMs: CLOCK },
    );
    expect(query.sql).toMatchSnapshot();
    expect(query.params).toEqual([CLOCK - MAP_FRESHNESS_MS, CLOCK, 10_000, 'A3']);
    // The newest fix per aircraft, ties by lat then lon (an aggregate since L4: as the L3 window, faster on WASM).
    expect(query.sql).toContain('arg_max(__gg_row, (__gg_row."ts", -__gg_row."lat", -__gg_row."lon")) AS __gg_fix');
    expect(query.sql).toContain('GROUP BY "hex"');
    expect(query.sql).toContain(`LIMIT ${MAX_MAP_AIRCRAFT}`);
  });

  it('reads columns named by the spec, and nulls the attributes a table lacks', () => {
    const columns: CompileColumn[] = [
      { name: 'icao', type: 'integer' },
      { name: 'seen at', type: 'timestamp' },
      { name: 'latitude', type: 'float' },
      { name: 'longitude', type: 'float' },
      { name: 'flight', type: 'integer' },
    ];
    const query = compileMapLatestQuery(TABLE, { kind: 'map', id: 'icao', time: 'seen at', lat: 'latitude', lon: 'longitude' }, columns, { dataClockMs: 120_000 });
    expect(query.sql).toMatchSnapshot();
    expect(query.sql).toContain('CAST(NULL AS DOUBLE) AS "altBaroFt"');
    expect(query.sql).toContain('coalesce(CAST(NULL AS BOOLEAN), false) AS "onGround"');
    expect(query.sql).toContain('TRY_CAST("flight" AS VARCHAR) AS "flight"');
    expect(query.params).toEqual([30_000, 120_000]);
  });

  it('keeps an aircraft for 90 s after its last fix (fixtures have 60–70 s gaps), starting at 0 for an earlier clock', () => {
    expect(MAP_FRESHNESS_MS).toBe(90_000);
    expect(compileMapLatestQuery(TABLE, { kind: 'map' }, flightColumns, { dataClockMs: CLOCK }).params).toEqual([CLOCK - 90_000, CLOCK]);
    expect(compileMapLatestQuery(TABLE, { kind: 'map' }, flightColumns, { dataClockMs: 80_000 }).params).toEqual([0, 80_000]);
    expect(compileMapLatestQuery(TABLE, { kind: 'map' }, flightColumns, { dataClockMs: 10 }).params).toEqual([0, 10]);
  });

  it('reports unusable specs and clocks with paths', () => {
    const latest = (spec: object, clock = CLOCK, columns = flightColumns) => () => compileMapLatestQuery(TABLE, { kind: 'map', ...spec }, columns, { dataClockMs: clock });
    expectCompileError(latest({ lat: 'nope' }), 'unknown_column', /Unknown column "nope" at lat/, 'lat');
    expectCompileError(latest({ lat: 'hex' }), 'type_mismatch', /lat must be a numeric column/, 'lat');
    expectCompileError(latest({ id: 'onGround' }), 'type_mismatch', /id must be a text or integer column/, 'id');
    expectCompileError(latest({ time: 'altBaroFt' }), 'type_mismatch', /time must be a timestamp column/, 'time');
    expectCompileError(latest({ filters: [{ kind: 'range', column: 'hex', min: 1 }] }), 'type_mismatch', /Range filters need/, 'filters[0].column');
    expectCompileError(latest({}, 1.5), 'invalid_spec', /whole epoch milliseconds/, 'dataClockMs');
    expectCompileError(latest({}, -1), 'invalid_spec', /whole epoch milliseconds/, 'dataClockMs');
    expectCompileError(latest({ trailMinutes: 99 }), 'invalid_spec', /Invalid map spec/);
  });
});

describe('compileMapTrailsQuery', () => {
  it('thins the trails of the aircraft on the map to 1/100 of the trail, ordered by aircraft and time', () => {
    const query = compileMapTrailsQuery(TABLE, { kind: 'map', trailMinutes: 5, filters: [{ kind: 'notNull', column: 'flight' }] }, flightColumns, { dataClockMs: CLOCK });
    expect(query.sql).toMatchSnapshot();
    // Latest window, then the trail window and its bucket (5 min / 100 = 3 s).
    expect(query.params).toEqual([CLOCK - MAP_FRESHNESS_MS, CLOCK, CLOCK - 5 * 60_000, CLOCK, 3_000]);
    expect(query.sql).toContain('"hex" IN (SELECT "hex" FROM shown)');
    expect(query.sql).toContain(`ORDER BY 1, 2\nLIMIT ${MAX_MAP_TRAIL_POINTS}`);
    // L4: the trails ignore the spec's filters (the component draws those of the aircraft shown), so a filter
    // elsewhere leaves this query, and its cached answer, as it was.
    expect(query.sql).not.toContain('"flight" IS NOT NULL');
    expect(compileMapTrailsQuery(TABLE, { kind: 'map', trailMinutes: 5 }, flightColumns, { dataClockMs: CLOCK })).toEqual(query);
  });

  it('a 30-minute trail uses 18 s buckets; no trail is an empty window', () => {
    expect(compileMapTrailsQuery(TABLE, { kind: 'map', trailMinutes: 30 }, flightColumns, { dataClockMs: CLOCK }).params.at(-1)).toBe(18_000);
    const none = compileMapTrailsQuery(TABLE, { kind: 'map', trailMinutes: 0 }, flightColumns, { dataClockMs: CLOCK });
    expect(none.params.slice(2)).toEqual([CLOCK, CLOCK, 1]);
  });
});

describe('compileMapTrackQuery (L4)', () => {
  it('one aircraft, its fixes in the two hours up to the clock, thinned to MAP_TRACK_BUCKETS buckets of at least 2 s, ordered by time and capped', () => {
    const query = compileMapTrackQuery(TABLE, { kind: 'map', filters: [{ kind: 'notNull', column: 'flight' }] }, flightColumns, { dataClockMs: CLOCK, aircraft: 'a1b2c3' });
    expect(query.sql).toMatchSnapshot();
    expect(query.params).toEqual(['a1b2c3', CLOCK, CLOCK - MAP_TRACK_SPAN_MS, MAP_TRACK_BUCKETS, MIN_MAP_TRACK_BUCKET_MS]);
    // The id column as it is (no cast of every row's value), and a bounded time range (review: a day's table was
    // scanned whole on every step).
    expect(query.sql).toContain('WHERE "hex" = CAST($1 AS VARCHAR) AND "ts" <= epoch_ms(CAST($2 AS BIGINT)) AND "ts" > epoch_ms(CAST($3 AS BIGINT))');
    expect(query.sql).not.toContain('CAST("hex"');
    expect(MAP_TRACK_SPAN_MS).toBe(7_200_000);
    expect(query.sql).toContain(`ORDER BY 2\nLIMIT ${MAX_MAP_TRACK_POINTS}`);
    expect(MAX_MAP_TRACK_POINTS).toBe(2_001);
    // The map's filters do not apply (the selected aircraft passed them).
    expect(query.sql).not.toContain('"flight" IS NOT NULL');
  });

  it('an integer id column: the aircraft cast to it, not the column to text', () => {
    const columns = flightColumns.map((column) => (column.name === 'hex' ? { ...column, type: 'integer' as const } : column));
    const query = compileMapTrackQuery(TABLE, { kind: 'map' }, columns, { dataClockMs: CLOCK, aircraft: '42' });
    expect(query.sql).toContain('WHERE "hex" = TRY_CAST(CAST($1 AS VARCHAR) AS BIGINT) AND');
  });

  it('refuses a missing or oversized aircraft id with a path, and the map spec errors as the other queries do', () => {
    const track = (aircraft: string, spec: object = {}) => () => compileMapTrackQuery(TABLE, { kind: 'map', ...spec }, flightColumns, { dataClockMs: CLOCK, aircraft });
    expectCompileError(track(''), 'invalid_spec', /The aircraft must be an id/, 'aircraft');
    expectCompileError(track('x'.repeat(65)), 'invalid_spec', /The aircraft must be an id/, 'aircraft');
    expectCompileError(track('a1b2c3', { lat: 'hex' }), 'type_mismatch', /lat must be a numeric column/, 'lat');
  });
});
