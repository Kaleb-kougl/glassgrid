import type { Table } from 'apache-arrow';
import type {
  AggregateSpecInput,
  CacheScope,
  ColumnTypeOverride,
  ColumnTypeResult,
  CrossfilterDimension,
  CrossfilterHint,
  CubeTarget,
  EngineEvent,
  FileHandle,
  FilterInput,
  Mark,
  ParquetCacheStats,
  ParquetMode,
  PreparedCube,
  ResultCacheStats,
  RowsQuery,
  SortKey,
  TableColumnProfile,
  TableHandle,
  TableId,
} from '@glassgrid/core';

/*
 * The engine client API the app talks to, implemented by the desktop
 * renderer's `EngineClient` (MessagePort brokered by Electron main) and by
 * the web demo's `createWorkerEngine()` (a Web Worker running the same
 * engine on DuckDB-WASM). Shapes match apps/desktop/src/renderer/src/engine-client.ts.
 */

export interface QueryOptions {
  /**
   * Logical consumer of the result (e.g. `grid`, `chart:3`). A newer request
   * for the same view rejects older pending ones with `superseded`, and the
   * engine interrupts them. Omit for one-off requests that must not replace
   * anything.
   */
  viewId?: string;
  /** Aborting sends `cancel` and rejects with `cancelled`. */
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

export interface Timed {
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
  /** Answered from a cross-filter cube (always set by the client; optional so test doubles may omit it). */
  fromCube?: boolean;
}

export interface CountResult extends Timed {
  rowCount: number;
  /** Answered from a cross-filter cube (always set by the client; optional so test doubles may omit it). */
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

export interface ParquetCacheResult {
  table: TableHandle;
  alreadyCached: boolean;
  sizeBytes: number;
  engineMs: number;
}

export interface CacheStats {
  results: ResultCacheStats;
  parquet: ParquetCacheStats;
}

export interface ColumnTypesResult {
  /** The table with its new effective column types and `typeOverrides`. */
  table: TableHandle;
  /** Per requested override: effective type, DuckDB type and values that failed to convert (now NULL). */
  columns: ColumnTypeResult[];
  engineMs: number;
}

export interface PageOptions {
  /** The grid view the page belongs to (default `grid`). Pages of one view do not supersede each other. */
  viewId?: string;
  filters?: readonly FilterInput[];
  /** Aborting rejects with `cancelled`; the engine query is interrupted once no caller wants the page. */
  signal?: AbortSignal;
}

/** What the canvas grid calls per page: `limit` is at most 1,000. */
export type FetchPage = (offset: number, limit: number, signal?: AbortSignal) => Promise<RowsResult>;

/** The engine as the app sees it, on the desktop and on the web. */
export interface EngineClientApi {
  open(file: FileHandle, options?: { parquet?: ParquetMode; signal?: AbortSignal }): Promise<OpenResult>;
  profile(table: TableId, options?: QueryOptions): Promise<ProfileResult>;
  rows(table: TableId, query: RowsQuery, options?: FilteredQueryOptions): Promise<RowsResult>;
  count(table: TableId, options?: FilteredQueryOptions & CrossfilterQueryOptions): Promise<CountResult>;
  fetchPage(table: TableId, query: RowsQuery, options?: PageOptions): Promise<RowsResult>;
  pageFetcher(table: TableId, view?: { viewId?: string; sort?: SortKey[]; filters?: readonly FilterInput[] }): FetchPage;
  setColumnTypes(table: TableId, overrides: readonly ColumnTypeOverride[], options?: { signal?: AbortSignal }): Promise<ColumnTypesResult>;
  aggregate(table: TableId, spec: AggregateSpecInput, options?: QueryOptions & CrossfilterQueryOptions): Promise<AggregateResult>;
  prepareCrossfilter(
    table: TableId,
    plan: { dimension: CrossfilterDimension; targets: readonly CubeTarget[] },
    options?: QueryOptions,
  ): Promise<PrepareCrossfilterResult>;
  ensureParquetCache(table: TableId): Promise<ParquetCacheResult>;
  closeTable(table: TableId): Promise<void>;
  clearCache(scope?: CacheScope): Promise<void>;
  cacheStats(): Promise<CacheStats>;
  cancel(requestId: string): void;
  /** Id of the request most recently issued by any method. */
  readonly lastRequestId: string;
  /** The engine restarted (new port or worker); re-send type overrides and re-query. Returns an unsubscribe function. */
  onRestarted(listener: () => void): () => void;
  /** Engine events (Parquet progress, table updates). Returns an unsubscribe function. */
  onEvent(listener: (event: EngineEvent) => void): () => void;
  dispose(): void;
}
