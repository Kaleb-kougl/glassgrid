import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

export const CATEGORIES = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const;
const ROWS_PER_CHUNK = 50_000;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Write a deterministic CSV with a header and `rows` data rows. Mixed column
 * types (int, text, double, date) keep DuckDB's header sniffing unambiguous.
 * Returns the file size in bytes.
 */
export async function writeFixtureCsv(path: string, rows: number): Promise<number> {
  const out = createWriteStream(path, { encoding: 'utf8' });
  out.write('id,category,amount,created_on\n');

  for (let start = 0; start < rows; start += ROWS_PER_CHUNK) {
    const end = Math.min(rows, start + ROWS_PER_CHUNK);
    let chunk = '';
    for (let i = start; i < end; i += 1) {
      const category = CATEGORIES[i % CATEGORIES.length];
      const amount = ((i * 7919) % 1_000_000) / 100;
      const month = (i % 12) + 1;
      const day = (i % 28) + 1;
      chunk += `${i + 1},${category},${amount},2026-${pad2(month)}-${pad2(day)}\n`;
    }
    if (!out.write(chunk)) await once(out, 'drain');
  }

  out.end();
  await finished(out);
  return (await stat(path)).size;
}

/** Payment types of the trips fixture, most common first, with their shares. */
export const PAYMENT_TYPES = [
  ['Credit card', 0.68],
  ['Cash', 0.22],
  ['No charge', 0.05],
  ['Dispute', 0.03],
  ['Unknown', 0.02],
] as const;

/** First pickup of the trips fixture (UTC) and the span its pickups cover. */
export const TRIPS_START_MS = Date.UTC(2024, 2, 1);
export const TRIPS_DAYS = 31;

/** Trips per hour of day (relative): quiet nights, busy days, an evening peak. */
const HOURLY = [3, 2, 1.5, 1, 1, 1.5, 3, 5, 7, 6, 5.5, 5.5, 6, 6, 6.5, 7, 7.5, 8, 8.5, 8, 7, 6, 5, 4];
const HOURLY_CDF = (() => {
  const total = HOURLY.reduce((sum, value) => sum + value, 0);
  let running = 0;
  return HOURLY.map((value) => (running += value / total));
})();

/** A uniform number in [0, 1) from (row, salt): integer mixing only, so the file is the same on every machine. */
function unit(row: number, salt: number): number {
  let x = Math.imul(row ^ Math.imul(salt, 0x9e3779b1), 0x85ebca6b) ^ (row >>> 13);
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4_294_967_296;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * A taxi-like CSV for the M3 linked-charts scenario: `pickup_at` (TIMESTAMP
 * over March 2024 with a daily rhythm), `payment_type` (5 values, skewed),
 * `trip_distance` (skewed, 0.01 to about 30) and `fare_amount` (follows the
 * distance). Deterministic; returns the file size in bytes.
 */
export async function writeTripsCsv(path: string, rows: number): Promise<number> {
  const out = createWriteStream(path, { encoding: 'utf8' });
  out.write('pickup_at,payment_type,trip_distance,fare_amount\n');
  for (let start = 0; start < rows; start += ROWS_PER_CHUNK) {
    const end = Math.min(rows, start + ROWS_PER_CHUNK);
    let chunk = '';
    for (let i = start; i < end; i += 1) {
      const day = Math.floor((i * TRIPS_DAYS) / rows);
      const u = unit(i, 1);
      let hour = 0;
      while (hour < 23 && u >= (HOURLY_CDF[hour] ?? 1)) hour += 1;
      const second = Math.floor(unit(i, 2) * 3600);
      const stamp = new Date(TRIPS_START_MS + day * 86_400_000 + hour * 3_600_000 + second * 1000);
      const p = unit(i, 3);
      let k = 0;
      let cumulative = PAYMENT_TYPES[0][1];
      while (k < PAYMENT_TYPES.length - 1 && p >= cumulative) {
        k += 1;
        cumulative += PAYMENT_TYPES[k]?.[1] ?? 0;
      }
      const distance = Math.min(30, 0.01 + -Math.log(1 - unit(i, 4)) * 2.6);
      const fare = 3 + distance * 2.5 + unit(i, 5) * 4;
      chunk +=
        `${stamp.getUTCFullYear()}-${pad(stamp.getUTCMonth() + 1)}-${pad(stamp.getUTCDate())} ` +
        `${pad(stamp.getUTCHours())}:${pad(stamp.getUTCMinutes())}:${pad(stamp.getUTCSeconds())},` +
        `${PAYMENT_TYPES[k]?.[0] ?? 'Unknown'},${distance.toFixed(2)},${fare.toFixed(2)}\n`;
    }
    if (!out.write(chunk)) await once(out, 'drain');
  }
  out.end();
  await finished(out);
  return (await stat(path)).size;
}
