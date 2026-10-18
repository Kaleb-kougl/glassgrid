import { scaleLinear, scaleUtc } from 'd3-scale';
import { utcDay, utcHour, utcMinute, utcMonth, utcSecond, utcYear } from 'd3-time';
import { utcFormat } from 'd3-time-format';
import type { AxisKind } from './types.js';

/**
 * A continuous axis: data value (number, or epoch ms for time) ↔ CSS pixel.
 * Pixel positions are never rounded here; marks are drawn at fractional
 * positions so a dense polyline stays faithful.
 */
export interface AxisScale {
  readonly kind: Exclude<AxisKind, 'category'>;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  toPx(value: number): number;
  fromPx(px: number): number;
  /** Tick values, about `count` of them, at round numbers or calendar boundaries. */
  ticks(count: number): number[];
  /** Formatter for the ticks returned by `ticks(count)`. */
  tickFormat(count: number): (value: number) => string;
}

/** Extent of the finite values of one or two arrays, or null when none. */
export function extent(values: ArrayLike<number>, more?: ArrayLike<number> | null): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const scan = (arr: ArrayLike<number>) => {
    for (let i = 0; i < arr.length; i += 1) {
      const v = arr[i] ?? Number.NaN;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  };
  scan(values);
  if (more) scan(more);
  return lo <= hi ? [lo, hi] : null;
}

/** Widens an empty or degenerate domain so a scale can be built from it. */
export function safeDomain(domain: readonly [number, number] | null, kind: Exclude<AxisKind, 'category'>): [number, number] {
  if (!domain) return kind === 'time' ? [Date.UTC(2000, 0, 1), Date.UTC(2000, 0, 2)] : [0, 1];
  const [lo, hi] = domain;
  if (hi > lo) return [lo, hi];
  if (kind === 'time') return [lo - 43_200_000, lo + 43_200_000];
  const pad = lo === 0 ? 1 : Math.abs(lo) * 0.5;
  return [lo - pad, lo + pad];
}

const SI_FIX: Readonly<Record<string, string>> = { G: 'B' };

/** Number tick formatter: grouped digits below 10,000, compact SI (`2.5M`, `1B`) above. */
function numberTickFormat(domain: readonly [number, number], count: number) {
  const scale = scaleLinear().domain(domain as [number, number]);
  const max = Math.max(Math.abs(domain[0]), Math.abs(domain[1]));
  if (max >= 10_000) {
    const si = scale.tickFormat(count, '~s');
    return (value: number) => (value === 0 ? '0' : si(value).replace(/[G]$/, (unit) => SI_FIX[unit] ?? unit).replace('−', '-'));
  }
  const plain = scale.tickFormat(count, ',');
  const fine = scale.tickFormat(count);
  // d3 picks the precision from the tick step; ',' adds grouping without changing it.
  return (value: number) => {
    const text = max >= 1000 ? plain(value) : fine(value);
    return text.replace('−', '-');
  };
}

const formatMillisecond = utcFormat('.%L');
const formatSecond = utcFormat(':%S');
const formatMinute = utcFormat('%H:%M');
const formatHour = utcFormat('%H:%M');
const formatDay = utcFormat('%b %-d');
const formatMonth = utcFormat('%b');
const formatYear = utcFormat('%Y');

/**
 * Time tick text at the coarsest boundary a tick sits on (UTC, 24-hour):
 * `2023`, `Feb`, `Jan 9`, `14:00`, `:30`, `.250`. January ticks print the year.
 */
export function timeTickFormat(value: number): string {
  const date = new Date(value);
  if (utcSecond(date) < date) return formatMillisecond(date);
  if (utcMinute(date) < date) return formatSecond(date);
  if (utcHour(date) < date) return formatMinute(date);
  if (utcDay(date) < date) return formatHour(date);
  if (utcMonth(date) < date) return formatDay(date);
  if (utcYear(date) < date) return formatMonth(date);
  return formatYear(date);
}

/** A continuous scale from `domain` (data) to `range` (CSS px). */
export function makeScale(kind: Exclude<AxisKind, 'category'>, domain: readonly [number, number], range: readonly [number, number]): AxisScale {
  const [d0, d1] = safeDomain(domain, kind);
  const [r0, r1] = range;
  const span = d1 - d0;
  const pxSpan = r1 - r0;
  const toPx = (value: number) => r0 + ((value - d0) / span) * pxSpan;
  const fromPx = (px: number) => d0 + ((px - r0) / (pxSpan === 0 ? 1 : pxSpan)) * span;
  if (kind === 'time') {
    const scale = scaleUtc().domain([d0, d1]);
    return {
      kind,
      domain: [d0, d1],
      range: [r0, r1],
      toPx,
      fromPx,
      ticks: (count) => scale.ticks(Math.max(1, count)).map((d) => d.getTime()),
      tickFormat: () => timeTickFormat,
    };
  }
  const scale = scaleLinear().domain([d0, d1]);
  return {
    kind,
    domain: [d0, d1],
    range: [r0, r1],
    toPx,
    fromPx,
    ticks: (count) => scale.ticks(Math.max(1, count)),
    tickFormat: (count) => numberTickFormat([d0, d1], Math.max(1, count)),
  };
}

/** Domain extended to round tick values (numbers only; time domains stay exact). */
export function niceDomain(kind: Exclude<AxisKind, 'category'>, domain: readonly [number, number], count: number): [number, number] {
  const safe = safeDomain(domain, kind);
  if (kind === 'time') return safe;
  const nice = scaleLinear().domain(safe).nice(Math.max(1, count)).domain();
  return [nice[0] ?? safe[0], nice[1] ?? safe[1]];
}

/** Measure domain from 0 (or the data's minimum when negative) to a round maximum. */
export function measureDomain(values: ArrayLike<number>, count: number, more?: ArrayLike<number> | null): [number, number] {
  const e = extent(values, more);
  if (!e) return [0, 1];
  const lo = Math.min(0, e[0]);
  const hi = Math.max(0, e[1]);
  return niceDomain('number', [lo, hi === lo ? lo + 1 : hi], count);
}

/** About how many ticks fit along `px` pixels with labels `spacing` px apart. */
export function tickCount(px: number, spacing: number): number {
  return Math.max(2, Math.floor(px / spacing));
}
