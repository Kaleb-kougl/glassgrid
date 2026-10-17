import { type ColumnProfile, type ColumnType } from '../../src/index.js';

/**
 * In-memory model of a small test table. Cells use one JS representation per
 * logical type so the reference implementation can work on them directly:
 * - integer / float / decimal: number (floats are multiples of 1/8 and
 *   decimals multiples of 1/100, so every aggregate has an exact rational
 *   value; see `units`);
 * - date / timestamp: epoch milliseconds (UTC wall clock);
 * - text: string; boolean: boolean; NULL: null.
 */
export type Cell = number | string | boolean | null;

export interface TestColumn {
  readonly name: string;
  readonly type: ColumnType;
}

export interface TestTable {
  readonly columns: readonly TestColumn[];
  readonly rows: readonly (readonly Cell[])[];
}

export const ALL_TYPES: readonly ColumnType[] = ['integer', 'float', 'decimal', 'boolean', 'date', 'timestamp', 'text'];

/** Denominator that makes every value of a numeric column an integer. */
export function numericScale(type: ColumnType): number {
  switch (type) {
    case 'float':
      return 8;
    case 'decimal':
      return 100;
    default:
      return 1;
  }
}

export const SQL_TYPE: Record<ColumnType, string> = {
  integer: 'INTEGER',
  float: 'DOUBLE',
  decimal: 'DECIMAL(10,2)',
  boolean: 'BOOLEAN',
  date: 'DATE',
  timestamp: 'TIMESTAMP',
  text: 'VARCHAR',
};

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isoTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/** Column profile computed from the model, in the shape the engine reports. */
export function profileOf(table: TestTable): ColumnProfile[] {
  return table.columns.map((column, c) => {
    const values = table.rows.map((row) => row[c] ?? null).filter((v): v is Exclude<Cell, null> => v !== null);
    const sorted = [...values].sort(compareCells);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const asProfile = (v: Exclude<Cell, null> | undefined) => {
      if (v === undefined) return null;
      if (column.type === 'date' && typeof v === 'number') return isoDate(v);
      if (column.type === 'timestamp' && typeof v === 'number') return isoTimestamp(v);
      return v;
    };
    return {
      name: column.name,
      type: column.type,
      nullFraction: table.rows.length === 0 ? 0 : (table.rows.length - values.length) / table.rows.length,
      distinctCount: new Set(values).size,
      min: asProfile(first),
      max: asProfile(last),
    };
  });
}

/** DuckDB's binary VARCHAR order is UTF-8 byte order, i.e. code point order. */
export function compareStrings(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const d = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
}

/** Order of two non-null cells of the same column (numbers, strings, booleans). */
export function compareCells(a: Exclude<Cell, null>, b: Exclude<Cell, null>): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return compareStrings(a, b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  throw new Error(`Cannot compare ${typeof a} with ${typeof b}`);
}

/** Ascending order with NULLs last. */
export function compareNullsLast(a: Cell, b: Cell): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return compareCells(a, b);
}
