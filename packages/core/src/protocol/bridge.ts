import { z } from 'zod';
import { FileHandleSchema } from '../ids.js';

/*
 * Payload schemas for the renderer <-> main bridge. Channel names and the
 * bridge interface live in ./ipc.ts.
 */

/** What the renderer learns about an opened file. Never includes a path. */
export const OpenedFileSchema = z.object({
  handle: FileHandleSchema,
  displayName: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});
export type OpenedFile = z.infer<typeof OpenedFileSchema>;

export const OpenCsvResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('opened'), file: OpenedFileSchema }),
  z.object({ status: z.literal('cancelled') }),
  z.object({ status: z.literal('failed'), message: z.string() }),
]);
export type OpenCsvResult = z.infer<typeof OpenCsvResultSchema>;
