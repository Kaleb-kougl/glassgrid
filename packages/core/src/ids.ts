import { z } from 'zod';

/**
 * Opaque identifier for a data source the engine knows about.
 *
 * The renderer only ever holds handles; the filesystem path behind a handle
 * lives in the main process and the engine. Handles are branded so a random
 * string cannot be passed where a handle is expected.
 */
export const FileHandleSchema = z
  .string()
  .regex(/^fh_[A-Za-z0-9-]{8,64}$/, 'Invalid file handle')
  .brand<'FileHandle'>();
export type FileHandle = z.infer<typeof FileHandleSchema>;

/** Correlates a request with its response across a MessagePort. */
export const RequestIdSchema = z.string().min(1).max(128);
export type RequestId = z.infer<typeof RequestIdSchema>;

export function toFileHandle(uuid: string): FileHandle {
  return FileHandleSchema.parse(`fh_${uuid}`);
}
