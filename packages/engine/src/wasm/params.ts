import type { DriverParam } from '../driver';
import { quoteLiteral } from '../sql-text';

/*
 * DuckDB-WASM's pending-query API (the only one that can be interrupted)
 * takes SQL text, not bound values. Parameterized statements therefore run
 * as `PREPARE p AS <sql>` and `EXECUTE p(<args>)`, with each argument a
 * typed constant expression. The SQL itself still carries placeholders,
 * so a value never becomes part of the statement's text; the arguments are
 * rendered with the same types the native binding binds:
 *
 * - number: DOUBLE (`CAST('1.7000000000000002' AS DOUBLE)`, exact round trip,
 *   also for NaN and +-Infinity);
 * - bigint: BIGINT, or HUGEINT beyond 64 bits;
 * - string: VARCHAR literal (quotes doubled; NUL is rejected);
 * - boolean, null.
 */
export function argumentLiteral(value: DriverParam): string {
  if (value === null) return 'NULL';
  switch (typeof value) {
    case 'boolean':
      return value ? 'TRUE' : 'FALSE';
    case 'number':
      return `CAST(${quoteLiteral(Number.isNaN(value) ? 'NaN' : String(value))} AS DOUBLE)`;
    case 'bigint': {
      const fits = value >= -(2n ** 63n) && value < 2n ** 63n;
      return `CAST(${quoteLiteral(value.toString())} AS ${fits ? 'BIGINT' : 'HUGEINT'})`;
    }
    case 'string':
      return `CAST(${quoteLiteral(value)} AS VARCHAR)`;
  }
}

/** Statements DuckDB can `PREPARE`; others (CREATE TABLE ... AS, COPY) get their arguments inlined. */
export function isPreparable(sql: string): boolean {
  return /^\s*(SELECT|WITH|FROM|VALUES|\(|INSERT|UPDATE|DELETE)\b/i.test(sql) || /^\s*\(/.test(sql);
}

/**
 * Replace `?` and `$n` placeholders outside string literals, quoted
 * identifiers and comments with the arguments' typed literals. Used only
 * for statements DuckDB cannot PREPARE (`CREATE TABLE ... AS SELECT`, which
 * the engine runs for sort indexes and cubes). The SQL comes from the
 * engine and the compiler, never from a request; the values are rendered
 * by `argumentLiteral`, so they cannot end the literal they sit in.
 */
export function inlineArguments(sql: string, params: readonly DriverParam[]): string {
  let out = '';
  let positional = 0;
  let i = 0;
  const n = sql.length;
  const isIdentChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
  while (i < n) {
    const ch = sql[i] ?? '';
    const next = sql[i + 1];
    if (ch === "'" || ch === '"') {
      // Quoted literal or identifier; a doubled quote is an escaped quote.
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Error('Unterminated quote in SQL');
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated comment in SQL');
      out += sql.slice(i, end + 2);
      i = end + 2;
    } else if (ch === '?' && !isIdentChar(sql[i - 1])) {
      const value = params[positional];
      if (positional >= params.length || value === undefined) throw new Error('More placeholders than arguments');
      positional += 1;
      out += argumentLiteral(value);
      i += 1;
    } else if (ch === '$' && next !== undefined && /[0-9]/.test(next) && !isIdentChar(sql[i - 1])) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql[j] ?? '')) j += 1;
      const index = Number(sql.slice(i + 1, j)) - 1;
      const value = params[index];
      if (value === undefined) throw new Error(`No argument for $${index + 1}`);
      out += argumentLiteral(value);
      i = j;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}
