import { z } from 'zod';
import { FileHandleSchema, RequestIdSchema, type FileHandle } from '../ids.js';
import { ChartSpecSchema, MarkSchema } from '../spec/chart.js';
import { ColumnProfileSchema, ColumnTypeSchema } from '../spec/column.js';
import { FilterSchema } from '../spec/filter.js';
import { SortKeySchema } from '../spec/rows.js';
import { MAX_PIXEL_WIDTH } from '../sql/chart.js';

/*
 * Renderer <-> engine protocol.
 *
 * These messages travel over a dedicated MessagePort that connects the
 * renderer directly to the engine (an Electron utility process). Main never
 * sees query traffic. Every message is validated on receipt because both ends
 * treat the other as untrusted input.
 *
 * No message carries SQL text or a filesystem path. Grid and chart requests
 * are typed objects (filters and chart specs from spec/); the engine compiles
 * them with the core SQL compiler (quoted identifiers, bound values). See
 * docs/m1-engine-notes.md and docs/m1-notes.md for the full contract.
 */

// ---------------------------------------------------------------------------
// Identifiers

/**
 * Opaque id of an opened table. It is derived from the FileHandle, so a
 * respawned engine can reopen the table on demand from main's replayed file
 * registrations and the renderer's ids stay valid across engine restarts.
 */
export const TableIdSchema = z
  .string()
  .regex(/^tb_[A-Za-z0-9-]{8,64}$/, 'Invalid table id')
  .brand<'TableId'>();
export type TableId = z.infer<typeof TableIdSchema>;

export function tableIdForFile(handle: FileHandle): TableId {
  return TableIdSchema.parse(`tb_${handle.slice('fh_'.length)}`);
}

/**
 * Names one logical consumer of results (the grid, a chart card, the
 * profile panel). A newer request for the same view supersedes older ones.
 */
export const QueryViewIdSchema = z.string().min(1).max(128);
export type QueryViewId = z.infer<typeof QueryViewIdSchema>;

/** Monotonically increasing per view, assigned by the client. */
export const SeqSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Shared value types

export const ColumnInfoSchema = z.object({
  name: z.string(),
  type: ColumnTypeSchema,
  /** DuckDB's own type name, e.g. `BIGINT`, `DECIMAL(18,3)`, `TIMESTAMP WITH TIME ZONE`. */
  duckdbType: z.string(),
});
export type ColumnInfo = z.infer<typeof ColumnInfoSchema>;

/**
 * Identifies the content of a file without reading all of it: size, mtime
 * and a SHA-256 over the first and last 1 MB. `key` is a stable digest of
 * those three values and names the Parquet cache entry.
 */
export const FingerprintSchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
  mtimeMs: z.number().int().nonnegative(),
  headTailSha256: z.string().regex(/^[0-9a-f]{64}$/),
  key: z.string().regex(/^[0-9a-f]{32}$/),
});
export type Fingerprint = z.infer<typeof FingerprintSchema>;

export const TableHandleSchema = z.object({
  id: TableIdSchema,
  file: FileHandleSchema,
  fileName: z.string(),
  /** Known when cheap (Parquet metadata) or once counted; absent otherwise. */
  rowCount: z.number().int().nonnegative().optional(),
  fingerprint: FingerprintSchema,
  /** True once queries read the cached Parquet copy instead of the CSV. */
  usingParquetCache: z.boolean(),
  columns: z.array(ColumnInfoSchema),
});
export type TableHandle = z.infer<typeof TableHandleSchema>;

/**
 * A column's profile as the engine reports it: the compiler's
 * `ColumnProfile` (name, logical type, null fraction, distinct count, min,
 * max) plus DuckDB's own type name. `distinctCount` is a HyperLogLog
 * estimate (`approx_count_distinct`), NULLs excluded.
 */
export const TableColumnProfileSchema = ColumnProfileSchema.extend({
  duckdbType: z.string(),
});
export type TableColumnProfile = z.infer<typeof TableColumnProfileSchema>;

export const MAX_PAGE_ROWS = 1000;

export const RowsQuerySchema = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(MAX_PAGE_ROWS),
  /** Lexicographic sort keys, NULLs last; ties always fall back to file order. */
  sort: z.array(SortKeySchema).max(16).optional(),
});
export type RowsQuery = z.infer<typeof RowsQuerySchema>;

/** Filters on a rows or count request (AND-combined; see spec/filter.ts). */
export const MAX_REQUEST_FILTERS = 256;
export const RequestFiltersSchema = z.array(FilterSchema).max(MAX_REQUEST_FILTERS);

/**
 * What an aggregate request carries: a chart spec plus the plot width in
 * device pixels, which bounds line/area results via M4 (see sql/chart.ts).
 */
export const AggregateSpecSchema = ChartSpecSchema.extend({
  pixelWidth: z.number().int().min(1).max(MAX_PIXEL_WIDTH).optional(),
});
export type AggregateSpec = z.infer<typeof AggregateSpecSchema>;
export type AggregateSpecInput = z.input<typeof AggregateSpecSchema>;

/** `auto` converts in the background when the CSV exceeds the engine's size threshold. */
export const ParquetModeSchema = z.enum(['auto', 'always', 'never']);
export type ParquetMode = z.infer<typeof ParquetModeSchema>;

export const CacheScopeSchema = z.enum(['all', 'results', 'parquet']);
export type CacheScope = z.infer<typeof CacheScopeSchema>;

// ---------------------------------------------------------------------------
// Requests

const QueryBase = {
  requestId: RequestIdSchema,
  viewId: QueryViewIdSchema,
  seq: SeqSchema,
  table: TableIdSchema,
};

export const OpenRequestSchema = z.object({
  kind: z.literal('open'),
  requestId: RequestIdSchema,
  file: FileHandleSchema,
  parquet: ParquetModeSchema.optional(),
});

export const ProfileRequestSchema = z.object({ kind: z.literal('profile'), ...QueryBase });

export const RowsRequestSchema = z.object({
  kind: z.literal('rows'),
  ...QueryBase,
  query: RowsQuerySchema,
  /** Only rows matching every filter; compiled with `compileWhere`. */
  filters: RequestFiltersSchema.optional(),
});

export const CountRequestSchema = z.object({
  kind: z.literal('count'),
  ...QueryBase,
  /** Count only rows matching every filter; compiled with `compileWhere`. */
  filters: RequestFiltersSchema.optional(),
});

/**
 * Chart aggregate. The engine compiles the spec with `compileChartQuery`
 * against the table's profile and answers `aggregate` (Arrow IPC). A scatter
 * spec with more points than `scatterPointLimit(spec)` is answered as its
 * `scatterAsHeatmap(spec)` fallback, flagged with `fellBackToHeatmap`.
 */
export const AggregateRequestSchema = z.object({
  kind: z.literal('aggregate'),
  ...QueryBase,
  spec: AggregateSpecSchema,
});

export const CancelRequestSchema = z.object({
  kind: z.literal('cancel'),
  requestId: RequestIdSchema,
  /** The request to cancel. It is answered with a `cancelled` error. */
  target: RequestIdSchema,
});

export const EnsureParquetCacheRequestSchema = z.object({
  kind: z.literal('ensureParquetCache'),
  requestId: RequestIdSchema,
  table: TableIdSchema,
});

export const ClearCacheRequestSchema = z.object({
  kind: z.literal('clearCache'),
  requestId: RequestIdSchema,
  scope: CacheScopeSchema.optional(),
});

export const CacheStatsRequestSchema = z.object({
  kind: z.literal('cacheStats'),
  requestId: RequestIdSchema,
});

export const EngineRequestSchema = z.discriminatedUnion('kind', [
  OpenRequestSchema,
  ProfileRequestSchema,
  RowsRequestSchema,
  CountRequestSchema,
  AggregateRequestSchema,
  CancelRequestSchema,
  EnsureParquetCacheRequestSchema,
  ClearCacheRequestSchema,
  CacheStatsRequestSchema,
]);
export type EngineRequest = z.infer<typeof EngineRequestSchema>;
export type OpenRequest = z.infer<typeof OpenRequestSchema>;
export type ProfileRequest = z.infer<typeof ProfileRequestSchema>;
export type RowsRequest = z.infer<typeof RowsRequestSchema>;
export type CountRequest = z.infer<typeof CountRequestSchema>;
export type AggregateRequest = z.infer<typeof AggregateRequestSchema>;
export type CancelRequest = z.infer<typeof CancelRequestSchema>;
export type EnsureParquetCacheRequest = z.infer<typeof EnsureParquetCacheRequestSchema>;
export type ClearCacheRequest = z.infer<typeof ClearCacheRequestSchema>;
export type CacheStatsRequest = z.infer<typeof CacheStatsRequestSchema>;

/** Requests subject to per-view ordering and superseding. */
export type ViewScopedRequest = ProfileRequest | RowsRequest | CountRequest | AggregateRequest;

export function isViewScopedRequest(request: EngineRequest): request is ViewScopedRequest {
  return (
    request.kind === 'profile' || request.kind === 'rows' || request.kind === 'count' || request.kind === 'aggregate'
  );
}

// ---------------------------------------------------------------------------
// Responses

export const EngineErrorCodeSchema = z.enum([
  'bad_request',
  'unknown_handle',
  'unknown_table',
  'unknown_column',
  'query_failed',
  'io_failed',
  'engine_unavailable',
  /** Cancelled explicitly with a `cancel` request. */
  'cancelled',
  /** A newer request for the same view replaced this one. */
  'superseded',
  'not_implemented',
]);
export type EngineErrorCode = z.infer<typeof EngineErrorCodeSchema>;

const Timing = {
  /** Wall time spent inside the engine, excluding transport. */
  engineMs: z.number().nonnegative(),
};
const Cached = {
  /** Served from the engine's result cache without touching DuckDB. */
  cached: z.boolean(),
};

const ipcBytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'Expected Arrow IPC bytes');

/** A tabular result encoded as an Apache Arrow IPC stream. */
export const ArrowResultSchema = z.object({
  kind: z.literal('arrow'),
  requestId: RequestIdSchema,
  /** Arrow IPC stream bytes (schema message + record batches + EOS). */
  ipc: ipcBytes,
  ...Timing,
  ...Cached,
});

/** A chart aggregate: Arrow IPC plus the mark the rows are shaped for. */
export const AggregateResultSchema = z.object({
  kind: z.literal('aggregate'),
  requestId: RequestIdSchema,
  ipc: ipcBytes,
  /** The mark of the returned rows; `heatmap` when a scatter fell back. */
  mark: MarkSchema,
  /** True when a scatter spec had too many points and a heatmap was returned instead. */
  fellBackToHeatmap: z.boolean(),
  ...Timing,
  ...Cached,
});

export const OpenedResultSchema = z.object({
  kind: z.literal('opened'),
  requestId: RequestIdSchema,
  table: TableHandleSchema,
  ...Timing,
});

export const ProfileResultSchema = z.object({
  kind: z.literal('profile'),
  requestId: RequestIdSchema,
  rowCount: z.number().int().nonnegative(),
  columns: z.array(TableColumnProfileSchema),
  ...Timing,
  ...Cached,
});

export const CountResultSchema = z.object({
  kind: z.literal('count'),
  requestId: RequestIdSchema,
  rowCount: z.number().int().nonnegative(),
  ...Timing,
  ...Cached,
});

export const ParquetCacheResultSchema = z.object({
  kind: z.literal('parquetCache'),
  requestId: RequestIdSchema,
  table: TableHandleSchema,
  /** True when a cached copy already existed and no conversion ran. */
  alreadyCached: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
  ...Timing,
});

export const ResultCacheStatsSchema = z.object({
  entries: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  maxBytes: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  evictions: z.number().int().nonnegative(),
});
export type ResultCacheStats = z.infer<typeof ResultCacheStatsSchema>;

export const ParquetCacheStatsSchema = z.object({
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  maxBytes: z.number().int().nonnegative(),
});
export type ParquetCacheStats = z.infer<typeof ParquetCacheStatsSchema>;

export const CacheStatsResultSchema = z.object({
  kind: z.literal('cacheStats'),
  requestId: RequestIdSchema,
  results: ResultCacheStatsSchema,
  parquet: ParquetCacheStatsSchema,
});

export const AckResultSchema = z.object({
  kind: z.literal('ack'),
  requestId: RequestIdSchema,
});

export const EngineErrorSchema = z.object({
  kind: z.literal('error'),
  requestId: RequestIdSchema.nullable(),
  code: EngineErrorCodeSchema,
  message: z.string(),
  /** For `bad_request` from the compiler: dotted path of the offending input, e.g. `y.aggregate`. */
  path: z.string().optional(),
});

/** Unsolicited notifications, broadcast to every connected renderer. */
export const EngineEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('parquetProgress'),
    table: TableIdSchema,
    /** 0..1, or null while DuckDB cannot estimate yet. */
    fraction: z.number().min(0).max(1).nullable(),
  }),
  z.object({
    type: z.literal('parquetReady'),
    table: TableHandleSchema,
    sizeBytes: z.number().int().nonnegative(),
    ...Timing,
  }),
  z.object({
    type: z.literal('parquetFailed'),
    table: TableIdSchema,
    code: EngineErrorCodeSchema,
    message: z.string(),
  }),
  /** The table's source changed (e.g. the cache was cleared and it reads the CSV again). */
  z.object({
    type: z.literal('tableUpdated'),
    table: TableHandleSchema,
  }),
]);
export type EngineEvent = z.infer<typeof EngineEventSchema>;

export const EngineEventMessageSchema = z.object({
  kind: z.literal('event'),
  event: EngineEventSchema,
});

export const EngineResponseSchema = z.discriminatedUnion('kind', [
  ArrowResultSchema,
  AggregateResultSchema,
  OpenedResultSchema,
  ProfileResultSchema,
  CountResultSchema,
  ParquetCacheResultSchema,
  CacheStatsResultSchema,
  AckResultSchema,
  EngineErrorSchema,
  EngineEventMessageSchema,
]);
export type EngineResponse = z.infer<typeof EngineResponseSchema>;
export type ArrowResult = z.infer<typeof ArrowResultSchema>;
export type AggregateResult = z.infer<typeof AggregateResultSchema>;
export type OpenedResult = z.infer<typeof OpenedResultSchema>;
export type ProfileResult = z.infer<typeof ProfileResultSchema>;
export type CountResult = z.infer<typeof CountResultSchema>;
export type ParquetCacheResult = z.infer<typeof ParquetCacheResultSchema>;
export type CacheStatsResult = z.infer<typeof CacheStatsResultSchema>;
export type AckResult = z.infer<typeof AckResultSchema>;
export type EngineError = z.infer<typeof EngineErrorSchema>;
export type EngineEventMessage = z.infer<typeof EngineEventMessageSchema>;

/** Responses that answer a specific request (everything except events). */
export type EngineReply = Exclude<EngineResponse, EngineEventMessage>;
