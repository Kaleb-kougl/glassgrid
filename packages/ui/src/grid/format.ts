import { isNumericType, isTemporalType, type ColumnType } from '@glassgrid/core';
import type { GridCell } from './types.js';

/*
 * Display formatting shared by the paged sources. Matches the DOM DataGrid
 * (and DuckDB's own printing): `YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS[.ffffff]`
 * in UTC wall-clock time, numbers as JavaScript prints them (no grouping, so
 * digits line up in tabular figures), booleans as `true`/`false`.
 */

const pad2 = (value: number) => (value < 10 ? `0${value}` : String(value));

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const y = year >= 0 && year < 10_000 ? String(year).padStart(4, '0') : String(year);
  return `${y}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** `YYYY-MM-DD HH:MM:SS[.ffffff]` (trailing zeros of the fraction dropped). */
export function formatTimestamp(ms: number): string {
  const whole = Math.floor(ms);
  const d = new Date(whole);
  const base = `${formatDate(whole)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  const micros = Math.round((ms - Math.floor(ms / 1000) * 1000) * 1000);
  if (micros === 0) return base;
  return `${base}.${String(micros).padStart(6, '0').replace(/0+$/, '')}`;
}

/** How a raw value should be read: as epoch-ms date, epoch-ms timestamp, or by its JS type. */
export type ValueKind = 'date' | 'timestamp' | 'other';

/** The kind a logical column type implies when the physical type does not say. */
export function kindForType(type: ColumnType): ValueKind {
  if (type === 'date') return 'date';
  if (type === 'timestamp') return 'timestamp';
  return 'other';
}

/** A raw value (as Arrow hands it out) as display text, or null for NULL. */
export function formatValue(value: unknown, kind: ValueKind): GridCell {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      if (kind === 'date' && Number.isFinite(value)) return formatDate(value);
      if (kind === 'timestamp' && Number.isFinite(value)) return formatTimestamp(value);
      return String(value);
    case 'bigint':
      if (kind === 'date' || kind === 'timestamp') {
        const ms = Number(value);
        return kind === 'date' ? formatDate(ms) : formatTimestamp(ms);
      }
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

/** How a column's cells are drawn. */
export type CellKind = 'number' | 'temporal' | 'text';

export function cellKind(type: ColumnType): CellKind {
  if (isNumericType(type)) return 'number';
  if (isTemporalType(type)) return 'temporal';
  return 'text';
}

/** Default width for a column of `type` named `name` (header text must fit). Same as the DOM grid. */
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
