import { z } from 'zod';
import { FingerprintSchema } from '../protocol/engine.js';

/*
 * The parts of a `.glassgrid` file outside the workspace block, shared by
 * every format version (format.ts holds the current file schema,
 * migrations.ts the old ones).
 */

/**
 * How a workspace finds its data again: the absolute path when saved, the
 * path relative to the workspace file (forward slashes; null when there is
 * no relative path, e.g. another drive on Windows or an untitled recovery
 * snapshot) and the engine fingerprint (size, mtime, SHA-256 of the first
 * and last 1 MB). Opening tries the relative path, then the absolute one,
 * then asks the person, and warns when the fingerprint differs.
 */
export const DataReferenceSchema = z.strictObject({
  /** Display name of the data file, e.g. `sales.csv`. A relinked file must have this name. */
  fileName: z.string().min(1).max(1024),
  absolutePath: z.string().min(1).max(32_768),
  relativePath: z.string().min(1).max(32_768).nullable(),
  fingerprint: FingerprintSchema,
});
export type DataReference = z.infer<typeof DataReferenceSchema>;

export const AppInfoSchema = z.strictObject({
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

/**
 * Present only in crash-recovery snapshots (`<userData>/recovery/`): which
 * workspace file the snapshot is unsaved work for. Never in a file the person saves.
 */
export const RecoveryOfSchema = z.strictObject({
  /** The workspace file the window had open, or null for an untitled workspace. */
  workspacePath: z.string().min(1).max(32_768).nullable(),
});
export type RecoveryOf = z.infer<typeof RecoveryOfSchema>;
