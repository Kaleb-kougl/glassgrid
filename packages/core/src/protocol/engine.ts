import { z } from 'zod';
import { FileHandleSchema, RequestIdSchema } from '../ids.js';

/*
 * Renderer <-> engine protocol.
 *
 * These messages travel over a dedicated MessagePort that connects the
 * renderer directly to the engine (an Electron utility process). Main never
 * sees query traffic. Every message is validated on receipt because both ends
 * treat the other as untrusted input.
 */

export const CountRowsRequestSchema = z.object({
  kind: z.literal('countRows'),
  requestId: RequestIdSchema,
  handle: FileHandleSchema,
});

export const EngineRequestSchema = z.discriminatedUnion('kind', [CountRowsRequestSchema]);
export type EngineRequest = z.infer<typeof EngineRequestSchema>;
export type CountRowsRequest = z.infer<typeof CountRowsRequestSchema>;

export const EngineErrorCodeSchema = z.enum([
  'bad_request',
  'unknown_handle',
  'query_failed',
  'engine_unavailable',
]);
export type EngineErrorCode = z.infer<typeof EngineErrorCodeSchema>;

/** A tabular result encoded as an Apache Arrow IPC stream. */
export const ArrowResultSchema = z.object({
  kind: z.literal('arrow'),
  requestId: RequestIdSchema,
  /** Arrow IPC stream bytes (schema message + record batches + EOS). */
  ipc: z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'Expected Arrow IPC bytes'),
  /** Wall time spent inside the engine, excluding transport. */
  engineMs: z.number().nonnegative(),
});

export const EngineErrorSchema = z.object({
  kind: z.literal('error'),
  requestId: RequestIdSchema.nullable(),
  code: EngineErrorCodeSchema,
  message: z.string(),
});

export const EngineResponseSchema = z.discriminatedUnion('kind', [
  ArrowResultSchema,
  EngineErrorSchema,
]);
export type EngineResponse = z.infer<typeof EngineResponseSchema>;
export type ArrowResult = z.infer<typeof ArrowResultSchema>;
export type EngineError = z.infer<typeof EngineErrorSchema>;
