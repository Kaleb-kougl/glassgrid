import { z } from 'zod';
import { DocumentIdSchema } from '../state/workspace.js';
import { WorkspaceFileErrorCodeSchema } from '../workspace-file/errors.js';
import { PersistedWorkspaceSchema, WorkspaceSnapshotSchema, WorkspaceWarningSchema } from '../workspace-file/persisted.js';
import { OpenedFileSchema } from './bridge.js';

/*
 * Payloads of the workspace-file bridge (renderer <-> main). Main parses
 * every request with these schemas; the renderer may parse every result.
 * Paths never cross: the renderer gets the workspace file's display name and
 * folder (for the title bar and the recent list) and a data handle, and
 * names documents, recent entries and pending opens by opaque ids.
 */

/** Opaque id of a recent-workspaces entry (derived from its path in main). */
export const RecentWorkspaceIdSchema = z.string().regex(/^rw_[0-9a-f]{24}$/, 'Invalid recent workspace id');
/** Opaque single-use token for a pending open (a file from the OS, or one whose data must be located). */
export const OpenTokenSchema = z.string().regex(/^ot_[A-Za-z0-9-]{8,64}$/, 'Invalid open token');
/** Id of a crash-recovery snapshot. */
export const RecoveryIdSchema = z.string().regex(/^rs_[A-Za-z0-9-]{8,64}$/, 'Invalid recovery id');

/** What the renderer may show about a workspace file: its name and the folder it is in. */
export const WorkspaceFileInfoSchema = z.strictObject({
  fileName: z.string().min(1),
  directory: z.string(),
});
export type WorkspaceFileInfo = z.infer<typeof WorkspaceFileInfoSchema>;

export const SaveWorkspaceRequestSchema = z.strictObject({
  /** The document the workspace belongs to (state.document.id); null or unknown saves as a new file. */
  documentId: DocumentIdSchema.nullable(),
  snapshot: WorkspaceSnapshotSchema,
});
export type SaveWorkspaceRequest = z.infer<typeof SaveWorkspaceRequestSchema>;

export const SaveWorkspaceResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('saved'), documentId: DocumentIdSchema, workspaceFile: WorkspaceFileInfoSchema }),
  z.strictObject({ status: z.literal('cancelled') }),
  z.strictObject({ status: z.literal('failed'), message: z.string() }),
]);
export type SaveWorkspaceResult = z.infer<typeof SaveWorkspaceResultSchema>;

/**
 * Where to open a workspace from. `dialog`: main's native open dialog.
 * `recent`: an entry of the recent list. `external`: a file the OS handed
 * the app (double-click, "Open with", macOS `open-file`, a second launch's
 * argv), announced to the renderer with `onOpenRequest`.
 */
export const OpenWorkspaceRequestSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('dialog') }),
  z.strictObject({ source: z.literal('recent'), id: RecentWorkspaceIdSchema }),
  z.strictObject({ source: z.literal('external'), token: OpenTokenSchema }),
]);
export type OpenWorkspaceRequest = z.infer<typeof OpenWorkspaceRequestSchema>;

const Difference = <T extends z.ZodType>(value: T) => z.strictObject({ expected: value, actual: value }).nullable();

/**
 * How the data file found on open differs from the fingerprint saved in the
 * workspace. Any difference means the data changed (or is another file);
 * the workspace still opens, and the UI should say so.
 */
export const FingerprintMismatchSchema = z.strictObject({
  sizeBytes: Difference(z.number().int().nonnegative()),
  mtimeMs: Difference(z.number().int().nonnegative()),
  /** The SHA-256 of the first and last 1 MB differs. */
  contentChanged: z.boolean(),
});
export type FingerprintMismatch = z.infer<typeof FingerprintMismatchSchema>;

/** How the data file was found: next to the workspace (relative path), at its saved absolute path, or picked by the person. */
export const DataFoundBySchema = z.enum(['relative', 'absolute', 'located']);
export type DataFoundBy = z.infer<typeof DataFoundBySchema>;

export const OpenWorkspaceFailureCodeSchema = z.union([
  WorkspaceFileErrorCodeSchema,
  z.enum([
    /** The workspace file could not be read (missing, permissions, too large). */
    'io',
    /** A recent entry, token or recovery snapshot that no longer exists. */
    'not_found',
    /** The data file was found but the engine could not open it. */
    'data_unreadable',
  ]),
]);
export type OpenWorkspaceFailureCode = z.infer<typeof OpenWorkspaceFailureCodeSchema>;

export const OpenWorkspaceResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('opened'),
    /** Main's id for the workspace file; null for a restored untitled workspace. */
    documentId: DocumentIdSchema.nullable(),
    workspaceFile: WorkspaceFileInfoSchema.nullable(),
    /** The data file, registered with the engine exactly like an opened CSV. */
    file: OpenedFileSchema,
    dataFoundBy: DataFoundBySchema,
    /** Null when the data matches the saved fingerprint. */
    fingerprintMismatch: FingerprintMismatchSchema.nullable(),
    /** The saved workspace (migrated to the current format), to restore with `loadWorkspace`. */
    workspace: PersistedWorkspaceSchema,
    warnings: z.array(WorkspaceWarningSchema),
    migratedFrom: z.number().int().nonnegative().nullable(),
    /** Set when this is a crash-recovery snapshot: the workspace is unsaved work. */
    recovered: z.strictObject({ id: RecoveryIdSchema, savedAt: z.string() }).nullable(),
    /**
     * With a fingerprint mismatch: a pending open the person can finish with
     * `locateData` (pick the right data file; the workspace is restored over
     * it) or forget with `cancelOpen`. Absent when the data matched.
     */
    relinkToken: OpenTokenSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('needsData'),
    /** Pass to `locateData` (after the person agrees to look for the file) or `cancelOpen`. */
    token: OpenTokenSchema,
    workspaceFile: WorkspaceFileInfoSchema.nullable(),
    /** The data file's name, for "Locate sales.csv…". */
    dataFileName: z.string(),
    warnings: z.array(WorkspaceWarningSchema),
  }),
  z.strictObject({ status: z.literal('cancelled') }),
  z.strictObject({ status: z.literal('failed'), code: OpenWorkspaceFailureCodeSchema, message: z.string() }),
]);
export type OpenWorkspaceResult = z.infer<typeof OpenWorkspaceResultSchema>;

export const RecentWorkspaceSchema = z.strictObject({
  id: RecentWorkspaceIdSchema,
  fileName: z.string(),
  directory: z.string(),
  /** ISO 8601. */
  lastOpenedAt: z.string(),
});
export type RecentWorkspace = z.infer<typeof RecentWorkspaceSchema>;

export const RecoverySnapshotInfoSchema = z.strictObject({
  id: RecoveryIdSchema,
  /** The workspace file the unsaved work belongs to, or null for an untitled workspace. */
  workspaceFile: WorkspaceFileInfoSchema.nullable(),
  dataFileName: z.string(),
  /** When the snapshot was written (ISO 8601). */
  savedAt: z.string(),
});
export type RecoverySnapshotInfo = z.infer<typeof RecoverySnapshotInfoSchema>;

/** The renderer's unsaved work, for crash recovery. Sent whenever it changes while dirty; `null` once clean. */
export const RecoveryUpdateSchema = z.strictObject({
  documentId: DocumentIdSchema.nullable(),
  snapshot: WorkspaceSnapshotSchema,
});
export type RecoveryUpdate = z.infer<typeof RecoveryUpdateSchema>;

/** What the renderer answers when main asks before closing its window. */
export const CloseAnswerSchema = z.discriminatedUnion('dirty', [
  z.strictObject({ dirty: z.literal(false) }),
  z.strictObject({ dirty: z.literal(true), documentId: DocumentIdSchema.nullable(), snapshot: WorkspaceSnapshotSchema }),
]);
export type CloseAnswer = z.infer<typeof CloseAnswerSchema>;

/** The preload's reply on the close channel: the renderer's answer, or `handled: false` when no handler is registered. */
export const CloseReplySchema = z.strictObject({
  requestId: z.string().min(1).max(64),
  answer: CloseAnswerSchema.nullable(),
});
export type CloseReply = z.infer<typeof CloseReplySchema>;

/** The renderer's document, for native window chrome (`setDocumentState`). */
export const DocumentStateSchema = z.strictObject({
  documentId: DocumentIdSchema.nullable(),
  /** Unsaved changes (`isWorkspaceDirty`). */
  edited: z.boolean(),
});
export type DocumentState = z.infer<typeof DocumentStateSchema>;

/** A workspace file handed to the app by the OS; open it with `{ source: 'external', token }`. */
export const ExternalOpenRequestSchema = z.strictObject({
  token: OpenTokenSchema,
  fileName: z.string(),
});
export type ExternalOpenRequest = z.infer<typeof ExternalOpenRequestSchema>;
