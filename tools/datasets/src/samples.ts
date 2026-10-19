/**
 * The web demo's sample datasets and their workspaces.
 *
 *   pnpm --filter @glassgrid/datasets samples            # writes apps/web/public/samples/
 *   pnpm --filter @glassgrid/datasets samples -- --out DIR --only taxi
 *
 * Three synthetic tables, made up from scratch by seeded DuckDB SQL (no
 * third-party data, so no licence questions), each written as a
 * zstd-compressed Parquet file, plus one `.glassgrid` (format v1) workspace
 * per table with a few cross-filtered charts. The workspace files are
 * written with @glassgrid/core's serializer, so they validate by
 * construction; their column types are what the engine infers from the
 * Parquet (DuckDB's DESCRIBE, mapped as `simpleColumnType` in
 * packages/engine does), and the fingerprint is the engine's function of
 * the file (size, a fixed mtime, SHA-256 of the first and last 1 MB).
 *
 * Determinism: values are pure functions of (seed, row, column salt) from
 * DuckDB's hash() and integer arithmetic (as in synthetic.ts: no random()),
 * written single-threaded in a fixed order, so the same recipe and DuckDB
 * version give the same bytes. `samples.manifest.json` records rows, sizes
 * and SHA-256 of every file.
 */
import { createHash } from 'node:crypto';
import { open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  compileChartQuery,
  isCompileError,
  serializeWorkspace,
  toFileHandle,
  type ChartSpecInput,
  type ColumnType,
  type WorkspaceSnapshot,
} from '@glassgrid/core';
import { ensureDir, formatBytes, log, PACKAGE_ROOT, PACKAGE_VERSION, runCli, seconds, sqlString } from './lib/common.ts';
import { describeQuery, openDuck, type Duck } from './lib/duck.ts';

/** Bump when a sample's bytes would change for the same seed. */
const RECIPE = 'samples/1';
const SEED = 7;
/** Written into each file and used as its mtime, so the workspace fingerprints are reproducible. */
const SAVED_AT = '2026-10-18T00:00:00.000Z';
const APP = { name: 'Glassgrid', version: '0.0.0' };
const DEFAULT_OUT = path.resolve(PACKAGE_ROOT, '..', '..', 'apps', 'web', 'public', 'samples');

interface ChartDef {
  readonly title: string;
  readonly spec: ChartSpecInput;
}

interface Sample {
  readonly id: string;
  readonly fileName: string;
  readonly title: string;
  readonly description: string;
  /** SELECT … ORDER BY …, using the h/pick/u macros. */
  readonly query: string;
  readonly charts: readonly ChartDef[];
}

// ---------------------------------------------------------------------------
// Helpers that build SQL from small JS tables

const MACROS = [
  // 64-bit hash of (row, seed, salt).
  `CREATE OR REPLACE TEMP MACRO h(i, k) AS hash(i::BIGINT, ${SEED}::BIGINT, k::INTEGER)`,
  // Integer in [0, n).
  `CREATE OR REPLACE TEMP MACRO pick(i, k, n) AS (h(i, k) % n::UBIGINT)::BIGINT`,
  // Uniform in [0, 1) with 1e-6 resolution (integer based, no libm).
  `CREATE OR REPLACE TEMP MACRO u(i, k) AS CAST(pick(i, k, 1000000) AS DOUBLE) / 1000000`,
];

const list = (values: readonly (string | number)[]) =>
  `[${values.map((value) => (typeof value === 'number' ? String(value) : sqlString(value))).join(', ')}]`;

/** `values[pick]` where each value appears `weight` times: a weighted draw from one hash. */
function weighted(values: readonly (string | number)[], weights: readonly number[], i: string, salt: number): string {
  const expanded: (string | number)[] = [];
  values.forEach((value, index) => {
    for (let n = 0; n < (weights[index] ?? 0); n += 1) expanded.push(value);
  });
  return `${list(expanded)}[1 + pick(${i}, ${salt}, ${expanded.length})]`;
}

/** Day offsets from `start`, each repeated by `weight(date)`: picks a day with seasonality and weekday shape. */
function weightedDays(start: Date, days: number, weight: (date: Date, index: number) => number): number[] {
  const out: number[] = [];
  for (let d = 0; d < days; d += 1) {
    const date = new Date(start.getTime() + d * 86_400_000);
    const w = Math.max(0, Math.round(weight(date, d)));
    for (let n = 0; n < w; n += 1) out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Taxi trips: a made-up city ("Glassport"), first half of 2025

const ZONES = ['Midtown', 'Downtown', 'Airport', 'Harbor', 'University', 'Old Town', 'Riverside', 'Tech Park', 'Stadium', 'Northside', 'Eastgate', 'West End'];
const ZONE_WEIGHTS = [22, 18, 7, 8, 9, 10, 6, 7, 3, 4, 3, 3];
/** Zone centres (lat, lon) around a fictional city centre at 52.000, 4.000. */
const ZONE_LAT = [52.0, 51.986, 52.06, 51.972, 52.018, 51.995, 52.008, 52.03, 51.979, 52.041, 52.012, 51.99];
const ZONE_LON = [4.0, 4.012, 3.9, 4.03, 3.975, 4.02, 4.045, 3.96, 3.985, 4.005, 4.06, 3.94];
/** Relative trips per hour of day (0..23): night lull, two rush hours, evening tail. */
const HOUR_WEIGHTS = [5, 3, 2, 1, 1, 2, 5, 11, 16, 13, 10, 10, 11, 11, 11, 12, 14, 17, 18, 15, 12, 10, 9, 7];
const RUSH = [7, 8, 9, 16, 17, 18];

const TAXI_TRIPS = 2_000_000;

function taxiQuery(): string {
  const start = new Date(Date.UTC(2025, 0, 1));
  // Weekdays busier than weekends, slow growth over the half year, a few quiet holidays.
  const quiet = new Set([0, 110, 119]);
  const days = weightedDays(start, 181, (date, index) => {
    const weekday = date.getUTCDay();
    const base = weekday === 0 ? 7 : weekday === 6 ? 8 : weekday === 5 ? 11 : 10;
    return (quiet.has(index) ? base * 0.5 : base) * (1 + index / 600);
  });
  const hours = HOUR_WEIGHTS.flatMap((weight, hour) => Array<number>(weight).fill(hour));
  return `
WITH base AS (
  SELECT
    i,
    ${list(days)}[1 + pick(i, 1, ${days.length})] AS day,
    ${list(hours)}[1 + pick(i, 2, ${hours.length})] AS hour,
    pick(i, 3, 3600) AS second_of_hour,
    1 + pick(i, 4, ${ZONE_WEIGHTS.reduce((a, b) => a + b, 0)}) AS pz_slot,
    ${weighted(ZONES.map((_, index) => index + 1), ZONE_WEIGHTS, 'i', 5)} AS dz,
    u(i, 6) AS ud1, u(i, 7) AS ud2, u(i, 8) AS us,
    pick(i, 9, 100) AS ppay, pick(i, 10, 100) AS ppass, u(i, 11) AS utip,
    u(i, 12) AS ulat1, u(i, 13) AS ulat2, u(i, 14) AS ulon1, u(i, 15) AS ulon2
  FROM range(${TAXI_TRIPS}) AS t(i)
), zoned AS (
  SELECT *,
    ${weighted(ZONES.map((_, index) => index + 1), ZONE_WEIGHTS, 'i', 4)} AS pz
  FROM base
), trips AS (
  SELECT *,
    -- km: mostly short hops, a long tail, airport runs much longer.
    round(0.6 + 14 * ud1 * ud1 * ud1 + 3 * ud2 + CASE WHEN pz = 3 OR dz = 3 THEN 14 + 6 * ud2 ELSE 0 END, 1) AS km,
    CASE WHEN hour IN (${RUSH.join(', ')}) THEN 16 + 8 * us ELSE 24 + 12 * us END AS kmh
  FROM zoned
), priced AS (
  SELECT *,
    greatest(2, round(km / kmh * 60 + 2 + 4 * ud2, 0))::INTEGER AS minutes,
    CASE WHEN ppay < 70 THEN 'card' WHEN ppay < 88 THEN 'cash' WHEN ppay < 97 THEN 'app' ELSE 'voucher' END AS payment
  FROM trips
)
SELECT
  make_timestamp((${Math.trunc(start.getTime() / 1000)} + day * 86400 + hour * 3600 + second_of_hour) * 1000000) AS pickup_at,
  ${list(ZONES)}[pz] AS pickup_zone,
  ${list(ZONES)}[dz] AS dropoff_zone,
  CAST(CASE WHEN ppass < 68 THEN 1 WHEN ppass < 84 THEN 2 WHEN ppass < 91 THEN 3 WHEN ppass < 96 THEN 4 ELSE 5 + ppass % 2 END AS INTEGER) AS passengers,
  km AS distance_km,
  minutes AS duration_min,
  round(3.2 + 1.65 * km + 0.32 * minutes, 2) AS fare,
  CASE WHEN payment IN ('card', 'app') THEN round((3.2 + 1.65 * km + 0.32 * minutes) * (0.06 + 0.24 * utip * utip), 2) ELSE 0.0 END AS tip,
  payment AS payment_type,
  round(${list(ZONE_LAT)}[pz] + (ulat1 + ulat2 - 1) * 0.012, 4) AS pickup_lat,
  round(${list(ZONE_LON)}[pz] + (ulon1 + ulon2 - 1) * 0.02, 4) AS pickup_lon
FROM priced
ORDER BY pickup_at, i`;
}

// ---------------------------------------------------------------------------
// 2. Retail orders: three years of a made-up chain, in-store and online

const CATEGORIES = ['Grocery', 'Home', 'Apparel', 'Electronics', 'Beauty', 'Sports', 'Toys', 'Books', 'Garden', 'Pet'];
const CATEGORY_WEIGHTS = [26, 12, 14, 9, 9, 7, 6, 6, 5, 6];
/** Typical unit price per category. */
const CATEGORY_PRICE = [4.5, 32, 28, 180, 16, 45, 24, 14, 22, 18];
const REGIONS = ['North', 'South', 'East', 'West', 'Central', 'Coastal'];
const REGION_WEIGHTS = [16, 18, 15, 20, 21, 10];
const RETAIL_ORDERS = 1_500_000;

function retailQuery(): string {
  const start = new Date(Date.UTC(2023, 0, 1));
  const days = weightedDays(start, 1096, (date, index) => {
    const weekday = date.getUTCDay();
    const month = date.getUTCMonth();
    const dayOfMonth = date.getUTCDate();
    let w = weekday === 6 ? 13 : weekday === 0 ? 11 : 9;
    if (month === 10) w *= 1.3;
    if (month === 11) w *= dayOfMonth <= 24 ? 1.8 : 1.1;
    if (month === 0 || month === 1) w *= 0.85;
    // Black Friday-ish spike: the fourth Friday of November.
    if (month === 10 && weekday === 5 && dayOfMonth >= 22 && dayOfMonth <= 28) w *= 3;
    return w * (1 + index / 1800);
  });
  return `
WITH base AS (
  SELECT
    i,
    ${list(days)}[1 + pick(i, 21, ${days.length})] AS day,
    pick(i, 22, 100) AS pchannel,
    pick(i, 23, 1000) AS pcat,
    u(i, 24) AS uprice1, u(i, 25) AS uprice2,
    pick(i, 26, 1000) AS punits, pick(i, 27, 100) AS pdisc, pick(i, 28, 100) AS pseg, pick(i, 29, 100) AS prate,
    pick(i, 30, 600) AS minute_of_day
  FROM range(${RETAIL_ORDERS}) AS t(i)
), dated AS (
  SELECT *,
    make_date(2023, 1, 1) + CAST(day AS INTEGER) AS order_date,
    CASE WHEN pchannel < 58 THEN 'Store' WHEN pchannel < 88 THEN 'Online' ELSE 'App' END AS channel
  FROM base
), categorized AS (
  SELECT *,
    month(order_date) AS m,
    CASE
      WHEN month(order_date) = 12 AND pcat < 120 THEN 7
      WHEN month(order_date) IN (4, 5, 6) AND pcat < 90 THEN 9
      ELSE ${weighted(CATEGORIES.map((_, index) => index + 1), CATEGORY_WEIGHTS, 'i', 31)}
    END AS cat
  FROM dated
), priced AS (
  SELECT *,
    round(${list(CATEGORY_PRICE)}[cat] * (0.35 + 1.3 * uprice1 * uprice2 + 0.4 * uprice1), 2) AS unit_price,
    CAST(CASE WHEN punits < 520 THEN 1 WHEN punits < 760 THEN 2 WHEN punits < 880 THEN 3 WHEN punits < 940 THEN 4
              WHEN punits < 975 THEN 5 ELSE 6 + punits % 7 END AS INTEGER) AS units,
    CAST(CASE WHEN m = 11 AND pdisc < 45 THEN ${list([10, 15, 20, 25, 30])}[1 + pdisc % 5]
              WHEN pdisc < 62 THEN 0
              WHEN pdisc < 82 THEN 5
              WHEN pdisc < 93 THEN 10
              WHEN pdisc < 98 THEN 20
              ELSE 30 END AS INTEGER) AS discount_pct
  FROM categorized
), timed AS (
  SELECT *,
    -- Stores trade 09:00-19:00, online all day (an evening peak).
    order_date + to_minutes(CASE WHEN channel = 'Store' THEN 540 + minute_of_day ELSE (minute_of_day * 12 + 420) % 1440 END) AS ordered_at
  FROM priced
)
SELECT
  -- Numbered in time order (and so delta-encoded to almost nothing).
  CAST(row_number() OVER (ORDER BY ordered_at, i) AS INTEGER) AS order_id,
  ordered_at,
  ${weighted(REGIONS, REGION_WEIGHTS, 'i', 32)} AS region,
  channel,
  ${list(CATEGORIES)}[cat] AS category,
  units,
  unit_price,
  discount_pct,
  round(units * unit_price * (100 - discount_pct) / 100, 2) AS revenue,
  CASE WHEN pseg < 30 THEN 'New' WHEN pseg < 78 THEN 'Returning' ELSE 'Member' END AS customer_segment,
  -- Most orders are never rated.
  CASE WHEN prate < 72 THEN NULL ELSE CAST(${list([1, 2, 3, 3, 4, 4, 4, 5, 5, 5, 5])}[1 + prate % 11] AS INTEGER) END AS rating
FROM timed
ORDER BY ordered_at, order_id`;
}

// ---------------------------------------------------------------------------
// 3. Sensors: 64 sensors in four buildings, every two minutes for 30 days

const SITES = ['Warehouse A', 'Warehouse B', 'Cold store', 'Office'];
/** Baseline °C, daily swing (peak-to-peak) and humidity baseline per site. */
const SITE_TEMP = [16, 18.5, 3.5, 21.5];
const SITE_SWING = [6, 7, 1.5, 3];
const SITE_HUMIDITY = [55, 50, 82, 40];
const SENSORS = 64;
const READINGS_PER_SENSOR = 30 * 720;

function sensorsQuery(): string {
  const start = Math.trunc(Date.UTC(2025, 8, 1) / 1000);
  return `
WITH base AS (
  SELECT
    i,
    i // ${SENSORS} AS step,
    i % ${SENSORS} AS sensor,
    (i % ${SENSORS}) // ${SENSORS / SITES.length} AS site
  FROM range(${SENSORS * READINGS_PER_SENSOR}) AS t(i)
), timed AS (
  SELECT *,
    ${start} + step * 120 + pick(i, 41, 6) AS epoch,
    -- Minutes since midnight and a triangle wave over the day, peaking at 15:00 (no libm, exact).
    ((step * 2) % 1440) AS minute_of_day,
    step // 720 AS day
  FROM base
), shaped AS (
  SELECT *,
    abs(((minute_of_day + 1440 - 900) % 1440) - 720) / 720.0 AS night,
    -- Cold store door left open now and then: a warm excursion of up to an hour.
    CASE WHEN site = 2 AND pick(step // 30 + sensor * 1000, 42, 120) = 0 THEN 4 + 6 * u(step, 43) ELSE 0 END AS excursion,
    -- Office occupancy: weekdays 08:00-18:00.
    CASE WHEN site = 3 AND minute_of_day BETWEEN 480 AND 1080 AND (day + 1) % 7 NOT IN (5, 6) THEN 1 ELSE 0 END AS occupied,
    (u(i, 44) + u(i, 45) + u(i, 46) - 1.5) AS noise,
    pick(i, 47, 1000) AS pfault
  FROM timed
), measured AS (
  SELECT *,
    ${list(SITE_TEMP)}[site + 1] + ${list(SITE_SWING)}[site + 1] * (0.5 - night) + (sensor % 4 - 1.5) * 0.4
      + 1.5 * occupied + excursion + 0.6 * noise AS temperature
  FROM shaped
)
SELECT
  make_timestamp(epoch * 1000000) AS recorded_at,
  printf('S-%02d', sensor + 1) AS sensor_id,
  ${list(SITES)}[site + 1] AS site,
  CASE WHEN pfault < 3 THEN NULL ELSE round(temperature, 2) END AS temperature_c,
  CASE WHEN pfault < 3 THEN NULL ELSE round(least(99, greatest(10, ${list(SITE_HUMIDITY)}[site + 1] - 1.8 * (temperature - ${list(SITE_TEMP)}[site + 1]) + 4 * noise)), 1) END AS humidity_pct,
  CASE WHEN site = 3 THEN CAST(420 + occupied * (300 + pick(i, 48, 500)) + pick(i, 49, 40) AS INTEGER) ELSE NULL END AS co2_ppm,
  -- Batteries drain at a per-sensor rate; a few get replaced halfway.
  round(greatest(5, 100 - (step % CASE WHEN sensor % 9 = 0 THEN ${READINGS_PER_SENSOR / 2} ELSE ${READINGS_PER_SENSOR} END) * (0.6 + (sensor % 7) * 0.15) / 720), 1) AS battery_pct,
  CASE WHEN pfault < 3 THEN 'offline'
       WHEN (site = 2 AND temperature > 8) OR (site <> 2 AND temperature > 28) THEN 'alert'
       ELSE 'ok' END AS status
FROM measured
ORDER BY recorded_at, sensor_id`;
}

// ---------------------------------------------------------------------------

const SAMPLES: readonly Sample[] = [
  {
    id: 'taxi',
    fileName: 'taxi-trips-2025h1.parquet',
    title: 'Taxi trips',
    description: `${TAXI_TRIPS.toLocaleString('en-US')} synthetic taxi trips in a made-up city, January to June 2025`,
    query: taxiQuery(),
    charts: [
      { title: 'Trips per day', spec: { mark: 'line', x: { column: 'pickup_at', timeUnit: 'day' }, y: { column: 'pickup_at', aggregate: 'count' } } },
      { title: 'Trips by pickup zone', spec: { mark: 'bar', x: { column: 'pickup_zone' } } },
      { title: 'Trip distance (km)', spec: { mark: 'histogram', x: { column: 'distance_km', bin: 'auto' } } },
      { title: 'Pickup locations', spec: { mark: 'heatmap', x: { column: 'pickup_lon', bin: 'auto' }, y: { column: 'pickup_lat', bin: 'auto' } } },
    ],
  },
  {
    id: 'retail',
    fileName: 'retail-orders-2023-2025.parquet',
    title: 'Retail orders',
    description: `${RETAIL_ORDERS.toLocaleString('en-US')} synthetic orders of a made-up retail chain, 2023 to 2025`,
    query: retailQuery(),
    charts: [
      { title: 'Revenue per month', spec: { mark: 'area', x: { column: 'ordered_at', timeUnit: 'month' }, y: { column: 'revenue', aggregate: 'sum' } } },
      { title: 'Revenue by category', spec: { mark: 'bar', x: { column: 'category' }, y: { column: 'revenue', aggregate: 'sum' } } },
      { title: 'Orders by channel', spec: { mark: 'bar', x: { column: 'channel' } } },
      { title: 'Order value', spec: { mark: 'histogram', x: { column: 'revenue', bin: 'auto' } } },
    ],
  },
  {
    id: 'sensors',
    fileName: 'sensor-readings-2025-09.parquet',
    title: 'Sensor readings',
    description: `${(SENSORS * READINGS_PER_SENSOR).toLocaleString('en-US')} synthetic readings from ${SENSORS} sensors in four buildings, every two minutes in September 2025`,
    query: sensorsQuery(),
    charts: [
      { title: 'Temperature by site (hourly average)', spec: { mark: 'line', x: { column: 'recorded_at', timeUnit: 'hour' }, y: { column: 'temperature_c', aggregate: 'avg' }, color: { column: 'site' } } },
      { title: 'Temperature (°C)', spec: { mark: 'histogram', x: { column: 'temperature_c', bin: 'auto' } } },
      { title: 'Readings by status', spec: { mark: 'bar', x: { column: 'status' } } },
      { title: 'Temperature vs humidity', spec: { mark: 'heatmap', x: { column: 'temperature_c', bin: 'auto' }, y: { column: 'humidity_pct', bin: 'auto' } } },
    ],
  },
];

// ---------------------------------------------------------------------------
// The engine's view of a file (kept in step with packages/engine by the web E2E: a sample must open without restore warnings)

const INTEGER = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT)$/;

/** `simpleColumnType` from packages/engine/src/column-types.ts. */
function columnType(duckdbType: string): ColumnType {
  const type = duckdbType.trim().toUpperCase();
  if (INTEGER.test(type)) return 'integer';
  if (/^(FLOAT|REAL|DOUBLE)$/.test(type)) return 'float';
  if (type.startsWith('DECIMAL') || type.startsWith('NUMERIC')) return 'decimal';
  if (type === 'BOOLEAN') return 'boolean';
  if (type === 'DATE') return 'date';
  if (type.startsWith('TIMESTAMP')) return 'timestamp';
  return 'text';
}

const EDGE_BYTES = 1024 * 1024;

/** `fingerprintFile` from packages/engine/src/fingerprint.ts (Parquet cache format v1). */
async function fingerprint(file: string): Promise<{ sizeBytes: number; mtimeMs: number; headTailSha256: string; key: string }> {
  const info = await stat(file);
  const sizeBytes = info.size;
  const mtimeMs = Math.trunc(info.mtimeMs);
  const handle = await open(file, 'r');
  try {
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      return buffer;
    };
    const head = await read(0, Math.min(EDGE_BYTES, sizeBytes));
    const tailStart = Math.max(0, sizeBytes - EDGE_BYTES);
    const tail = await read(tailStart, sizeBytes - tailStart);
    const headTailSha256 = createHash('sha256').update(head).update(tail).digest('hex');
    const key = createHash('sha256').update(`glassgrid-parquet-v1\n${sizeBytes}\n${mtimeMs}\n${headTailSha256}`).digest('hex').slice(0, 32);
    return { sizeBytes, mtimeMs, headTailSha256, key };
  } finally {
    await handle.close();
  }
}

async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

interface Written {
  id: string;
  file: string;
  workspace: string;
  title: string;
  description: string;
  rows: number;
  bytes: number;
  sha256: string;
  workspaceSha256: string;
  columns: { name: string; type: string }[];
}

async function writeSample(duck: Duck, sample: Sample, outDir: string): Promise<Written> {
  const target = path.join(outDir, sample.fileName);
  const partial = `${target}.partial`;
  await rm(partial, { force: true });
  const t0 = performance.now();
  await duck.conn.run(
    `COPY (${sample.query}) TO ${sqlString(partial)} (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL 9, ROW_GROUP_SIZE 122880, PARQUET_VERSION V2)`,
  );
  await rename(partial, target);
  const mtime = new Date(SAVED_AT);
  await utimes(target, mtime, mtime);
  log(`  ${sample.fileName}: written in ${seconds(t0)} s`);

  const described = await describeQuery(duck.conn, `SELECT * FROM read_parquet(${sqlString(target)})`);
  const rows = Number((await duck.conn.runAndReadAll(`SELECT count(*) AS n FROM read_parquet(${sqlString(target)})`)).getRowObjects()[0]?.['n']);
  const columns = described.map(({ name, type }) => ({ name, type: columnType(type) }));

  // Every chart compiles against the engine's columns and their ranges, as the app compiles it.
  const ranges = await Promise.all(
    columns.map(async ({ name, type }) => {
      const numeric = type === 'integer' || type === 'float' || type === 'decimal';
      const cast = numeric ? 'DOUBLE' : 'VARCHAR';
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const row = (await duck.conn.runAndReadAll(`SELECT CAST(min(${quoted}) AS ${cast}) AS lo, CAST(max(${quoted}) AS ${cast}) AS hi FROM read_parquet(${sqlString(target)})`)).getRowObjects()[0];
      const value = (v: unknown) => (v === null || v === undefined ? null : numeric ? Number(v) : typeof v === 'string' ? v : JSON.stringify(v));
      return { name, type, min: value(row?.['lo']), max: value(row?.['hi']) };
    }),
  );
  for (const chart of sample.charts) {
    try {
      compileChartQuery('t', chart.spec, ranges);
    } catch (error) {
      throw new Error(`${sample.id}: chart "${chart.title}" does not compile: ${isCompileError(error) ? error.message : String(error)}`, { cause: error });
    }
  }

  const charts = sample.charts.map((chart, index) => ({ id: `chart_${index + 1}`, spec: { filters: [], ...chart.spec }, title: chart.title }));
  const snapshot: WorkspaceSnapshot = {
    dataSource: { handleId: toFileHandle('00000000-0000-4000-8000-000000000000'), fileName: sample.fileName, fingerprint: await fingerprint(target) },
    workspace: {
      columns: columns.map(({ name, type }) => ({ name, inferredType: type, typeOverride: null })),
      charts: charts as WorkspaceSnapshot['workspace']['charts'],
      selections: {},
      userFilters: [],
      grid: { sort: [], columnOrder: [], columnWidths: [] },
      layout: { cards: charts.map((chart, index) => ({ chartId: chart.id, x: 0, y: index, w: 1, h: 1 })) },
    },
  };
  const workspaceName = `${sample.id}.glassgrid`;
  const workspacePath = path.join(outDir, workspaceName);
  await writeFile(
    workspacePath,
    serializeWorkspace(snapshot, { app: APP, savedAt: SAVED_AT, absolutePath: `/samples/${sample.fileName}`, relativePath: sample.fileName }),
  );
  const bytes = (await stat(target)).size;
  log(`  ${sample.id}: ${rows.toLocaleString('en-US')} rows, ${formatBytes(bytes)}, ${columns.length} columns`);
  return {
    id: sample.id,
    file: sample.fileName,
    workspace: workspaceName,
    title: sample.title,
    description: sample.description,
    rows,
    bytes,
    sha256: await sha256File(target),
    workspaceSha256: await sha256File(workspacePath),
    columns: described,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: DEFAULT_OUT },
      only: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write('Usage: pnpm --filter @glassgrid/datasets samples [-- --out DIR] [--only taxi,retail,sensors]\n');
    return;
  }
  const outDir = await ensureDir(path.resolve(values.out));
  const only = values.only === undefined ? null : new Set(values.only.split(','));
  const tmp = await ensureDir(path.join(PACKAGE_ROOT, 'out', 'cache', 'duckdb-tmp'));
  // One thread: the Parquet writer's row groups (and so the bytes) then never depend on scheduling.
  const duck = await openDuck({ tempDirectory: tmp, threads: 1 });
  const t0 = performance.now();
  try {
    for (const macro of MACROS) await duck.conn.run(macro);
    const written: Written[] = [];
    for (const sample of SAMPLES) {
      if (only && !only.has(sample.id)) continue;
      log(`${sample.id} -> ${path.relative(process.cwd(), path.join(outDir, sample.fileName))}`);
      written.push(await writeSample(duck, sample, outDir));
    }
    if (!only) {
      const manifest = {
        manifestVersion: 1,
        recipe: RECIPE,
        seed: SEED,
        generator: { package: '@glassgrid/datasets', packageVersion: PACKAGE_VERSION, duckdbVersion: duck.version },
        licence: 'Synthetic data generated by tools/datasets/src/samples.ts; MIT, like the rest of Glassgrid.',
        samples: written,
      };
      await writeFile(path.join(outDir, 'samples.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    log(`done in ${seconds(t0)} s: ${written.map((w) => `${w.id} ${formatBytes(w.bytes)}`).join(', ')}`);
  } finally {
    duck.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

runCli(main);
