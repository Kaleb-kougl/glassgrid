/*
 * Performance-timeline names shared with the E2E suite, which reads these
 * entries to build the benchmark baseline. Keep this module free of DOM and
 * React imports so Node-side tests can import it.
 */

/** performance.measure name for one "Count rows" round trip. */
export const COUNT_ROWS_MEASURE = 'glassgrid:count-rows';

/** `detail` attached to each COUNT_ROWS_MEASURE entry. */
export interface CountRowsMeasureDetail {
  /** Row count as a decimal string (kept a string for continuity with the M0 baseline). */
  rowCount: string;
  /** Time spent inside the engine, as reported by the engine. */
  engineMs: number;
  /** Served from the engine's result cache. */
  cached: boolean;
}

/**
 * performance.measure name for "Open CSV" click -> first rows painted on the
 * grid's canvas (dialog or E2E hook, file registration, engine open, the
 * first 1,000-row page, formatting and the first frame that shows rows).
 */
export const OPEN_TO_FIRST_ROWS_MEASURE = 'glassgrid:open-to-first-rows';

export interface OpenToFirstRowsMeasureDetail {
  /** Engine time for `open` (fingerprint, view, DESCRIBE). */
  openEngineMs: number;
  /** Engine time for the first `rows` page (query + Arrow encode). */
  firstPageEngineMs: number;
  /** Rows and columns in the decoded first page. */
  rows: number;
  columns: number;
  usingParquetCache: boolean;
}

/**
 * performance.measure name for a header click (sort) -> the first rows of
 * the sorted view painted (the engine's top-K path for the first 5,000 rows).
 */
export const SORT_TO_FIRST_ROWS_MEASURE = 'glassgrid:sort-to-first-rows';

export interface SortToFirstRowsMeasureDetail {
  /** The sort that was requested, e.g. `amount desc`. */
  sort: string;
  /** Engine time for the first page of the sorted view. */
  firstPageEngineMs: number;
  /** Served from the engine's result cache (a sort seen before). */
  cached: boolean;
}

/** performance.measure name for one profile round trip, started after the first page. */
export const PROFILE_MEASURE = 'glassgrid:profile';

export interface ProfileMeasureDetail {
  engineMs: number;
  rowCount: number;
  columns: number;
}

/** performance.measure name for one chart aggregate round trip (debug panel in M1). */
export const AGGREGATE_MEASURE = 'glassgrid:aggregate';

export interface AggregateMeasureDetail {
  engineMs: number;
  cached: boolean;
  /** Mark of the returned rows (heatmap after a scatter fallback). */
  mark: string;
  rows: number;
}
