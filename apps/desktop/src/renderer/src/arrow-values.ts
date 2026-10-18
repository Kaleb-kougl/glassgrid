import { DataType, type Field, type Table } from 'apache-arrow';
import type { FilterValue, GridCellValue } from './types';

/*
 * Arrow values as the renderer shows them. DATE arrives as epoch
 * milliseconds, TIMESTAMP as (fractional) epoch milliseconds, BIGINT as
 * bigint; DECIMAL, TIME and INTERVAL arrive as text (see m1-notes.md).
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

export type ValueKind = 'date' | 'timestamp' | 'other';

export function valueKind(field: Field | undefined): ValueKind {
  if (!field) return 'other';
  if (DataType.isDate(field.type)) return 'date';
  if (DataType.isTimestamp(field.type)) return 'timestamp';
  return 'other';
}

/** A cell's display text, or null for SQL NULL. */
export function displayValue(value: unknown, kind: ValueKind): GridCellValue {
  if (value === null || value === undefined) return null;
  if (kind === 'date' && typeof value === 'number') return formatDate(value);
  if (kind === 'timestamp' && typeof value === 'number') return formatTimestamp(value);
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
