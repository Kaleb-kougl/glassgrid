/**
 * Shared by `globe-history` (adsb.lol archive days) and `record-flights`
 * (live polling): the flight-point table, its Parquet layout, and the
 * aircraft-in-view measurements.
 *
 * Points are appended to a staging table with one column per
 * `FlightPoint` field (`ts` as epoch milliseconds) and written with
 * `writeFlightParquet`: duplicates on (hex, ts) dropped, values rounded to
 * the precision below, sorted by (hex, ts), zstd Parquet written by one
 * thread, so the same points always give the same bytes.
 *
 * Parquet columns are `FlightPoint`'s fields, in `FLIGHT_POINT_FIELDS`
 * order, with the same names and these storage types:
 *
 * - `ts`: a UTC timestamp in milliseconds (Parquet TIMESTAMP(MILLIS); DuckDB
 *   reads it as TIMESTAMP) rather than a number, so the app can chart it;
 *   `epoch_ms(ts)` gives the number back;
 * - `lat` DECIMAL(7,5) and `lon` DECIMAL(8,5): exact 5-decimal values,
 *   stored as delta-encoded integers (a third of the size of DOUBLE);
 * - altitudes and vertical rates INTEGER, speed and track DOUBLE, flags
 *   BOOLEAN, the rest VARCHAR.
 *
 * Rows are grouped by aircraft (hex, then time): each track is contiguous,
 * which is what makes the file small (the day file is 2.3x larger sorted
 * by time). A replay reads it with `ORDER BY ts`.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import type { DuckDBAppender, DuckDBConnection } from '@duckdb/node-api';
import { FLIGHT_POINT_FIELDS, type FlightPoint } from '@glassgrid/core';
import { sqlString } from './common.ts';
import { describeQuery } from './duck.ts';
import type { ColumnSpec } from './manifest.ts';

/** Staging column types, in FLIGHT_POINT_FIELDS order. */
const STAGING_TYPES: Record<(typeof FLIGHT_POINT_FIELDS)[number], string> = {
  ts: 'BIGINT',
  hex: 'VARCHAR',
  flight: 'VARCHAR',
  registration: 'VARCHAR',
  typeCode: 'VARCHAR',
  lat: 'DOUBLE',
  lon: 'DOUBLE',
  altBaroFt: 'DOUBLE',
  altGeomFt: 'DOUBLE',
  onGround: 'BOOLEAN',
  gsKt: 'DOUBLE',
  trackDeg: 'DOUBLE',
  baroRateFpm: 'DOUBLE',
  geomRateFpm: 'DOUBLE',
  category: 'VARCHAR',
  squawk: 'VARCHAR',
  posType: 'VARCHAR',
  source: 'VARCHAR',
};

/**
 * Stored precision. Positions to 5 decimals (about 1.1 m north-south, 0.9 m
 * east-west at 37.7°N; readsb traces carry 6); altitudes and vertical rates
 * to whole feet and feet per minute (readsb reports them in steps of 25 ft
 * and 64 fpm); speed and track to 0.1 kt and 0.1°.
 */
export const FLIGHT_PRECISION = {
  latLonDecimals: 5,
  speedTrackDecimals: 1,
} as const;

/** The SELECT list that turns staging rows into the Parquet columns. */
const OUTPUT_COLUMNS = [
  'CAST(epoch_ms(ts) AS TIMESTAMP_MS) AS ts',
  'hex',
  'flight',
  'registration',
  '"typeCode"',
  `CAST(lat AS DECIMAL(7, ${FLIGHT_PRECISION.latLonDecimals})) AS lat`,
  `CAST(lon AS DECIMAL(8, ${FLIGHT_PRECISION.latLonDecimals})) AS lon`,
  'CAST(round("altBaroFt") AS INTEGER) AS "altBaroFt"',
  'CAST(round("altGeomFt") AS INTEGER) AS "altGeomFt"',
  '"onGround"',
  `round("gsKt", ${FLIGHT_PRECISION.speedTrackDecimals}) AS "gsKt"`,
  // round(359.96, 1) is 360.0: wrap it to 0 to keep [0, 360).
  `round("trackDeg", ${FLIGHT_PRECISION.speedTrackDecimals}) % 360 AS "trackDeg"`,
  'CAST(round("baroRateFpm") AS INTEGER) AS "baroRateFpm"',
  'CAST(round("geomRateFpm") AS INTEGER) AS "geomRateFpm"',
  'category',
  'squawk',
  '"posType"',
  'source',
];

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Parquet writer options, as for the web demo samples (DuckDB-WASM 1.32 reads them). */
export const FLIGHT_PARQUET_OPTIONS = 'FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 19, ROW_GROUP_SIZE 122880, PARQUET_VERSION V2';

export async function createFlightTable(conn: DuckDBConnection, table: string): Promise<void> {
  const columns = FLIGHT_POINT_FIELDS.map((field) => `${quote(field)} ${STAGING_TYPES[field]}`).join(', ');
  await conn.run(`CREATE OR REPLACE TABLE ${quote(table)} (${columns})`);
}

function appendText(appender: DuckDBAppender, value: string | null): void {
  if (value === null) appender.appendNull();
  else appender.appendVarchar(value);
}

function appendNumber(appender: DuckDBAppender, value: number | null): void {
  if (value === null) appender.appendNull();
  else appender.appendDouble(value);
}

/** Appends points in FLIGHT_POINT_FIELDS order. The caller flushes and closes the appender. */
export function appendFlightPoints(appender: DuckDBAppender, points: Iterable<FlightPoint>): number {
  let n = 0;
  for (const p of points) {
    appender.appendBigInt(BigInt(p.ts));
    appender.appendVarchar(p.hex);
    appendText(appender, p.flight);
    appendText(appender, p.registration);
    appendText(appender, p.typeCode);
    appender.appendDouble(p.lat);
    appender.appendDouble(p.lon);
    appendNumber(appender, p.altBaroFt);
    appendNumber(appender, p.altGeomFt);
    appender.appendBoolean(p.onGround);
    appendNumber(appender, p.gsKt);
    appendNumber(appender, p.trackDeg);
    appendNumber(appender, p.baroRateFpm);
    appendNumber(appender, p.geomRateFpm);
    appendText(appender, p.category);
    appendText(appender, p.squawk);
    appendText(appender, p.posType);
    appender.appendVarchar(p.source);
    appender.endRow();
    n += 1;
  }
  return n;
}

/**
 * The output query: rows of `table` with `where` (SQL over staging columns,
 * `ts` in epoch ms), one row per (hex, ts) (the first in a full ordering of
 * the other columns), rounded, ordered by hex, ts.
 */
export function flightOutputQuery(table: string, where = 'true'): string {
  const tieBreak = FLIGHT_POINT_FIELDS.filter((f) => f !== 'hex' && f !== 'ts').map((f) => `${quote(f)} NULLS LAST`).join(', ');
  return `SELECT ${OUTPUT_COLUMNS.join(', ')}
FROM ${quote(table)}
WHERE ${where}
QUALIFY row_number() OVER (PARTITION BY hex, ts ORDER BY ${tieBreak}) = 1
ORDER BY hex, ts`;
}

export interface WrittenParquet {
  file: string;
  rows: number;
  bytes: number;
  sha256: string;
  distinctAircraft: number;
  /** ISO 8601 UTC of the first and last fix, null when empty. */
  firstFix: string | null;
  lastFix: string | null;
  columns: ColumnSpec[];
  query: string;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Writes `flightOutputQuery(table, where)` to `outPath` (via a `.partial`
 * file) and reads back what was written. Run it on a one-thread connection
 * for reproducible bytes.
 */
export async function writeFlightParquet(conn: DuckDBConnection, table: string, outPath: string, where = 'true'): Promise<WrittenParquet> {
  const query = flightOutputQuery(table, where);
  const partial = `${outPath}.partial`;
  await rm(partial, { force: true });
  try {
    await conn.run(`COPY (${query}) TO ${sqlString(partial)} (${FLIGHT_PARQUET_OPTIONS})`);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  await rename(partial, outPath);
  const src = `read_parquet(${sqlString(outPath)})`;
  const row = (
    await conn.runAndReadAll(
      `SELECT count(*) AS n, count(DISTINCT hex) AS hexes, strftime(min(ts), '%Y-%m-%dT%H:%M:%S.%gZ') AS first, strftime(max(ts), '%Y-%m-%dT%H:%M:%S.%gZ') AS last FROM ${src}`,
    )
  ).getRowObjects()[0];
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    file: outPath,
    rows: Number(row?.['n'] ?? 0),
    bytes: (await stat(outPath)).size,
    sha256: await sha256File(outPath),
    distinctAircraft: Number(row?.['hexes'] ?? 0),
    firstFix: text(row?.['first']),
    lastFix: text(row?.['last']),
    columns: await describeQuery(conn, `SELECT * FROM ${src}`),
    query,
  };
}

// ---------------------------------------------------------------------------
// Aircraft in view

/** Snapshot cadence and how long a fix stays "in view" in a snapshot. */
export const SNAPSHOT = { tickMs: 10_000, holdMs: 60_000 } as const;

/**
 * Creates `snapshots(tick BIGINT, hex VARCHAR)`: at every 10 s tick in
 * [startMs, endMs), the aircraft whose latest fix is less than 60 s old
 * (a fix at f is in the snapshots at ticks t with f <= t < f + 60 s). Fixes
 * come from `table` (staging columns, `ts` in epoch ms), which holds only
 * in-box fixes, so an aircraft that leaves the box stays in view for up to
 * 60 s after its last fix inside it.
 */
export async function createSnapshots(conn: DuckDBConnection, table: string, startMs: number, endMs: number): Promise<void> {
  const { tickMs, holdMs } = SNAPSHOT;
  await conn.run(`CREATE OR REPLACE TABLE snapshots AS
SELECT DISTINCT tick, hex FROM (
  SELECT hex, unnest(range(CAST(ceil(ts / ${tickMs}) AS BIGINT) * ${tickMs}, ts + ${holdMs}, ${tickMs})) AS tick
  FROM ${quote(table)}
  WHERE ts >= ${startMs - holdMs} AND ts < ${endMs}
) WHERE tick >= ${startMs} AND tick < ${endMs}`);
  await conn.run(`CREATE OR REPLACE TABLE in_view AS
SELECT t.tick, count(s.hex) AS aircraft
FROM (SELECT unnest(range(${startMs}, ${endMs}, ${tickMs})) AS tick) t
LEFT JOIN snapshots s USING (tick)
GROUP BY t.tick`);
}

export interface InViewStats {
  snapshots: number;
  peak: number;
  /** ISO 8601 UTC of the first snapshot with the peak count. */
  peakAt: string | null;
  /** Median of the per-snapshot counts (DuckDB `median`: the mean of the two middle values for an even count). */
  median: number;
  mean: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Peak, median and mean aircraft in view over the `in_view` ticks in [startMs, endMs). */
export async function inViewStats(conn: DuckDBConnection, startMs: number, endMs: number): Promise<InViewStats> {
  const row = (
    await conn.runAndReadAll(`WITH v AS (SELECT * FROM in_view WHERE tick >= ${startMs} AND tick < ${endMs})
SELECT count(*) AS n, max(aircraft) AS peak, (SELECT tick FROM v ORDER BY aircraft DESC, tick LIMIT 1) AS peak_tick,
  median(aircraft) AS med, avg(aircraft) AS mean
FROM v`)
  ).getRowObjects()[0];
  const n = Number(row?.['n'] ?? 0);
  return {
    snapshots: n,
    peak: Number(row?.['peak'] ?? 0),
    peakAt: n > 0 ? iso(Number(row?.['peak_tick'])) : null,
    median: Number(row?.['med'] ?? 0),
    mean: Math.round(Number(row?.['mean'] ?? 0) * 100) / 100,
  };
}

export interface BusiestWindow {
  startMs: number;
  endMs: number;
  /** Distinct aircraft in the window's snapshots. */
  distinctAircraft: number;
  /** Sum of the window's per-snapshot counts (the tie-break). */
  aircraftSnapshots: number;
}

/**
 * The `windowMs` window, starting on a whole minute within [startMs, endMs),
 * whose snapshots hold the most distinct aircraft. Ties go to the most
 * aircraft-snapshots (the busier screen on average), then to the earliest
 * start. Needs `createSnapshots` first.
 */
export async function busiestWindow(conn: DuckDBConnection, startMs: number, endMs: number, windowMs: number): Promise<BusiestWindow> {
  const minuteMs = 60_000;
  const minutes = Math.floor(windowMs / minuteMs);
  if (minutes * minuteMs !== windowMs) throw new Error('windowMs must be whole minutes');
  const lastStart = Math.floor((endMs - windowMs - startMs) / minuteMs);
  const row = (
    await conn.runAndReadAll(`WITH presence AS (
  SELECT hex, (tick - ${startMs}) // ${minuteMs} AS m, count(*) AS snaps FROM snapshots GROUP BY ALL
), candidates AS (SELECT unnest(range(0, ${lastStart + 1})) AS k),
scored AS (
  SELECT c.k, count(DISTINCT p.hex) AS hexes, coalesce(sum(p.snaps), 0) AS snaps
  FROM candidates c LEFT JOIN presence p ON p.m >= c.k AND p.m < c.k + ${minutes}
  GROUP BY c.k
)
SELECT k, hexes, snaps FROM scored ORDER BY hexes DESC, snaps DESC, k ASC LIMIT 1`)
  ).getRowObjects()[0];
  if (!row) throw new Error('busiestWindow: the day has no whole window');
  const start = startMs + Number(row['k']) * minuteMs;
  return { startMs: start, endMs: start + windowMs, distinctAircraft: Number(row['hexes']), aircraftSnapshots: Number(row['snaps']) };
}
