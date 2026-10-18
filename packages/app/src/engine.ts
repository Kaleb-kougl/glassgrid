import type { EngineClientApi } from '@glassgrid/engine/client';

/*
 * The engine as the app sees it. The interface and its result types are the
 * engine package's `EngineClientApi` (`@glassgrid/engine/client`, the
 * browser-safe entry: types only, no driver), implemented by the desktop
 * `EngineClient` (a MessagePort to DuckDB in Electron's utility process), the
 * web demo's `createWorkerEngine()` (DuckDB-WASM in a Web Worker), the web
 * stub engine and the app's test doubles. Nothing here depends on the
 * transport.
 *
 * App code that needs only a few methods takes a `Pick<EngineClientLike, …>`,
 * so test doubles stay small.
 */

export type {
  AggregateResult,
  CacheStats,
  ColumnTypesResult,
  CountResult,
  CrossfilterQueryOptions,
  EngineClientApi,
  FetchPage,
  FilteredQueryOptions,
  OpenResult,
  PageOptions,
  ParquetCacheResult,
  PrepareCrossfilterResult,
  ProfileResult,
  QueryOptions,
  RowsResult,
  Timed,
} from '@glassgrid/engine/client';

/** The engine client every shell hands the app (`Platform.engine`): the engine package's `EngineClientApi`. */
export type EngineClientLike = EngineClientApi;

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
