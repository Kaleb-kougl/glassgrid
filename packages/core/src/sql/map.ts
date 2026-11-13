import { type CompileColumn } from '../spec/column.js';
import {
  MAP_FRESHNESS_MS,
  MAP_TRACK_BUCKETS,
  MAP_TRACK_SPAN_MS,
  MAP_TRAIL_BUCKETS,
  MapSpecSchema,
  MAX_MAP_AIRCRAFT,
  MAX_MAP_AIRCRAFT_ID,
  MAX_MAP_TRACK_POINTS,
  MAX_MAP_TRAIL_POINTS,
  MIN_MAP_TRACK_BUCKET_MS,
  type MapSpec,
  type MapSpecInput,
} from '../spec/map.js';
import { Params, quoteIdent, type CompiledQuery } from './builder.js';
import { ColumnIndex } from './columns.js';
import { CompileError } from './errors.js';
import { filterPredicates, parseOrThrow } from './where.js';

/*
 * Map view queries (docs/live-flights-l3-data.md). Two per map view and data
 * clock, both over the table's view and both bounded:
 *
 * - **latest**: one row per aircraft, its newest fix in (clock - 90 s,
 *   clock] (an `arg_max` of the row by time, ties by lat then lon); then the
 *   spec's filters on that fix; at most MAX_MAP_AIRCRAFT (the freshest).
 * - **trails**: the fixes of the aircraft seen in that window (before the
 *   spec's filters, since L4: the component draws the shown ones) in
 *   (clock - trail, clock], thinned to the newest fix per aircraft and
 *   1/100 of the trail (at most 101 points each), ordered by aircraft and
 *   time.
 *
 * - **track** (L4): every fix of one aircraft up to the clock, thinned to
 *   at most MAP_TRACK_BUCKETS points over its span, ordered by time.
 *
 * Fixes after the data clock are ignored, so a query at a given clock means
 * the same on a table that holds the whole day (a Parquet file, a replay
 * without retention) and on one that only reached it. The output columns
 * are exactly the map component's `MapAircraft` / `MapTrailPoint` fields:
 * numbers as DOUBLE (DECIMAL positions and INTEGER altitudes converted),
 * `ts` as epoch milliseconds, the id and text attributes as VARCHAR.
 * Attribute columns the table does not have (or cannot cast) are NULL.
 */

export interface MapQueryOptions {
  /** The data clock: epoch milliseconds (an integer), e.g. the last ingested batch's. */
  readonly dataClockMs: number;
}

type Cast = 'VARCHAR' | 'DOUBLE' | 'BOOLEAN';

/** The optional attributes the map shows, by their FlightPoint names. */
const ATTRIBUTES: readonly { name: string; cast: Cast }[] = [
  { name: 'flight', cast: 'VARCHAR' },
  { name: 'registration', cast: 'VARCHAR' },
  { name: 'typeCode', cast: 'VARCHAR' },
  { name: 'category', cast: 'VARCHAR' },
  { name: 'altBaroFt', cast: 'DOUBLE' },
  { name: 'altGeomFt', cast: 'DOUBLE' },
  { name: 'onGround', cast: 'BOOLEAN' },
  { name: 'gsKt', cast: 'DOUBLE' },
  { name: 'trackDeg', cast: 'DOUBLE' },
  { name: 'baroRateFpm', cast: 'DOUBLE' },
];

interface Resolved {
  readonly spec: MapSpec;
  readonly index: ColumnIndex;
  readonly lat: string;
  readonly lon: string;
  readonly id: string;
  /** The id column's type: a text id is compared as it is, an integer one against the aircraft cast to it. */
  readonly idType: 'text' | 'integer';
  readonly time: string;
}

function resolve(spec: MapSpecInput, columns: readonly CompileColumn[], options: MapQueryOptions): Resolved {
  const parsed = parseOrThrow(MapSpecSchema, spec, 'map spec');
  if (!Number.isSafeInteger(options.dataClockMs) || options.dataClockMs < 0) {
    throw new CompileError('invalid_spec', `The data clock must be whole epoch milliseconds; got ${JSON.stringify(options.dataClockMs)}`, 'dataClockMs');
  }
  const index = new ColumnIndex(columns);
  const numeric = (channel: 'lat' | 'lon') => {
    const column = index.get(parsed[channel], channel);
    if (column.type !== 'float' && column.type !== 'decimal' && column.type !== 'integer') {
      throw new CompileError('type_mismatch', `${channel} must be a numeric column of degrees, but ${JSON.stringify(column.name)} is ${column.type}`, channel);
    }
    return quoteIdent(column.name);
  };
  const id = index.get(parsed.id, 'id');
  if (id.type !== 'text' && id.type !== 'integer') {
    throw new CompileError('type_mismatch', `id must be a text or integer column naming one aircraft, but ${JSON.stringify(id.name)} is ${id.type}`, 'id');
  }
  const time = index.get(parsed.time, 'time');
  if (time.type !== 'timestamp') {
    throw new CompileError('type_mismatch', `time must be a timestamp column, but ${JSON.stringify(time.name)} is ${time.type}`, 'time');
  }
  return { spec: parsed, index, lat: numeric('lat'), lon: numeric('lon'), id: quoteIdent(id.name), idType: id.type, time: quoteIdent(time.name) };
}

/** An attribute read by name when the table has it, NULL (or false, for onGround) otherwise. */
function attribute(index: ColumnIndex, name: string, cast: Cast, source: string): string {
  const present = index.columns.some((column) => column.name === name);
  const value = present ? `TRY_CAST(${source} AS ${cast})` : `CAST(NULL AS ${cast})`;
  return name === 'onGround' ? `coalesce(${value}, false)` : value;
}

/**
 * The CTEs `latest` (newest fix per aircraft in the freshness window) and
 * `shown` (those on the map; the spec's filters on that fix unless
 * `filtered` is false).
 *
 * The newest fix is an aggregate, not a window: `arg_max` of the whole row
 * (the relation's alias as a struct) by `(time, -lat, -lon)`, i.e. the
 * newest fix and, among fixes at the same time, the smallest latitude then
 * longitude: exactly `row_number() OVER (PARTITION BY id ORDER BY time
 * DESC, lat, lon) = 1`, which L3 used. On DuckDB-WASM (one thread) the
 * window took 11 to 28 ms over the 90 s window of the busiest half hour and
 * the aggregate 6 (L4, docs/live-flights-l4.md); natively both take about 4.
 */
function latestCtes(table: string, r: Resolved, params: Params, clock: number, filtered = true): string {
  const from = params.epochMs(Math.max(0, clock - MAP_FRESHNESS_MS));
  const to = params.epochMs(clock);
  const filters = filtered ? filterPredicates(r.spec.filters, r.index, params) : [];
  const where = filters.length === 0 ? '' : `\n  WHERE ${filters.join('\n    AND ')}`;
  const row = '__gg_row';
  return (
    `WITH latest AS (\n` +
    `  SELECT unnest(__gg_fix)\n` +
    `  FROM (\n` +
    `    SELECT arg_max(${row}, (${row}.${r.time}, -${row}.${r.lat}, -${row}.${r.lon})) AS __gg_fix\n` +
    `    FROM ${table} AS ${row}\n` +
    `    WHERE ${r.time} > ${from} AND ${r.time} <= ${to}\n` +
    `      AND ${r.id} IS NOT NULL AND ${r.lat} IS NOT NULL AND ${r.lon} IS NOT NULL\n` +
    `    GROUP BY ${r.id}\n` +
    `  )\n` +
    `),\n` +
    `shown AS (\n` +
    `  SELECT *\n` +
    `  FROM latest${where}\n` +
    `  ORDER BY ${r.time} DESC, ${r.id}\n` +
    `  LIMIT ${MAX_MAP_AIRCRAFT}\n` +
    `)`
  );
}

/**
 * The latest fix of every aircraft seen in the minute up to the data clock
 * (and not after it), filtered by the spec's filters on that fix, at most
 * MAX_MAP_AIRCRAFT of them (the freshest), newest first. Columns:
 * `MAP_AIRCRAFT_FIELDS`.
 */
export function compileMapLatestQuery(
  table: string,
  spec: MapSpecInput,
  columns: readonly CompileColumn[],
  options: MapQueryOptions,
): CompiledQuery {
  const r = resolve(spec, columns, options);
  const params = new Params();
  const ctes = latestCtes(table, r, params, options.dataClockMs);
  const attr = (name: string, cast: Cast) => `${attribute(r.index, name, cast, quoteIdent(name))} AS ${quoteIdent(name)}`;
  const select = [
    `CAST(${r.id} AS VARCHAR) AS "hex"`,
    attr('flight', 'VARCHAR'),
    attr('typeCode', 'VARCHAR'),
    attr('category', 'VARCHAR'),
    `CAST(${r.lat} AS DOUBLE) AS "lat"`,
    `CAST(${r.lon} AS DOUBLE) AS "lon"`,
    ...ATTRIBUTES.filter((a) => a.cast !== 'VARCHAR').map((a) => attr(a.name, a.cast)),
    `CAST(epoch_ms(${r.time}) AS DOUBLE) AS "ts"`,
    attr('registration', 'VARCHAR'),
  ];
  return {
    sql: `${ctes}\nSELECT ${select.join(',\n  ')}\nFROM shown\nORDER BY 13 DESC, 1`,
    params: params.values,
  };
}

/**
 * The trails of the aircraft on the map at the same clock: their fixes in
 * (clock - trailMinutes, clock], at most one per aircraft and
 * 1/MAP_TRAIL_BUCKETS of the trail (the newest in each, so the newest fix is
 * always kept), ordered by aircraft then time, at most MAX_MAP_TRAIL_POINTS.
 * Columns: `MAP_TRAIL_FIELDS`. With `trailMinutes: 0` the window is empty
 * and so is the result.
 *
 * Since L4 the spec's filters are not applied here: the trails are those of
 * every aircraft seen in the freshness window (at most MAX_MAP_AIRCRAFT),
 * and the map component draws only those of the aircraft the latest-fix
 * query returns. So a brush, a click or a pan elsewhere changes only the
 * latest-fix query, and the trails come from the result cache (the same SQL
 * and clock); on DuckDB-WASM that saved 20 to 30 ms per brush.
 */
export function compileMapTrailsQuery(
  table: string,
  spec: MapSpecInput,
  columns: readonly CompileColumn[],
  options: MapQueryOptions,
): CompiledQuery {
  const r = resolve(spec, columns, options);
  const params = new Params();
  const clock = options.dataClockMs;
  const ctes = latestCtes(table, r, params, clock, false);
  const trailMs = r.spec.trailMinutes * 60_000;
  const from = params.epochMs(Math.max(0, clock - trailMs));
  const to = params.epochMs(clock);
  const bucket = params.double(Math.max(1, Math.ceil(trailMs / MAP_TRAIL_BUCKETS)));
  const alt = attribute(r.index, 'altBaroFt', 'DOUBLE', quoteIdent('altBaroFt'));
  const trail =
    `trail AS (\n` +
    `  SELECT ${r.id} AS __gg_id, ${r.time} AS __gg_ts, ${r.lat} AS __gg_lat, ${r.lon} AS __gg_lon, ${alt} AS __gg_alt\n` +
    `  FROM ${table}\n` +
    `  WHERE ${r.time} > ${from} AND ${r.time} <= ${to}\n` +
    `    AND ${r.lat} IS NOT NULL AND ${r.lon} IS NOT NULL\n` +
    `    AND ${r.id} IN (SELECT ${r.id} FROM shown)\n` +
    `  QUALIFY row_number() OVER (PARTITION BY ${r.id}, floor(epoch_ms(${r.time}) / ${bucket}) ORDER BY ${r.time} DESC, ${r.lat}, ${r.lon}) = 1\n` +
    `)`;
  const select = [
    `CAST(__gg_id AS VARCHAR) AS "hex"`,
    `CAST(epoch_ms(__gg_ts) AS DOUBLE) AS "ts"`,
    `CAST(__gg_lat AS DOUBLE) AS "lat"`,
    `CAST(__gg_lon AS DOUBLE) AS "lon"`,
    `__gg_alt AS "altBaroFt"`,
  ];
  return {
    sql: `${ctes},\n${trail}\nSELECT ${select.join(',\n  ')}\nFROM trail\nORDER BY 1, 2\nLIMIT ${MAX_MAP_TRAIL_POINTS}`,
    params: params.values,
  };
}

export interface MapTrackOptions extends MapQueryOptions {
  /** The aircraft: a value of the spec's `id` column (the hex id), as text. */
  readonly aircraft: string;
}

/**
 * One aircraft's track (L4, docs/live-flights-l4.md): its fixes in the two
 * hours up to the data clock (`clock - MAP_TRACK_SPAN_MS < time <= clock`:
 * the whole 60-minute live window, or the last two hours of an archived
 * day), thinned to the newest fix per
 * bucket of `max(2 s, span / MAP_TRACK_BUCKETS)`, where the span is the
 * aircraft's own first to last fix up to the clock. So a track has at most
 * MAP_TRACK_BUCKETS + 1 points whatever its length, always its first and
 * newest fix (the first bucket's newest, and the last bucket's), ordered by
 * time. The spec's filters are not applied: the track belongs to the aircraft
 * selected on the map, which already passed them at its latest fix.
 * Columns: `MAP_TRAIL_FIELDS`.
 */
export function compileMapTrackQuery(
  table: string,
  spec: MapSpecInput,
  columns: readonly CompileColumn[],
  options: MapTrackOptions,
): CompiledQuery {
  const r = resolve(spec, columns, options);
  if (typeof options.aircraft !== 'string' || options.aircraft === '' || options.aircraft.length > MAX_MAP_AIRCRAFT_ID) {
    throw new CompileError('invalid_spec', `The aircraft must be an id of 1 to ${MAX_MAP_AIRCRAFT_ID} characters; got ${JSON.stringify(options.aircraft)}`, 'aircraft');
  }
  const params = new Params();
  const id = params.text(options.aircraft);
  const to = params.epochMs(options.dataClockMs);
  const from = params.epochMs(options.dataClockMs - MAP_TRACK_SPAN_MS);
  const buckets = params.double(MAP_TRACK_BUCKETS);
  const minBucket = params.double(MIN_MAP_TRACK_BUCKET_MS);
  const alt = attribute(r.index, 'altBaroFt', 'DOUBLE', quoteIdent('altBaroFt'));
  // The id column compared as it is (a text id, the usual hex) or the id cast to it (an integer id): never a cast of
  // every row's value, which would keep DuckDB from using the column's statistics.
  const sameAircraft = r.idType === 'integer' ? `${r.id} = TRY_CAST(${id} AS BIGINT)` : `${r.id} = ${id}`;
  const sql =
    `WITH fixes AS (\n` +
    `  SELECT epoch_ms(${r.time}) AS __gg_ms, ${r.lat} AS __gg_lat, ${r.lon} AS __gg_lon, ${alt} AS __gg_alt\n` +
    `  FROM ${table}\n` +
    `  WHERE ${sameAircraft} AND ${r.time} <= ${to} AND ${r.time} > ${from}\n` +
    `    AND ${r.lat} IS NOT NULL AND ${r.lon} IS NOT NULL\n` +
    `),\n` +
    `span AS (\n` +
    `  SELECT min(__gg_ms) AS __gg_first, greatest(${minBucket}, ceil((max(__gg_ms) - min(__gg_ms) + 1) / ${buckets})) AS __gg_bucket FROM fixes\n` +
    `),\n` +
    `track AS (\n` +
    `  SELECT fixes.* FROM fixes, span\n` +
    `  QUALIFY row_number() OVER (PARTITION BY floor((__gg_ms - __gg_first) / __gg_bucket) ORDER BY __gg_ms DESC, __gg_lat, __gg_lon) = 1\n` +
    `)\n` +
    `SELECT ${id} AS "hex", CAST(__gg_ms AS DOUBLE) AS "ts", CAST(__gg_lat AS DOUBLE) AS "lat", CAST(__gg_lon AS DOUBLE) AS "lon", __gg_alt AS "altBaroFt"\n` +
    `FROM track\n` +
    `ORDER BY 2\n` +
    `LIMIT ${MAX_MAP_TRACK_POINTS}`;
  return { sql, params: params.values };
}
