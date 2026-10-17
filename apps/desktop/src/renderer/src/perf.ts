/*
 * Performance-timeline names shared with the E2E suite, which reads these
 * entries to build the benchmark baseline. Keep this module free of DOM and
 * React imports so Node-side tests can import it.
 */

/** performance.measure name for one "Count rows" round trip. */
export const COUNT_ROWS_MEASURE = 'glassgrid:count-rows';

/** `detail` attached to each COUNT_ROWS_MEASURE entry. */
export interface CountRowsMeasureDetail {
  /** Row count as a decimal string (BIGINT does not survive JSON as a number). */
  rowCount: string;
  /** Time spent inside the engine, as reported by the engine. */
  engineMs: number;
}
