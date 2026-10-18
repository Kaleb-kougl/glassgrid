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

/**
 * performance.measure name for "chart create": a column dropped on the
 * charts panel (or "+ New chart", Enter on a column) -> the new card's chart
 * drawn on its canvas (aggregate, Arrow decode, adaptation, layers, paint).
 */
export const CHART_CREATE_MEASURE = 'glassgrid:chart-create';

export interface ChartCreateMeasureDetail {
  chartId: string;
  /** Mark of the drawn chart (`heatmap` when a scatter fell back). */
  mark: string;
  /** Columns dropped. */
  columns: string[];
  engineMs: number;
  cached: boolean;
  rows: number;
}

/**
 * performance.measure name for one cross-filter update: a brush released (or
 * a bar clicked) -> the last other view painted with the new filters (every
 * other chart drawn, the grid's count shown and its first rows painted).
 */
export const CROSSFILTER_MEASURE = 'glassgrid:crossfilter';

export interface CrossfilterViewTiming {
  /** `chart:<id>`, `grid:count` or `grid:rows`. */
  view: string;
  /** Brush end -> this view painted. */
  ms: number;
  engineMs: number;
  /** Answered from a cross-filter cube. */
  fromCube: boolean;
  cached: boolean;
}

export interface CrossfilterMeasureDetail {
  /** The brushed (or clicked) chart. */
  source: string;
  /** The grid's filters after the commit (every selection and user filter). */
  filters: unknown[];
  /** The grid's row count under them. */
  rowCount: number | null;
  views: CrossfilterViewTiming[];
}

/**
 * performance.measure name for a brush start (pointer down on a chart) ->
 * the cross-filter cubes for the other views built (`prepareCrossfilter`).
 */
export const CROSSFILTER_PREPARE_MEASURE = 'glassgrid:crossfilter-prepare';

export interface CrossfilterPrepareMeasureDetail {
  source: string;
  dimension: string;
  cubes: { status: string; rows?: number; reason?: string }[];
  engineMs: number;
}
