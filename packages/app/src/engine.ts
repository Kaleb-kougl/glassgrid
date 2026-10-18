import type { Table } from 'apache-arrow';
import type {
  AggregateSpecInput,
  ColumnTypeOverride,
  ColumnTypeResult,
  CrossfilterDimension,
  CrossfilterHint,
  CubeTarget,
  EngineEvent,
  FileHandle,
  FilterInput,
  Mark,
  ParquetMode,
  PreparedCube,
  SortKey,
  TableColumnProfile,
  TableHandle,
  TableId,
} from '@glassgrid/core';

/*
 * The engine as the app sees it: the subset of the desktop `EngineClient`'s
 * public API (apps/desktop/src/renderer/src/engine-client.ts) that the app
 * calls, with the same signatures and result types. The desktop client (a
 * MessagePort to DuckDB in a utility process), the DuckDB-WASM worker client
 * (packages/engine, M4) and test doubles all satisfy it structurally; nothing
 * here depends on the transport.
 *
 * Kept structurally identical to the engine package's interface; at
 * integration one of the two becomes the shared type.
 *
 * Not used by the app, so not listed: `rows`, `fetchPage`, `ensureParquetCache`,
 * `clearCache`, `cacheStats`, `cancel`, `lastRequestId`, `connected`, `dispose`.
 */

export interface QueryOptions {
  /**
   * Logical consumer of the result (e.g. `grid`, `chart:3`). A newer request
   * for the same view rejects older pending ones with `superseded`. Omit for
   * one-off requests that must not replace anything.
   */
  viewId?: string;
  /** Aborting rejects with `cancelled`. */
  signal?: AbortSignal;
}

export interface FilteredQueryOptions extends QueryOptions {
  /** Only rows matching every filter (AND). */
  filters?: readonly FilterInput[];
}

export interface CrossfilterQueryOptions {
  /**
   * While another view is brushed: which filter is its selection and how it
   * bins its column (`viewQueries(state, { activeView }).…crossfilter`). The
   * engine may then answer from a cube; the result is the same.
   */
  crossfilter?: CrossfilterHint | null;
}

interface Timed {
  /** Time spent inside the engine, as reported by the engine. */
  engineMs: number;
  /** Served from the engine's result cache. */
  cached: boolean;
}

export interface RowsResult extends Timed {
  table: Table;
}

export interface AggregateResult extends Timed {
  table: Table;
  /** The mark the rows are shaped for; `heatmap` when a scatter fell back. */
  mark: Mark;
  /** A scatter spec had too many points, so a heatmap came back instead. */
  fellBackToHeatmap: boolean;
  /** Answered from a cross-filter cube (optional so test doubles may omit it). */
  fromCube?: boolean;
}

export interface CountResult extends Timed {
  rowCount: number;
  /** Answered from a cross-filter cube (optional so test doubles may omit it). */
  fromCube?: boolean;
}

export interface PrepareCrossfilterResult {
  /** One entry per target, in order: `ready` with its cells, or `skipped` with the reason. */
  cubes: PreparedCube[];
  engineMs: number;
}

export interface ProfileResult extends Timed {
  rowCount: number;
  columns: TableColumnProfile[];
}

export interface OpenResult {
  table: TableHandle;
  engineMs: number;
}

export interface ColumnTypesResult {
  /** The table with its new effective column types and `typeOverrides`. */
  table: TableHandle;
  /** Per requested override: effective type, DuckDB type and values that failed to convert (now NULL). */
  columns: ColumnTypeResult[];
  engineMs: number;
}

/** What the canvas grid calls per page: `limit` is at most 1,000. */
export type FetchPage = (offset: number, limit: number, signal?: AbortSignal) => Promise<RowsResult>;

/** The engine client every shell hands the app (`Platform.engine`). */
export interface EngineClientLike {
  /** Open a registered file (fingerprint, inferred column types). */
  open(file: FileHandle, options?: { parquet?: ParquetMode; signal?: AbortSignal }): Promise<OpenResult>;
  /** Row count and per-column statistics (a full scan). */
  profile(table: TableId, options?: QueryOptions): Promise<ProfileResult>;
  count(table: TableId, options?: FilteredQueryOptions & CrossfilterQueryOptions): Promise<CountResult>;
  /**
   * A `fetchPage(offset, limit, signal)` bound to one view's table, sort and
   * filters: what the canvas grid holds per view. Pages of one view run side
   * by side; aborting `signal` drops a page nobody needs any more.
   */
  pageFetcher(table: TableId, view?: { viewId?: string; sort?: SortKey[]; filters?: readonly FilterInput[] }): FetchPage;
  /** Replace the table's column type overrides (the complete set); views re-query afterwards. */
  setColumnTypes(table: TableId, overrides: readonly ColumnTypeOverride[], options?: { signal?: AbortSignal }): Promise<ColumnTypesResult>;
  /** Chart aggregate for a spec plus the plot's `pixelWidth`; `viewId: 'chart:<id>'` per card. */
  aggregate(table: TableId, spec: AggregateSpecInput, options?: QueryOptions & CrossfilterQueryOptions): Promise<AggregateResult>;
  /** At brush start: build the cubes the other views need (fire and forget). */
  prepareCrossfilter(
    table: TableId,
    plan: { dimension: CrossfilterDimension; targets: readonly CubeTarget[] },
    options?: QueryOptions,
  ): Promise<PrepareCrossfilterResult>;
  /** Done with a table (replaced, or the window is closing); its id reopens on demand later. */
  closeTable(table: TableId): Promise<void>;
  /** The engine restarted (it reopens tables with inferred types): re-send overrides, re-query. Returns an unsubscribe function. */
  onRestarted(listener: () => void): () => void;
  /** Engine events (background Parquet progress, table updates). Returns an unsubscribe function. */
  onEvent(listener: (event: EngineEvent) => void): () => void;
}

/**
 * The error an engine client rejects with: an `Error` with the engine's
 * `code` (`bad_request`, `superseded`, …) and, for compiler errors, the
 * offending input `path`. The desktop client's `EngineRequestError` has this
 * shape; clients without their own class can use this one.
 */
export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** For `bad_request` from the compiler: the offending input path, e.g. `y.aggregate`. */
    readonly path?: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

const ABANDONED = new Set(['superseded', 'cancelled', 'engine_restarted']);

/**
 * True for errors that only mean "a newer request replaced this one", "you
 * cancelled it" or "the engine restarted" (views re-query). Structural, so it
 * recognises every client's error class by its `code`.
 */
export function isAbandoned(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' && ABANDONED.has(code);
}
