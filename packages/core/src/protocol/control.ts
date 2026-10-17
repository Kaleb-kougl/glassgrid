import { z } from 'zod';
import { FileHandleSchema, RequestIdSchema } from '../ids.js';

/*
 * Main <-> engine control protocol (Electron parentPort).
 *
 * Only main may register data sources. It resolves a user-chosen path to a
 * handle and tells the engine about the mapping; the renderer then refers to
 * the source by handle alone.
 */

/**
 * Engine settings chosen by main and passed to the utility process at spawn
 * time (as one JSON argument after ENGINE_CONFIG_ARG), so they are available
 * synchronously and survive respawns unchanged.
 */
export const EngineConfigSchema = z.object({
  /** Parquet cache folder, e.g. `<userData>/cache/parquet`. Created on demand. */
  cacheDir: z.string().min(1),
  /** LRU size cap of the Parquet cache. Default 20 GB. */
  parquetCacheMaxBytes: z.number().int().positive().optional(),
  /** `open` with `parquet: 'auto'` converts CSVs at least this large. Default 200 MB. */
  autoConvertMinBytes: z.number().int().nonnegative().optional(),
  /** Result cache cap in Arrow bytes. Default 256 MB. */
  resultCacheMaxBytes: z.number().int().nonnegative().optional(),
  /** DuckDB spill folder. Defaults to a `duckdb-tmp` sibling of cacheDir. */
  tempDir: z.string().min(1).optional(),
});
export type EngineConfig = z.infer<typeof EngineConfigSchema>;

export const ENGINE_CONFIG_ARG = '--glassgrid-engine-config';

export const AttachPortMessageSchema = z.object({
  kind: z.literal('attachPort'),
});

export const RegisterFileMessageSchema = z.object({
  kind: z.literal('registerFile'),
  requestId: RequestIdSchema,
  handle: FileHandleSchema,
  path: z.string().min(1),
});

export const ControlMessageSchema = z.discriminatedUnion('kind', [
  AttachPortMessageSchema,
  RegisterFileMessageSchema,
]);
export type ControlMessage = z.infer<typeof ControlMessageSchema>;
export type RegisterFileMessage = z.infer<typeof RegisterFileMessageSchema>;

export const ControlReplySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ready'),
    duckdbVersion: z.string(),
  }),
  z.object({
    kind: z.literal('fileRegistered'),
    requestId: RequestIdSchema,
    handle: FileHandleSchema,
    sizeBytes: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('registerFailed'),
    requestId: RequestIdSchema,
    message: z.string(),
  }),
  z.object({
    kind: z.literal('fatal'),
    message: z.string(),
  }),
]);
export type ControlReply = z.infer<typeof ControlReplySchema>;
