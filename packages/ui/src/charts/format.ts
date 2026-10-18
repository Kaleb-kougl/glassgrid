import { utcFormat } from 'd3-time-format';
import { formatDate, formatTimestamp } from '../grid/format.js';
import type { AxisKind, BrushValue } from './types.js';

/*
 * Chart text. Tooltips and "View data" show exact values from the result
 * rows (grouped digits, full precision up to 6 decimals), never values read
 * back from pixel positions. Dates and timestamps go through the shared
 * formatter (grid/format.ts) so a chart and the grid print a value the same way.
 */

const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });

/** An aggregate or measure as shown in tooltips, bar labels and "View data": `2,688,301`, `3.141593`. */
export function formatAggregate(value: number): string {
  if (Number.isNaN(value)) return '–';
  // Very small magnitudes would round to 0 with 6 decimals: keep their digits.
  if (value !== 0 && Math.abs(value) < 1e-4 && Number.isFinite(value)) return value.toPrecision(6).replace(/\.?0+e/, 'e');
  return grouped.format(value);
}

/** How finely a set of timestamps is bucketed, from their alignment. */
export type TimeResolution = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'millisecond';

const MS_DAY = 86_400_000;

/** The coarsest unit every finite value in `values` is aligned to (UTC). */
export function timeResolution(values: ArrayLike<number>, count = values.length): TimeResolution {
  let resolution = 0; // 0 year … 6 ms
  for (let i = 0; i < count; i += 1) {
    const v = values[i] ?? Number.NaN;
    if (!Number.isFinite(v)) continue;
    let level: number;
    if (v % 1000 !== 0) level = 6;
    else if (v % 60_000 !== 0) level = 5;
    else if (v % 3_600_000 !== 0) level = 4;
    else if (v % MS_DAY !== 0) level = 3;
    else {
      const d = new Date(v);
      level = d.getUTCDate() !== 1 ? 2 : d.getUTCMonth() !== 0 ? 1 : 0;
    }
    if (level > resolution) resolution = level;
    if (resolution === 6) break;
  }
  return (['year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond'] as const)[resolution] ?? 'millisecond';
}

const fmtYear = utcFormat('%Y');
const fmtMonth = utcFormat('%b %Y');
const fmtDay = utcFormat('%a, %b %-d, %Y');
const fmtHour = utcFormat('%a, %b %-d, %Y %H:%M');

/**
 * A time value as a tooltip title at the resolution of its buckets:
 * `2023`, `Jan 2023`, `Fri, Jan 20, 2023`, `Fri, Jan 20, 2023 14:00`, or the
 * exact timestamp below the hour.
 */
export function formatTimeAt(ms: number, resolution: TimeResolution): string {
  if (!Number.isFinite(ms)) return '–';
  const d = new Date(ms);
  switch (resolution) {
    case 'year':
      return fmtYear(d);
    case 'month':
      return fmtMonth(d);
    case 'day':
      return fmtDay(d);
    case 'hour':
    case 'minute':
      return fmtHour(d);
    default:
      return formatTimestamp(ms);
  }
}

/** A value of an axis of `kind` as exact text (numbers grouped, time as the shared timestamp text). */
export function formatAxisValue(value: number, kind: AxisKind, resolution: TimeResolution = 'millisecond'): string {
  if (kind === 'time') return resolution === 'millisecond' || resolution === 'second' ? formatTimestamp(value) : formatTimeAt(value, resolution);
  return formatAggregate(value);
}

/** A half-open bin `[lo, hi)` as text: `3 – 4`, `Jan 2023 – Feb 2023`. */
export function formatRange(lo: number, hi: number, kind: AxisKind, resolution: TimeResolution = 'millisecond'): string {
  return `${formatAxisValue(lo, kind, resolution)} – ${formatAxisValue(hi, kind, resolution)}`;
}

/**
 * A time value as a brush bound: ISO text the compiler casts to TIMESTAMP
 * (`2024-01-31 12:00:00`, `2024-01-31` at midnight), UTC wall clock.
 */
export function toIsoTimestamp(ms: number): string {
  if (ms % MS_DAY === 0) return formatDate(ms);
  return formatTimestamp(ms);
}

const ISO = /^(-?\d{4,})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]00(?::?00)?)?$/;

/** Epoch ms of an ISO date or timestamp (UTC), or NaN. Accepts epoch-ms numbers as they are. */
export function parseTimeBound(value: BrushValue): number {
  if (typeof value === 'number') return value;
  const match = ISO.exec(value.trim());
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi, s, frac] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
  const fraction = frac ? Number(`0.${frac}`) * 1000 : 0;
  return ms + fraction;
}

/** A brush bound in data units (number or epoch ms) from its public form. */
export function boundToNumber(value: BrushValue, kind: AxisKind): number {
  if (kind === 'time') return parseTimeBound(value);
  return typeof value === 'number' ? value : Number(value);
}

/** The public form of a brush bound: ISO text on time axes, the number otherwise. */
export function numberToBound(value: number, kind: AxisKind): BrushValue {
  return kind === 'time' ? toIsoTimestamp(value) : value;
}
