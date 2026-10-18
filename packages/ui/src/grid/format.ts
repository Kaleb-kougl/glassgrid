import { DataType, TimeUnit, type Field } from 'apache-arrow';
import { isNumericType, isTemporalType, type ColumnType, type FilterValue } from '@glassgrid/core';
import type { GridCell } from './types.js';

/*
 * The one place Arrow values become display text, used by the grid's
 * `ArrowPagedSource`, chart labels and "View data". Output matches DuckDB's
 * own `CAST(x AS VARCHAR)` for the types the engine sends
 * (docs/m2-engine-notes.md, "Arrow types"):
 *
 * | Arrow (from DuckDB)              | JS value from `vector.get(i)`                     | Text                              |
 * | -------------------------------- | ------------------------------------------------- | --------------------------------- |
 * | DateDay (DATE)                   | epoch ms                                          | `YYYY-MM-DD`                      |
 * | Timestamp (TIMESTAMP*)           | (fractional) epoch ms                             | `YYYY-MM-DD HH:MM:SS[.ffffff]` UTC |
 * | Decimal128 (DECIMAL(p,s))        | 4 little-endian uint32 words, unscaled            | exact, e.g. `-0.005`              |
 * | Time64 µs / ns (TIME, TIME_NS)   | bigint since midnight                             | `HH:MM:SS[.ffffff]`               |
 * | Interval MONTH_DAY_NANO          | Int32Array [months, days, nanos lo, nanos hi]     | `1 year 2 months 3 days 04:05:06` |
 * | Int64 (BIGINT)                   | bigint                                            | digits                            |
 *
 * Numbers print as JavaScript prints them (no grouping, so digits line up in
 * tabular figures); booleans as `true`/`false`.
 */

const pad2 = (value: number) => (value < 10 ? `0${value}` : String(value));

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const y = year >= 0 && year < 10_000 ? String(year).padStart(4, '0') : String(year);
  return `${y}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** `YYYY-MM-DD HH:MM:SS[.ffffff]` in UTC wall-clock time (trailing zeros of the fraction dropped). */
export function formatTimestamp(ms: number): string {
  const whole = Math.floor(ms);
  const d = new Date(whole);
  const base = `${formatDate(whole)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  const micros = Math.round((ms - Math.floor(ms / 1000) * 1000) * 1000);
  if (micros === 0) return base;
  return `${base}.${String(micros).padStart(6, '0').replace(/0+$/, '')}`;
}

/**
 * The unscaled integer of a Decimal128 value (Arrow JS hands out its four
 * little-endian 32-bit words). Apache Arrow's own `bigNumToBigInt` loses
 * precision for negative 128-bit values, so this does the two's complement itself.
 */
export function decimalUnscaled(words: ArrayLike<number>): bigint {
  let unsigned = 0n;
  for (let i = words.length - 1; i >= 0; i -= 1) unsigned = (unsigned << 32n) | BigInt((words[i] ?? 0) >>> 0);
  return BigInt.asIntN(words.length * 32, unsigned);
}

/** Exact text of a Decimal128 value: the unscaled integer with the point inserted (`-0.05`, `12.30`). */
export function formatDecimal(value: ArrayLike<number>, scale: number): string {
  const unscaled = decimalUnscaled(value);
  const negative = unscaled < 0n;
  const digits = (negative ? -unscaled : unscaled).toString().padStart(scale + 1, '0');
  const whole = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${whole}` : whole;
}

/** `HH:MM:SS[.ffffff]` from microseconds (or nanoseconds with `perSecond` 1e9) since midnight. */
export function formatTime(value: bigint, perSecond = 1_000_000n): string {
  const seconds = value / perSecond;
  const fraction = value % perSecond;
  const base = `${pad2(Number(seconds / 3600n))}:${pad2(Number((seconds / 60n) % 60n))}:${pad2(Number(seconds % 60n))}`;
  if (fraction === 0n) return base;
  const width = perSecond.toString().length - 1;
  return `${base}.${fraction.toString().padStart(width, '0').replace(/0+$/, '')}`;
}

/** DuckDB's interval text, e.g. `1 year 2 months 3 days 04:05:06.5`, from [months, days, nanos lo, nanos hi]. */
export function formatInterval(value: ArrayLike<number>): string {
  const months = value[0] ?? 0;
  const days = value[1] ?? 0;
  const nanos = (BigInt(value[3] ?? 0) << 32n) | BigInt((value[2] ?? 0) >>> 0);
  const parts: string[] = [];
  const unit = (count: number, name: string) => `${count} ${name}${Math.abs(count) === 1 ? '' : 's'}`;
  const years = Math.trunc(months / 12);
  if (years !== 0) parts.push(unit(years, 'year'));
  if (months % 12 !== 0) parts.push(unit(months % 12, 'month'));
  if (days !== 0) parts.push(unit(days, 'day'));
  const micros = nanos / 1000n;
  if (micros !== 0n || parts.length === 0) {
    const negative = micros < 0n;
    const abs = negative ? -micros : micros;
    const seconds = abs / 1_000_000n;
    const hours = seconds / 3600n;
    const fraction = abs % 1_000_000n;
    let text = `${hours < 10n ? `0${hours}` : `${hours}`}:${pad2(Number((seconds / 60n) % 60n))}:${pad2(Number(seconds % 60n))}`;
    if (fraction !== 0n) text += `.${fraction.toString().padStart(6, '0').replace(/0+$/, '')}`;
    parts.push(negative ? `-${text}` : text);
  }
  return parts.join(' ');
}

/**
 * How a raw value should be read. The Arrow field type decides
 * (`valueKind`); `decimal:<scale>` carries the scale the values lack.
 */
export type ValueKind = 'date' | 'timestamp' | 'time' | 'timeNs' | 'interval' | `decimal:${number}` | 'other';

/** The kind of an Arrow field's values; `fallback` when the physical type says nothing special (e.g. Utf8). */
export function valueKind(field: Field | undefined, fallback: ValueKind = 'other'): ValueKind {
  if (!field) return fallback;
  const type: unknown = field.type;
  if (DataType.isDate(type)) return 'date';
  if (DataType.isTimestamp(type)) return 'timestamp';
  if (DataType.isDecimal(type)) return `decimal:${type.scale}`;
  if (DataType.isTime(type)) return type.unit === TimeUnit.NANOSECOND ? 'timeNs' : 'time';
  if (DataType.isInterval(type)) return 'interval';
  return fallback;
}

/** The kind a logical column type implies when the physical type does not say. */
export function kindForType(type: ColumnType): ValueKind {
  if (type === 'date') return 'date';
  if (type === 'timestamp') return 'timestamp';
  return 'other';
}

function decimalScale(kind: ValueKind): number | null {
  return kind.startsWith('decimal:') ? Number(kind.slice('decimal:'.length)) : null;
}

function isWords(value: unknown): value is ArrayLike<number> {
  return ArrayBuffer.isView(value) || Array.isArray(value);
}

function formatOther(value: unknown, kind: ValueKind): GridCell {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      if (kind === 'date' && Number.isFinite(value)) return formatDate(value);
      if (kind === 'timestamp' && Number.isFinite(value)) return formatTimestamp(value);
      return String(value);
    case 'bigint':
      if (kind === 'date') return formatDate(Number(value));
      if (kind === 'timestamp') return formatTimestamp(Number(value));
      return value.toString();
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      break;
  }
  if (value instanceof Date) return kind === 'date' ? formatDate(value.getTime()) : formatTimestamp(value.getTime());
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  try {
    return JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * A formatter for one column's values, resolved once per column so the
 * per-cell work is a direct call: display text, or null for SQL NULL.
 */
export function formatterFor(kind: ValueKind): (value: unknown) => GridCell {
  const scale = decimalScale(kind);
  if (scale !== null) {
    return (value) => (value === null || value === undefined ? null : isWords(value) ? formatDecimal(value, scale) : formatOther(value, 'other'));
  }
  switch (kind) {
    case 'time':
      return (value) => (value === null || value === undefined ? null : typeof value === 'bigint' ? formatTime(value) : formatOther(value, 'other'));
    case 'timeNs':
      return (value) =>
        value === null || value === undefined ? null : typeof value === 'bigint' ? formatTime(value, 1_000_000_000n) : formatOther(value, 'other');
    case 'interval':
      return (value) => (value === null || value === undefined ? null : isWords(value) ? formatInterval(value) : formatOther(value, 'other'));
    default:
      return (value) => (value === null || value === undefined ? null : formatOther(value, kind));
  }
}

/** A raw value (as Arrow hands it out) as display text, or null for NULL. */
export function formatValue(value: unknown, kind: ValueKind): GridCell {
  return formatterFor(kind)(value);
}

/**
 * The value that selects `value` in an `in` filter. Dates and whole
 * millisecond timestamps go as epoch ms, other timestamps as their text;
 * decimals and big integers as their nearest double (the compiler compares
 * numeric columns as DOUBLE); times and intervals as their text.
 */
export function filterValue(value: unknown, kind: ValueKind): FilterValue {
  if (value === null || value === undefined) return null;
  if (kind === 'timestamp' && typeof value === 'number' && !Number.isInteger(value)) return formatTimestamp(value);
  const scale = decimalScale(kind);
  if (scale !== null && isWords(value)) return Number(formatDecimal(value, scale));
  if (kind === 'time' || kind === 'timeNs' || kind === 'interval') return formatValue(value, kind);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.getTime();
  return formatValue(value, kind);
}

/** How a column's cells are drawn. */
export type CellKind = 'number' | 'temporal' | 'text';

export function cellKind(type: ColumnType): CellKind {
  if (isNumericType(type)) return 'number';
  if (isTemporalType(type)) return 'temporal';
  return 'text';
}

/** Default width for a column of `type` named `name` (the header text must fit). */
export function columnWidthFor(name: string, type: ColumnType): number {
  const base: Record<ColumnType, number> = {
    integer: 104,
    float: 104,
    decimal: 104,
    boolean: 88,
    date: 112,
    timestamp: 168,
    text: 160,
  };
  return Math.max(base[type], Math.min(320, Math.round(name.length * 7.2 + 40)));
}
