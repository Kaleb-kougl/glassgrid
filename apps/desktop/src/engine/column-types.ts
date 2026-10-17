import { DuckDBDecimalValue, type DuckDBValue } from '@duckdb/node-api';
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

const MAX_TEXT = 200;

/** Convert a DuckDB value to a JSON-safe scalar for profiles (long text is truncated). */
export function toScalar(value: DuckDBValue): ProfileValue {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof DuckDBDecimalValue) return value.toDouble();
  const text = typeof value === 'string' ? value : String(value);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

export function toCount(value: DuckDBValue): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  throw new TypeError(`Expected an integer count, got ${String(value)}`);
}
