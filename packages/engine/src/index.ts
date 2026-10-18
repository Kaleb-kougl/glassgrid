/*
 * @glassgrid/engine: the query engine shared by the desktop app (native
 * DuckDB in Electron's utility process) and the web demo (DuckDB-WASM in a
 * Web Worker). This entry is runtime-neutral: no Node, no DOM, no DuckDB
 * binding. Drivers live in `@glassgrid/engine/native` and
 * `@glassgrid/engine/wasm`; see docs/m4-engine-portability.md.
 */
export * from './driver';
export { Coalescer } from './coalesce';
export { CubeStore, MAX_CUBE_ESTIMATE, MAX_CUBE_ROWS, MAX_CUBES, MAX_CUBE_TOTAL_ROWS, type CubeRef, type CubeStoreStats } from './cubes';
export { OVERRIDE_DECIMAL_TYPE, overrideDuckdbType, simpleColumnType, toCount, toScalar } from './column-types';
export { EngineFailure, abortCode, errorMessage, isInterruptError, raceAbort, throwIfAborted, toEngineFailure } from './errors';
export { Emitter } from './emitter';
export { FINGERPRINT_EDGE_BYTES, PARQUET_FORMAT_VERSION, fingerprintFile, sameFingerprint } from './fingerprint';
export { sha256Bytes, sha256Hex } from './hash';
export { DEFAULT_PARQUET_CACHE_BYTES, ParquetCache, type CacheEntry } from './parquet-cache';
export {
  DEEP_PAGE_ROWS,
  DEFAULT_AUTO_CONVERT_MIN_BYTES,
  FILTERED_INDEX_DELAY_MS,
  PARQUET_COMPRESSION,
  QueryService,
  TOP_K_MAX_ROWS,
  type Cached,
  type ColumnTypesOutcome,
  type InputFormat,
  type PagingStrategy,
  type ParquetCacheOutcome,
  type QueryServiceOptions,
  type RequestContext,
  type RowsOptions,
  type TableProfile,
} from './query-service';
export { DEFAULT_RESULT_CACHE_BYTES, ResultCache } from './result-cache';
export {
  EngineSession,
  prepareCrossfilter,
  runAggregate,
  runCount,
  toFragment,
  type AggregateOutcome,
} from './session';
export { DEFAULT_MAX_SORT_INDEXES, SortIndexes, type BuildSpec } from './sort-indexes';
export { fragmentKey, intLiteral, quoteIdent, quoteLiteral, type SqlFragment, type SqlParam } from './sql-text';
