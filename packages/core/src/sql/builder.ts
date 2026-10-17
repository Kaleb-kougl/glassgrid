import { CompileError } from './errors.js';

/** SQL text plus its positional parameters (`$1` is `params[0]`). */
export interface CompiledQuery {
  readonly sql: string;
  readonly params: unknown[];
}

/**
 * Quote an SQL identifier with double quotes, doubling embedded quotes. Safe
 * for any name DuckDB can store except one containing a NUL character.
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) throw new CompileError('invalid_spec', 'Column names cannot be empty');
  if (name.includes('\u0000')) {
    throw new CompileError('invalid_spec', 'Column names cannot contain the NUL character');
  }
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Collects bound parameters. Every data value goes through here; only code
 * constants and keywords chosen from closed enums are written into SQL text.
 * Placeholders carry an explicit CAST so the result does not depend on how
 * the caller's driver infers parameter types from JS values.
 */
export class Params {
  readonly values: unknown[] = [];

  /** A placeholder with no cast (`$n`). */
  raw(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  double(value: number): string {
    return `CAST(${this.raw(value)} AS DOUBLE)`;
  }

  bigint(value: number): string {
    return `CAST(${this.raw(value)} AS BIGINT)`;
  }

  text(value: string): string {
    return `CAST(${this.raw(value)} AS VARCHAR)`;
  }

  boolean(value: boolean): string {
    return `CAST(${this.raw(value)} AS BOOLEAN)`;
  }

  timestamp(value: string): string {
    return `CAST(${this.raw(value)} AS TIMESTAMP)`;
  }

  /** Integer epoch milliseconds as a TIMESTAMP. */
  epochMs(value: number): string {
    return `epoch_ms(${this.bigint(value)})`;
  }
}
