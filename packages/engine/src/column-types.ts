import type { DriverValue } from './driver';
import type { ColumnType, ProfileValue } from '@glassgrid/core';

const INTEGER = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT)$/;
const FLOAT = /^(FLOAT|REAL|DOUBLE)$/;

/** Collapse DuckDB's type name (as DESCRIBE prints it) to the UI's simple enum. */
export function simpleColumnType(duckdbType: string): ColumnType {
  const type = duckdbType.trim().toUpperCase();
  if (INTEGER.test(type)) return 'integer';
  if (FLOAT.test(type)) return 'float';
  if (type.startsWith('DECIMAL') || type.startsWith('NUMERIC')) return 'decimal';
  if (type === 'BOOLEAN') return 'boolean';
  if (type === 'DATE') return 'date';
  if (type.startsWith('TIMESTAMP')) return 'timestamp';
  // TIME, INTERVAL, UUID, BLOB, nested types, ...: shown as text for now.
  return 'text';
}

/** DECIMAL width and scale used when a non-decimal column is overridden to `decimal`. */
export const OVERRIDE_DECIMAL_TYPE = 'DECIMAL(38,6)';

/**
 * The DuckDB type a column is read as when overridden to `type`. A column
 * already inferred as that logical type keeps its own DuckDB type (so an
 * override that matches the inference is a no-op).
 */
export function overrideDuckdbType(type: ColumnType, inferredDuckdbType: string): string {
  if (simpleColumnType(inferredDuckdbType) === type) return inferredDuckdbType;
  switch (type) {
    case 'integer':
      return 'BIGINT';
    case 'float':
      return 'DOUBLE';
    case 'decimal':
      return OVERRIDE_DECIMAL_TYPE;
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'timestamp':
      return 'TIMESTAMP';
    case 'text':
      return 'VARCHAR';
  }
}

const MAX_TEXT = 200;

/** Convert a DuckDB value to a JSON-safe scalar for profiles (long text is truncated). */
export function toScalar(value: DriverValue): ProfileValue {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

export function toCount(value: DriverValue): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  throw new TypeError(`Expected an integer count, got ${JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`);
}
