/**
 * SQL text for engine operations. Inputs are always bound as parameters, never
 * interpolated; the future SQL compiler will live alongside this module.
 */
export const Sql = {
  countRows: 'SELECT count(*) AS row_count FROM read_csv_auto($1)',
} as const;

export const ROW_COUNT_COLUMN = 'row_count';
