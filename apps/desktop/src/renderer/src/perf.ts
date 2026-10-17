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
 * performance.measure name for "Open CSV" click -> first grid page decoded
 * (dialog or E2E hook, file registration, engine open, first 1,000 rows).
 */
export const OPEN_TO_FIRST_PAGE_MEASURE = 'glassgrid:open-to-first-page';

export interface OpenToFirstPageMeasureDetail {
  /** Engine time for `open` (fingerprint, view, DESCRIBE). */
  openEngineMs: number;
  /** Engine time for the first `rows` page (query + Arrow encode). */
  firstPageEngineMs: number;
  /** Rows and columns in the decoded first page. */
  rows: number;
  columns: number;
  usingParquetCache: boolean;
}

/** performance.measure name for one profile round trip, started after the first page. */
export const PROFILE_MEASURE = 'glassgrid:profile';

export interface ProfileMeasureDetail {
  engineMs: number;
  rowCount: number;
  columns: number;
}
