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

// ---------------------------------------------------------------------------
// Render-path instrumentation (`GLASSGRID_RENDER_PERF=1` builds only; see
// render-perf.ts). The E2E render benchmark arms one interaction at a time
// through `window.__ggRenderPerf` and reads back what happened between the
// input event and the frame that showed the result.

/** Prefix of the render-path marks: `glassgrid:<interaction>:<phase>`, e.g. `glassgrid:create:decoded`. */
export const RENDER_PERF_MARK_PREFIX = 'glassgrid:';

/** One timestamped step of an armed interaction (performance.now() time base). */
export interface RenderPerfEvent {
  t: number;
  /**
   * `input` (the DOM event's timeStamp), `dispatch` (the app calls the
   * command), `notify` (store listeners called), `render` (first App render
   * after the notify), `query` (a chart's aggregate effect ran), `request`
   * (posted to the engine port), `reply` (port message received),
   * `validated` (reply schema-checked), `decoded` (tableFromIPC done, `ms`),
   * `resolved` (the chart's query promise settled), `data-render` (ChartView
   * rendered a new result), `adapt` (chartColumnsFromArrow, `ms`), `model`
   * (a chart model built, `ms`), `layers` / `paint` (canvas layers built,
   * frame composited, `ms`), `drawn` (onDrawn), `commit-end`, `raf` (the
   * next animation frame after a commit or draw), `presented` (a task after
   * that frame's rendering).
   */
  type: string;
  view?: string;
  chartId?: string;
  requestId?: string;
  requestKind?: string;
  /** A duration the source measured itself (decode, adapt, model, layers, paint). */
  ms?: number;
  bytes?: number;
  /** Chart renderer name for model/layers/paint (`heatmap`, `bar`, …) or the input event type. */
  name?: string;
  engineMs?: number;
  cached?: boolean;
}

/** Why a component rendered in a commit. `same-props` and `unstable-props` are wasted renders. */
export type RenderCause = 'mount' | 'state' | 'context' | 'props' | 'same-props' | 'unstable-props';

export interface RenderPerfComponentRender {
  /** Component (function) name; the bundle is unminified in render-perf builds. */
  name: string;
  /** Innermost `<Profiler>` region around it (`TopBar`, `ColumnList`, `GridPanel`, `ChartsPanel`, `Chart:<mark>`, `App`). */
  region: string;
  cause: RenderCause;
  /** Render with props equal by value (or only new callback identities) and no state/context change: React.memo plus stable props would skip it. */
  wasted: boolean;
  /** This component's own render time (React profiling build `selfBaseDuration`). */
  selfMs: number;
  /** Props whose identity changed (for `props` / `unstable-props`), at most 8. */
  changed?: string[];
}

export interface RenderPerfCommit {
  /** Commit phase start (Profiler `commitTime`). */
  start: number;
  /** Render phase start of the root Profiler, when it rendered. */
  renderStart: number | null;
  /** Render phase time of the whole tree (root Profiler `actualDuration`). */
  renderMs: number;
  /** End of the commit's layout phase (React DevTools hook `onCommitFiberRoot`). */
  end: number;
  /** Layout effects time (root Profiler `onCommit` effectDuration). */
  layoutEffectsMs: number | null;
  /** Render time per Profiler region (`actualDuration`). */
  regions: Record<string, number>;
  components: RenderPerfComponentRender[];
  /** Time the commit inspector itself took (instrumentation overhead, after `end`). */
  inspectMs: number;
}

export interface RenderPerfRecording {
  kind: string;
  armedAt: number;
  events: RenderPerfEvent[];
  commits: RenderPerfCommit[];
}
