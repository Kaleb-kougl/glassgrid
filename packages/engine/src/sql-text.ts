/*
 * Helpers for the few places where the engine must put a value into SQL text
 * rather than bind it: DDL (views and CREATE TABLE AS cannot always take
 * parameters), COPY targets, identifiers and integer bounds it computed
 * itself. Everything that comes from a request is either validated against
 * the table's schema (column names) or a Zod-checked integer.
 */

/** A compiled SQL fragment with bound values, e.g. a WHERE predicate from the spec compiler. */
export interface SqlFragment {
  /** SQL text using `?` or `$n` placeholders for `params`. Must not contain other placeholders. */
  readonly sql: string;
  readonly params: readonly SqlParam[];
}

export type SqlParam = string | number | boolean | bigint | null;

/** Quote an identifier: `"` doubled, wrapped in `"`. */
export function quoteIdent(name: string): string {
  if (name.includes('\0')) throw new Error('Identifier contains a NUL character');
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Quote a string literal. DuckDB's standard string literals have no
 * backslash escapes, so doubling `'` is sufficient.
 */
export function quoteLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('String literal contains a NUL character');
  return `'${value.replaceAll("'", "''")}'`;
}

/** Render a non-negative safe integer for LIMIT/OFFSET/range bounds. */
export function intLiteral(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Expected a non-negative integer, got ${value}`);
  return String(value);
}

/** Stable serialisation of a fragment for cache keys (bigint-safe). */
export function fragmentKey(fragment: SqlFragment | undefined): string {
  if (!fragment) return '';
  // Tag each value with its type so 1, 1n, '1' and true stay distinct.
  const params = fragment.params.map((p) => [typeof p, typeof p === 'bigint' ? p.toString() : p]);
  return JSON.stringify([fragment.sql, params]);
}
