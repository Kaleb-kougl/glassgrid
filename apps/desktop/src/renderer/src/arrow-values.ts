import { DataType, TimeUnit, type Field, type Table } from 'apache-arrow';
import type { FilterValue, GridCellValue } from './types';

/*
 * Arrow values as the renderer shows them (docs/m2-engine-notes.md, "Arrow
 * types"). DATE arrives as epoch milliseconds, TIMESTAMP as (fractional)
 * epoch milliseconds, BIGINT as bigint; DECIMAL as Decimal128 (a 4-word
 * BN, unscaled, with the scale on the field type), TIME as Time64 bigint
 * microseconds (TIME_NS: nanoseconds) since midnight, INTERVAL as
 * Interval(MONTH_DAY_NANO) (Int32Array [months, days, nanos lo, nanos hi]).
 */

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `YYYY-MM-DD HH:MM:SS[.ffffff]` in UTC wall-clock time, as DuckDB prints timestamps. */
export function formatTimestamp(ms: number): string {
  const whole = Math.floor(ms);
  const d = new Date(whole);
  const base = `${formatDate(whole)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const micros = Math.round((ms - Math.floor(ms / 1000) * 1000) * 1000);
  return micros === 0 ? base : `${base}.${pad(micros, 6).replace(/0+$/, '')}`;
}

/** `decimal:<scale>` carries the field's scale, which the values themselves lack. */
export type ValueKind = 'date' | 'timestamp' | 'time' | 'timeNs' | 'interval' | `decimal:${number}` | 'other';

export function valueKind(field: Field | undefined): ValueKind {
  if (!field) return 'other';
  const type: unknown = field.type;
  if (DataType.isDate(type)) return 'date';
  if (DataType.isTimestamp(type)) return 'timestamp';
  if (DataType.isDecimal(type)) return `decimal:${type.scale}`;
  if (DataType.isTime(type)) return type.unit === TimeUnit.NANOSECOND ? 'timeNs' : 'time';
  if (DataType.isInterval(type)) return 'interval';
  return 'other';
}

function decimalScale(kind: ValueKind): number | null {
  return kind.startsWith('decimal:') ? Number(kind.slice('decimal:'.length)) : null;
}

/**
 * The unscaled integer of a Decimal128 value (Arrow JS returns its four
 * little-endian 32-bit words; its own bigNumToBigInt loses precision for
 * negative 128-bit values).
 */
export function decimalUnscaled(words: ArrayLike<number>): bigint {
  let unsigned = 0n;
  for (let i = words.length - 1; i >= 0; i -= 1) unsigned = (unsigned << 32n) | BigInt((words[i] ?? 0) >>> 0);
  return BigInt.asIntN(words.length * 32, unsigned);
}

/** Exact text of a Decimal128 value: the unscaled integer with the point inserted (`-0.05`, `12.30`). */
export function formatDecimal(value: unknown, scale: number): string {
  const unscaled = decimalUnscaled(value as ArrayLike<number>);
  const negative = unscaled < 0n;
  const digits = (negative ? -unscaled : unscaled).toString().padStart(scale + 1, '0');
  const whole = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${whole}` : whole;
}

/** `HH:MM:SS[.ffffff]` from microseconds (or nanoseconds with `perSecond` 1e9) since midnight. */
export function formatTime(value: bigint, perSecond = 1_000_000n): string {
  const seconds = value / perSecond;
  const fraction = value % perSecond;
  const base = `${pad(Number(seconds / 3600n))}:${pad(Number((seconds / 60n) % 60n))}:${pad(Number(seconds % 60n))}`;
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
    let text = `${hours < 10n ? `0${hours}` : `${hours}`}:${pad(Number((seconds / 60n) % 60n))}:${pad(Number(seconds % 60n))}`;
    if (fraction !== 0n) text += `.${fraction.toString().padStart(6, '0').replace(/0+$/, '')}`;
    parts.push(negative ? `-${text}` : text);
  }
  return parts.join(' ');
}

/** A cell's display text, or null for SQL NULL. */
export function displayValue(value: unknown, kind: ValueKind): GridCellValue {
  if (value === null || value === undefined) return null;
  if (kind === 'date' && typeof value === 'number') return formatDate(value);
  if (kind === 'timestamp' && typeof value === 'number') return formatTimestamp(value);
  const scale = decimalScale(kind);
  if (scale !== null && typeof value === 'object') return formatDecimal(value, scale);
  if (kind === 'time' && typeof value === 'bigint') return formatTime(value);
  if (kind === 'timeNs' && typeof value === 'bigint') return formatTime(value, 1_000_000_000n);
  if (kind === 'interval' && typeof value === 'object') return formatInterval(value as ArrayLike<number>);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return formatTimestamp(value.getTime());
  return JSON.stringify(value);
}

/**
 * The filter value that selects `value` in an `in` filter. Dates and whole
 * millisecond timestamps go as epoch ms, other timestamps as ISO text; big
 * integers outside the safe range as their nearest double.
 */
export function filterValue(value: unknown, kind: ValueKind): FilterValue {
  if (value === null || value === undefined) return null;
  if (kind === 'timestamp' && typeof value === 'number' && !Number.isInteger(value)) return formatTimestamp(value);
  const scale = decimalScale(kind);
  // The compiler compares numeric columns as DOUBLE, so a decimal filters by its nearest double.
  if (scale !== null && typeof value === 'object') return Number(formatDecimal(value, scale));
  if (kind === 'time' || kind === 'timeNs' || kind === 'interval') return displayValue(value, kind);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.getTime();
  return JSON.stringify(value);
}

/** Rows of a page as display cells, in the order of `columns`. */
export function pageRows(table: Table, columns: readonly string[]): GridCellValue[][] {
  const vectors = columns.map((name) => {
    const index = table.schema.fields.findIndex((field) => field.name === name);
    return index < 0 ? null : { vector: table.getChildAt(index), kind: valueKind(table.schema.fields[index]) };
  });
  const rows: GridCellValue[][] = [];
  for (let r = 0; r < table.numRows; r += 1) {
    rows.push(vectors.map((column) => (column?.vector ? displayValue(column.vector.get(r), column.kind) : null)));
  }
  return rows;
}
