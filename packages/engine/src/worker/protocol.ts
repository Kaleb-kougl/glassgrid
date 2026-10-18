import { z } from 'zod';
import { FileHandleSchema, RequestIdSchema } from '@glassgrid/core';

/*
 * Control messages between the page and the engine worker, next to the
 * engine protocol (packages/core/src/protocol/engine.ts) on the same
 * channel. They play the role of Electron main's control plane: starting
 * the engine and registering data sources. Kinds start with `gg:` so they
 * never collide with engine requests or responses.
 */

export const WorkerInitSchema = z.object({
  kind: z.literal('gg:init'),
  /** URLs of DuckDB-WASM's builds (`duckdb-eh.wasm`, `duckdb-mvp.wasm`). */
  bundles: z.object({ eh: z.string().min(1), mvp: z.string().min(1) }),
  /** DuckDB memory limit for the whole worker. */
  memoryLimitBytes: z.number().int().positive().optional(),
  /**
   * Where DuckDB-WASM loads extensions from (`custom_extension_repository`),
   * normally `<app origin>/duckdb-extensions`. Parquet needs it: without a
   * reachable `parquet` extension the engine reads CSV only.
   */
  extensionRepository: z.string().min(1).optional(),
  /** Extensions to load before the configuration is locked. Default `['parquet']` when a repository is set. */
  extensions: z.array(z.string().regex(/^[a-z_]+$/)).max(8).optional(),
  /** Origins sample datasets may be fetched from. Default: the worker's own origin. */
  allowedOrigins: z.array(z.url()).max(16).optional(),
  /** Largest file the web demo accepts. Default 1 GB (see the design doc's risk table). */
  maxSourceBytes: z.number().int().positive().optional(),
  /** CSVs at least this large convert to Parquet in the background at open (default 64 MB in the browser). */
  autoConvertMinBytes: z.number().int().nonnegative().optional(),
  /** LRU cap of the OPFS Parquet cache. Default 2 GB. */
  parquetCacheMaxBytes: z.number().int().positive().optional(),
});
export type WorkerInit = z.infer<typeof WorkerInitSchema>;

export const SourceSchema = z.discriminatedUnion('kind', [
  /** A file the person picked or dropped (read in place through FileReaderSync, never copied). */
  z.object({ kind: z.literal('file'), file: z.custom<File>((value) => typeof File !== 'undefined' && value instanceof File, 'Expected a File') }),
  /** A sample dataset on an allowed origin, read with HTTP range requests. */
  z.object({ kind: z.literal('url'), url: z.url(), name: z.string().min(1).max(255).optional() }),
]);
export type Source = z.infer<typeof SourceSchema>;

export const RegisterSourceSchema = z.object({
  kind: z.literal('gg:registerSource'),
  requestId: RequestIdSchema,
  handle: FileHandleSchema,
  source: SourceSchema,
});
export type RegisterSource = z.infer<typeof RegisterSourceSchema>;

/**
 * Diagnostics: exercise the OPFS cache machinery the Parquet cache relies on
 * (DuckDB writing a `.partial` file through a sync access handle, the rename,
 * reading it back, listing) with CSV, so it is testable where the Parquet
 * extension is not available. Runs fixed SQL only. `write` leaves the file
 * for a later worker's `read` (persistence across reloads); `clean` removes it.
 */
export const CacheSelfTestSchema = z.object({
  kind: z.literal('gg:cacheSelfTest'),
  requestId: RequestIdSchema,
  mode: z.enum(['write', 'read', 'clean']),
});

export const WorkerControlSchema = z.discriminatedUnion('kind', [WorkerInitSchema, RegisterSourceSchema, CacheSelfTestSchema]);
export type WorkerControl = z.infer<typeof WorkerControlSchema>;

export interface WorkerCapabilities {
  interrupt: 'immediate' | 'cooperative';
  progress: boolean;
  parquet: boolean;
  /** Where the Parquet cache lives: `opfs` (persists across reloads), or `none` without OPFS (no CSV-to-Parquet copies). */
  cache: 'opfs' | 'none';
  crossOriginIsolated: boolean;
}

export type WorkerReply =
  | { kind: 'gg:ready'; duckdbVersion: string; capabilities: WorkerCapabilities; extensionErrors: string[] }
  | { kind: 'gg:fatal'; message: string }
  | { kind: 'gg:sourceRegistered'; requestId: string; handle: string; fileName: string; sizeBytes: number }
  | { kind: 'gg:registerFailed'; requestId: string; code: 'too_large' | 'not_allowed' | 'io_failed'; message: string }
  | { kind: 'gg:cacheSelfTest'; requestId: string; ok: boolean; detail: Record<string, unknown> };

/** A `gg:` control message (either direction), as opposed to an engine request or response. */
export function isControlMessage(value: unknown): value is { kind: `gg:${string}` } {
  return typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'string' && value.kind.startsWith('gg:');
}
