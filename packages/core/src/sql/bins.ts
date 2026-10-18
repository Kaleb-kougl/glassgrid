import { type ColumnType, type ProfileValue } from '../spec/column.js';
import { type TimeUnit } from '../spec/field.js';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD`, optionally followed by ` HH:MM[:SS[.ffffff]][Z]` (space or `T`). */
const ISO_TEMPORAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?Z?)?$/;

/**
 * Parse a temporal value to epoch milliseconds (UTC wall clock, which is how
 * DuckDB's zone-less TIMESTAMP behaves). Numbers are taken as epoch ms.
 * Returns null for anything that is not a valid date or timestamp.
 */
export function parseTemporal(value: ProfileValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = ISO_TEMPORAL.exec(value);
  if (!match) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = ''] = match;
  const year = Number(y);
  const month = Number(mo) - 1;
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const ms = Date.UTC(year, month, day, hour, minute, second) + Number(`0.${frac || '0'}`) * 1000;
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  return ms;
}

/** Number of `unit` buckets that `[minMs, maxMs]` touches. */
export function timeBucketCount(minMs: number, maxMs: number, unit: TimeUnit): number {
  switch (unit) {
    case 'hour':
      return Math.floor(maxMs / MS_PER_HOUR) - Math.floor(minMs / MS_PER_HOUR) + 1;
    case 'day':
      return Math.floor(maxMs / MS_PER_DAY) - Math.floor(minMs / MS_PER_DAY) + 1;
    case 'month': {
      const a = new Date(minMs);
      const b = new Date(maxMs);
      return b.getUTCFullYear() * 12 + b.getUTCMonth() - (a.getUTCFullYear() * 12 + a.getUTCMonth()) + 1;
    }
  }
}

export type TimeUnitStrategy =
  /** The unit whose bucket count is closest to `target` on a log scale (ties go coarser), never above 4 x target unless only `month` is left. */
  | { readonly mode: 'closest'; readonly target: number }
  /** The finest unit with at most `max` buckets, else `month`. */
  | { readonly mode: 'finest'; readonly max: number };

/**
 * Pick a time unit for a date/timestamp column from its profiled min and max.
 * DATE columns never get `hour`. Without a usable min/max the answer is `day`.
 */
export function autoTimeUnit(
  min: ProfileValue | undefined,
  max: ProfileValue | undefined,
  type: ColumnType,
  strategy: TimeUnitStrategy,
): TimeUnit {
  const units: TimeUnit[] = type === 'date' ? ['day', 'month'] : ['hour', 'day', 'month'];
  const lo = parseTemporal(min);
  const hi = parseTemporal(max);
  if (lo === null || hi === null || hi < lo) return 'day';
  const counts = units.map((unit) => ({ unit, count: timeBucketCount(lo, hi, unit) }));
  if (strategy.mode === 'finest') {
    return counts.find((c) => c.count <= strategy.max)?.unit ?? 'month';
  }
  let best: TimeUnit = 'month';
  let bestDistance = Infinity;
  for (const { unit, count } of counts) {
    if (count > 4 * strategy.target) continue;
    const distance = Math.abs(Math.log(count / strategy.target));
    if (distance <= bestDistance) {
      best = unit;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * A "nice" bin width (1, 2 or 5 x 10^n) giving at most about `target` bins
 * over `[min, max]`: the smallest nice width >= (max - min) / target. Integer
 * columns never get a width below 1. Degenerate ranges get width 1.
 */
export function niceBinWidth(min: number, max: number, target: number, integer: boolean): number {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / target;
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const exponent = Math.floor(Math.log10(raw));
  for (let e = exponent; ; e++) {
    for (const mantissa of [1, 2, 5]) {
      // Divide by an exact power of ten for negative exponents so that, e.g.,
      // 2e-2 is the double closest to 0.02 rather than 2 * 0.01000...02.
      const width = e >= 0 ? mantissa * 10 ** e : mantissa / 10 ** -e;
      if (width >= raw && (!integer || width >= 1)) return width;
    }
  }
}

/** Number of `[k * width, (k + 1) * width)` bins that `[min, max]` touches. */
export function numericBinCount(min: number, max: number, width: number): number {
  return Math.floor(max / width) - Math.floor(min / width) + 1;
}

/** Start of the `unit` bucket holding `ms` (UTC), as `date_trunc` computes it. */
export function truncateTime(ms: number, unit: TimeUnit): number {
  switch (unit) {
    case 'hour':
      return Math.floor(ms / MS_PER_HOUR) * MS_PER_HOUR;
    case 'day':
      return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
    case 'month': {
      const d = new Date(ms);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    }
  }
}

/** `ms` moved by `count` units (UTC; months keep the day of month, so pass bucket starts). */
export function addTime(ms: number, unit: TimeUnit, count = 1): number {
  switch (unit) {
    case 'hour':
      return ms + count * MS_PER_HOUR;
    case 'day':
      return ms + count * MS_PER_DAY;
    case 'month': {
      const d = new Date(ms);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + count, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
    }
  }
}
