import { z } from 'zod';

/**
 * Logical column types Glassgrid works with. The engine maps DuckDB's physical
 * types onto these (e.g. TINYINT..HUGEINT -> integer, REAL/DOUBLE -> float,
 * DATE -> date, TIMESTAMP -> timestamp, VARCHAR -> text).
 */
export const COLUMN_TYPES = ['integer', 'float', 'decimal', 'boolean', 'date', 'timestamp', 'text'] as const;
export const ColumnTypeSchema = z.enum(COLUMN_TYPES);
export type ColumnType = z.infer<typeof ColumnTypeSchema>;

/**
 * A column's extreme value as reported by the profile:
 * - integer / float / decimal: a finite number;
 * - date / timestamp: an ISO 8601 string in DuckDB's canonical form
 *   (`2024-01-31`, `2024-01-31 12:00:00[.ffffff]`, a `T` separator and a
 *   trailing `Z` are accepted; the value is read as UTC wall-clock time) or a
 *   number of epoch milliseconds;
 * - text: a string; boolean: a boolean;
 * - null when the column has no non-null values or the profile skipped it.
 */
export const ProfileValueSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);
export type ProfileValue = z.infer<typeof ProfileValueSchema>;

export const ColumnProfileSchema = z.object({
  name: z.string().min(1),
  type: ColumnTypeSchema,
  /** Share of rows that are NULL, in [0, 1]. */
  nullFraction: z.number().min(0).max(1),
  /** Exact or approximate number of distinct non-null values. */
  distinctCount: z.number().int().nonnegative(),
  min: ProfileValueSchema,
  max: ProfileValueSchema,
});
export type ColumnProfile = z.infer<typeof ColumnProfileSchema>;

/**
 * The part of a profile the SQL compiler reads: name and type always, min and
 * max for automatic bin widths and time units (and, for heatmaps, to prove a
 * cheaper cell key exact). A full `ColumnProfile` fits, and so does the
 * engine's `TableColumnProfile`.
 *
 * `duckdbType` (optional) is the column's DuckDB type as DESCRIBE prints it.
 * When it is `TIMESTAMP`, hour and day buckets are grouped on an integer key
 * instead of `date_trunc`, with identical results; any other or no value
 * keeps `date_trunc`, which is right for every type.
 */
export type CompileColumn = Pick<ColumnProfile, 'name' | 'type'> & {
  readonly min?: ProfileValue | undefined;
  readonly max?: ProfileValue | undefined;
  readonly duckdbType?: string | undefined;
};

export const NUMERIC_TYPES: readonly ColumnType[] = ['integer', 'float', 'decimal'];
export const TEMPORAL_TYPES: readonly ColumnType[] = ['date', 'timestamp'];

export function isNumericType(type: ColumnType): boolean {
  return type === 'integer' || type === 'float' || type === 'decimal';
}

export function isTemporalType(type: ColumnType): boolean {
  return type === 'date' || type === 'timestamp';
}
