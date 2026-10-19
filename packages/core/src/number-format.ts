import type { ColumnType } from './spec/column.js';
import type { Aggregate } from './spec/field.js';

/*
 * Numbers as people read them: one module for every place the app shows a
 * number (chart labels and tooltips, "View data", filter chips, row counts,
 * the column list). The grid keeps its own ungrouped text for cell values
 * (packages/ui/src/grid/format.ts) but trims floating-point noise the same
 * way (`trimFloat`).
 *
 * Rules (see docs/m4-web-demo.md, "Number formatting"):
 *
 * - NULL, undefined and NaN print as an en dash `–`; ±Infinity as `∞`/`-∞`;
 *   `-0` (and negatives that round to zero) as `0`.
 * - Integers stay exact, with grouping: `2,000,000`. BigInt (BIGINT,
 *   HUGEINT) is formatted from the bigint itself, so it never loses digits.
 * - Floats lose their binary noise first (15 significant digits):
 *   `39015093.429999996` is `39015093.43`.
 * - Measures (aggregates) follow the aggregate and the column's type:
 *   `count` and integer columns are integers; `avg` has two fixed decimals
 *   (`4.29`); DECIMAL keeps its scale; `min`/`max` of a float keep the
 *   column's own precision (up to 6 decimals); a `sum` of floats has two
 *   fixed decimals (`9,399,854.36`), unless every value of the result is a
 *   whole number. Below 1 a measure shows 3 significant digits (`0.0123`).
 * - Compact (bar labels once a chart's largest value reaches a million, a
 *   billion for whole numbers): 3 significant digits and a suffix, `39.0M`,
 *   `812K`, `1.50B`. Tooltips keep the full value.
 * - Magnitudes Intl cannot group sensibly (≥ 1e21, or non-zero values that
 *   round to 0) use a short exponent: `1.23e-7`, `4.00e21`.
 *
 * `Intl.NumberFormat` instances are created once per option set and cached;
 * formatting one number is then a single `format` call.
 */

export const NO_VALUE = '–';

const formats = new Map<string, Intl.NumberFormat>();

function nf(minFraction: number, maxFraction: number): Intl.NumberFormat {
  const key = `f${minFraction}:${maxFraction}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.NumberFormat('en-US', { minimumFractionDigits: minFraction, maximumFractionDigits: maxFraction });
    formats.set(key, format);
  }
  return format;
}

function nfSignificant(digits: number, compact: boolean): Intl.NumberFormat {
  const key = `s${digits}:${compact ? 'c' : ''}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.NumberFormat('en-US', {
      minimumSignificantDigits: digits,
      maximumSignificantDigits: digits,
      ...(compact ? { notation: 'compact' as const, compactDisplay: 'short' as const } : {}),
    });
    formats.set(key, format);
  }
  return format;
}

const integerFormat = nf(0, 0);

/** Text for values that are not a finite number, or null when `value` is one. */
function special(value: number | bigint | null | undefined): string | null {
  if (value === null || value === undefined) return NO_VALUE;
  if (typeof value === 'bigint') return null;
  if (Number.isNaN(value)) return NO_VALUE;
  if (value === Infinity) return '∞';
  if (value === -Infinity) return '-∞';
  return null;
}

/** `-0`, `-0.00` or `-0K` (a negative that rounded to zero) without the sign. */
function unsignZero(text: string): string {
  return text.charCodeAt(0) === 45 /* - */ && /^-0(?:\.0*)?[A-Za-z]?$/.test(text) ? text.slice(1) : text;
}

/** A short exponent form: `1.23e-7`, `4.00e21`. */
function exponent(value: number, digits = 3): string {
  return value.toExponential(digits - 1).replace('e+', 'e');
}

/** The double without its binary noise: 15 significant digits (`0.1 + 0.2` is `0.3`). */
export function trimFloat(value: number): number {
  if (!Number.isFinite(value) || Number.isInteger(value)) return value;
  return Number(value.toPrecision(15));
}

const MAX_GROUPED = 1e21;

/** Fixed `decimals` (grouped), or an exponent when the value would read as 0 or is too large. */
function fixed(value: number, decimals: number): string {
  const abs = Math.abs(value);
  if (abs >= MAX_GROUPED) return exponent(value);
  if (abs !== 0 && abs < 0.5 * 10 ** -decimals) return exponent(value);
  return unsignZero(nf(decimals, decimals).format(value));
}

/** An integer, exact and grouped: `2,000,000`. Numbers are rounded; bigints keep every digit. */
export function formatInteger(value: number | bigint | null | undefined): string {
  const text = special(value);
  if (text !== null) return text;
  if (typeof value === 'bigint') return integerFormat.format(value);
  const n = value as number;
  if (Math.abs(n) >= MAX_GROUPED) return exponent(n);
  return unsignZero(integerFormat.format(Math.round(n)));
}

/**
 * A value at its own precision: integers exact and grouped, floats without
 * binary noise and with at most `maxDecimals` decimals (default 6), grouped.
 * Used for data values (axis values, bin edges, scatter coordinates, the
 * min and max of a column).
 */
export function formatNumber(value: number | bigint | null | undefined, maxDecimals = 6): string {
  const text = special(value);
  if (text !== null) return text;
  if (typeof value === 'bigint') return integerFormat.format(value);
  const n = trimFloat(value as number);
  const abs = Math.abs(n);
  if (abs >= MAX_GROUPED) return exponent(n);
  if (Number.isInteger(n)) return unsignZero(integerFormat.format(n));
  if (abs < 0.5 * 10 ** -maxDecimals) return exponent(n);
  return unsignZero(nf(0, maxDecimals).format(n));
}

/** What a measure is: its aggregate, the aggregated column's type, and the result's DECIMAL scale if known. */
export interface MeasureFormat {
  readonly aggregate?: Aggregate | undefined;
  /** The type of the aggregated column (null or absent when unknown). */
  readonly type?: ColumnType | null | undefined;
  /** The DECIMAL scale of the result column, when it is a DECIMAL. */
  readonly scale?: number | null | undefined;
}

/** How a measure's values print (see the rules at the top). */
export type MeasureMode = 'integer' | 'avg' | 'exact' | 'fixed2' | `scale:${number}`;

const MAX_SCALE = 6;

/**
 * The mode for a measure, optionally looking at every value of the result
 * so a column of labels is consistent (a float sum whose values are all
 * whole numbers prints as integers).
 */
export function measureMode(format: MeasureFormat = {}, values?: ArrayLike<number>): MeasureMode {
  const { aggregate, type, scale } = format;
  if (aggregate === 'count') return 'integer';
  if (aggregate === 'avg') return 'avg';
  if (scale !== null && scale !== undefined && Number.isInteger(scale) && scale >= 0) {
    return scale === 0 ? 'integer' : `scale:${Math.min(scale, MAX_SCALE)}`;
  }
  if (type === 'integer') return 'integer';
  if (aggregate === 'min' || aggregate === 'max') return 'exact';
  if (values && allIntegral(values)) return 'integer';
  return 'fixed2';
}

function allIntegral(values: ArrayLike<number>): boolean {
  let any = false;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] ?? Number.NaN;
    if (!Number.isFinite(v)) continue;
    if (!Number.isInteger(trimFloat(v))) return false;
    any = true;
  }
  return any;
}

/** Below 1, three significant digits (`0.0123`, `0.500`); else `decimals` fixed decimals. */
function smallOrFixed(value: number, decimals: number): string {
  const n = trimFloat(value);
  const abs = Math.abs(n);
  if (abs !== 0 && abs < 1) {
    if (abs < 1e-6) return exponent(n);
    return unsignZero(nfSignificant(3, false).format(n));
  }
  return fixed(n, decimals);
}

function formatInMode(value: number, mode: MeasureMode): string {
  switch (mode) {
    case 'integer':
      return Number.isInteger(trimFloat(value)) ? formatInteger(value) : smallOrFixed(value, 2);
    case 'avg':
    case 'fixed2':
      return smallOrFixed(value, 2);
    case 'exact':
      return formatNumber(value);
    default:
      return fixed(trimFloat(value), Number(mode.slice('scale:'.length)));
  }
}

/** A measure as tooltips, "View data" and bar labels show it in full: `39,015,093.43`, `4.29`, `85,076`. */
export function formatMeasure(value: number | bigint | null | undefined, format: MeasureFormat = {}): string {
  const text = special(value);
  if (text !== null) return text;
  if (typeof value === 'bigint') return integerFormat.format(value);
  const n = value as number;
  return formatInMode(n, measureMode(format, Number.isInteger(trimFloat(n)) && format.aggregate !== 'avg' ? [n] : undefined));
}

/** Compact, three significant digits: `39.0M`, `812K`, `1.50B`, `523`, `0.500`. */
export function formatCompact(value: number | bigint | null | undefined): string {
  const text = special(value);
  if (text !== null) return text;
  const n = typeof value === 'bigint' ? Number(value) : (value as number);
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs >= 1e15 || abs < 1e-6) return exponent(n);
  return unsignZero(nfSignificant(3, true).format(trimFloat(n)));
}

/**
 * A formatter for a measure's values. Pass the result's values so every
 * label of one chart uses one mode (see `measureMode`).
 */
export function measureFormatter(format: MeasureFormat = {}, values?: ArrayLike<number>): (value: number) => string {
  const mode = measureMode(format, values);
  return (value) => {
    const text = special(value);
    return text ?? formatInMode(value, mode);
  };
}

/** Bar labels switch to compact text when the largest value reaches this (counts and other whole numbers: COMPACT_INTEGER_LABEL_MIN). */
export const COMPACT_LABEL_MIN = 1_000_000;
/** Whole numbers (counts) stay exact up to here: `1,375,980` reads better than `1.38M` and fits a label. */
export const COMPACT_INTEGER_LABEL_MIN = 1_000_000_000;

/** Whether labels for `values` should be compact (see COMPACT_LABEL_MIN). */
export function compactLabels(values: ArrayLike<number>): boolean {
  let max = 0;
  let integral = true;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] ?? Number.NaN;
    if (!Number.isFinite(v)) continue;
    if (Math.abs(v) > max) max = Math.abs(v);
    if (integral && !Number.isInteger(trimFloat(v))) integral = false;
  }
  return max >= (integral ? COMPACT_INTEGER_LABEL_MIN : COMPACT_LABEL_MIN);
}

/**
 * A formatter for labels drawn next to marks, where space is tight: the full
 * measure while the largest value is under a million (a billion for whole
 * numbers), compact (`39.0M`) for every label once it is not.
 */
export function labelFormatter(format: MeasureFormat = {}, values: ArrayLike<number> = []): (value: number) => string {
  return compactLabels(values) ? formatCompact : measureFormatter(format, values);
}

const MAX_RANGE_DECIMALS = 6;

/** Decimals `value` needs (at most 6): `2` → 0, `2.5` → 1, `0.125` → 3. */
export function decimalsNeeded(value: number): number {
  if (!Number.isFinite(value)) return 0;
  for (let digits = 0; digits < MAX_RANGE_DECIMALS; digits += 1) {
    const scale = 10 ** digits;
    if (Math.abs(Math.round(value * scale) / scale - value) <= 1e-9 * Math.max(1, Math.abs(value))) return digits;
  }
  return MAX_RANGE_DECIMALS;
}

/** At least two decimals for float and DECIMAL columns, as the design writes ranges (`2.00 – 6.00`). */
function minDecimals(type: ColumnType | null | undefined): number {
  return type === 'float' || type === 'decimal' ? 2 : 0;
}

/** A single filter value: `2.50`, `1,234.50`, `3` (integers as is, floats with at least two decimals). */
export function formatFilterNumber(value: number, type: ColumnType | null | undefined = null): string {
  const text = special(value);
  if (text !== null) return text;
  const digits = Math.max(minDecimals(type), decimalsNeeded(value));
  return fixed(value, digits);
}

/**
 * Both bounds of a numeric range with the same decimals: as many as the
 * bounds need, at least two on float and DECIMAL columns, and no more than
 * the span warrants (three significant digits of it, one more for exact
 * bounds such as `0.125 – 2.000`), so a free brush reads
 * `3.14 – 7.20` rather than `3.141593 – 7.2`.
 */
export function formatNumericRange(lo: number, hi: number, type: ColumnType | null | undefined = null): [string, string] {
  const floor = minDecimals(type);
  const needed = Math.max(decimalsNeeded(lo), decimalsNeeded(hi));
  const span = Math.abs(hi - lo);
  const spanDigits = Number.isFinite(span) && span > 0 ? Math.max(0, Math.ceil(-Math.log10(span)) + 2) : MAX_RANGE_DECIMALS;
  // Exact bounds (bin edges, typed values) print exactly unless they need well over what the span warrants.
  const digits = Math.max(floor, Math.min(needed <= spanDigits + 1 ? needed : spanDigits, MAX_RANGE_DECIMALS));
  const one = (value: number) => special(value) ?? fixed(value, digits);
  return [one(lo), one(hi)];
}
