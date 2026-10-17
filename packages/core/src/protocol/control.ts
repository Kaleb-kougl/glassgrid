import { z } from 'zod';
import { FileHandleSchema, RequestIdSchema } from '../ids.js';

/*
 * Main <-> engine control protocol (Electron parentPort).
 *
 * Only main may register data sources. It resolves a user-chosen path to a
 * handle and tells the engine about the mapping; the renderer then refers to
 * the source by handle alone.
 */

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
