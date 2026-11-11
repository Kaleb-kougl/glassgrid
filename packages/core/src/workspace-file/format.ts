import { z } from 'zod';
import type { WorkspaceState } from '../state/workspace.js';
import { fileIssues, WorkspaceFileError } from './errors.js';
import { AppInfoSchema, DataReferenceSchema, RecoveryOfSchema, type AppInfo, type DataReference, type RecoveryOf } from './file-parts.js';
import { CURRENT_FORMAT_VERSION, migrateWorkspaceFile } from './migrations.js';
import {
  PersistedWorkspaceSchema,
  snapshotWorkspace,
  type PersistedWorkspace,
  type WorkspaceSnapshot,
  type WorkspaceWarning,
} from './persisted.js';

/** File name extension of a workspace file, without the dot. */
export const WORKSPACE_FILE_EXTENSION = 'glassgrid';

/** Largest workspace file the app reads. Real ones are kilobytes; this only stops a runaway read. */
export const MAX_WORKSPACE_FILE_BYTES = 32 * 1024 * 1024;

export { AppInfoSchema, DataReferenceSchema, RecoveryOfSchema, type AppInfo, type DataReference, type RecoveryOf } from './file-parts.js';

/**
 * A `.glassgrid` file, format version 2: version 1 plus map views
 * (`workspace.maps`, whose ids layout cards may name). See migrations.ts.
 */
export const WorkspaceFileV2Schema = z.strictObject({
  formatVersion: z.literal(2),
  /** The app that wrote the file (informational). */
  app: AppInfoSchema,
  /** When it was written, ISO 8601 with offset. */
  savedAt: z.iso.datetime({ offset: true }),
  data: DataReferenceSchema,
  workspace: PersistedWorkspaceSchema,
  recoveryOf: RecoveryOfSchema.optional(),
});
export type WorkspaceFileV2 = z.infer<typeof WorkspaceFileV2Schema>;

/** The current file format. */
export const WorkspaceFileSchema = WorkspaceFileV2Schema;
export type WorkspaceFile = WorkspaceFileV2;

export interface SerializeMeta {
  readonly app: AppInfo;
  /** ISO 8601 timestamp, from the host's clock. */
  readonly savedAt: string;
  readonly absolutePath: string;
  readonly relativePath: string | null;
  readonly recoveryOf?: RecoveryOf;
}

function isSnapshot(source: WorkspaceState | WorkspaceSnapshot): source is WorkspaceSnapshot {
  return 'workspace' in source;
}

/**
 * The file object for a workspace. Validates everything it writes (a state
 * that would not load again throws a `WorkspaceFileError('invalid_file')`
 * instead of producing a file), and puts keys in a fixed order so saving the
 * same workspace twice gives the same bytes.
 */
export function toWorkspaceFile(source: WorkspaceState | WorkspaceSnapshot, meta: SerializeMeta): WorkspaceFile {
  const snapshot = isSnapshot(source) ? source : snapshotWorkspace(source);
  const workspace = PersistedWorkspaceSchema.safeParse(snapshot.workspace);
  if (!workspace.success) {
    throw new WorkspaceFileError('invalid_file', 'The workspace is not valid and was not saved', fileIssues(workspace.error, ['workspace']));
  }
  const { sizeBytes, mtimeMs, headTailSha256, key } = snapshot.dataSource.fingerprint;
  const file: WorkspaceFile = {
    formatVersion: CURRENT_FORMAT_VERSION,
    app: { name: meta.app.name, version: meta.app.version },
    savedAt: meta.savedAt,
    data: {
      fileName: snapshot.dataSource.fileName,
      absolutePath: meta.absolutePath,
      relativePath: meta.relativePath,
      fingerprint: { sizeBytes, mtimeMs, headTailSha256, key },
    },
    workspace: workspace.data,
    ...(meta.recoveryOf === undefined ? {} : { recoveryOf: { workspacePath: meta.recoveryOf.workspacePath } }),
  };
  const checked = WorkspaceFileSchema.safeParse(file);
  if (!checked.success) throw new WorkspaceFileError('invalid_file', 'The workspace file would not be valid', fileIssues(checked.error));
  return file;
}

/** `toWorkspaceFile` as text: two-space indented JSON with a trailing newline (diff-friendly). */
export function serializeWorkspace(source: WorkspaceState | WorkspaceSnapshot, meta: SerializeMeta): string {
  return `${JSON.stringify(toWorkspaceFile(source, meta), null, 2)}\n`;
}

export interface ParsedWorkspace {
  /** The file, migrated to the current format. */
  readonly file: WorkspaceFile;
  readonly workspace: PersistedWorkspace;
  readonly data: DataReference;
  /** The format version the file was written in, when it was older than the current one. */
  readonly migratedFrom: number | null;
  /** Things the person should know that did not stop the file from loading. */
  readonly warnings: WorkspaceWarning[];
}

/**
 * Reads a workspace file: JSON text (or an already parsed value), migrated
 * to the current format and validated. Throws `WorkspaceFileError` with a
 * code and a message for the person when it cannot be read.
 */
export function parseWorkspace(input: unknown): ParsedWorkspace {
  let document: unknown = input;
  if (typeof input === 'string') {
    try {
      // Tolerate a UTF-8 byte order mark from editors that add one.
      document = JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input);
    } catch {
      throw new WorkspaceFileError('invalid_json', 'This is not a Glassgrid workspace: the file is not valid JSON');
    }
  }
  const { document: migrated, from } = migrateWorkspaceFile(document);
  const parsed = WorkspaceFileSchema.safeParse(migrated);
  if (!parsed.success) {
    throw new WorkspaceFileError(
      'invalid_file',
      `This workspace file is damaged or was edited by hand and cannot be opened (${fileIssues(parsed.error)[0]?.message ?? 'invalid'})`,
      fileIssues(parsed.error),
    );
  }
  const warnings: WorkspaceWarning[] =
    from === null
      ? []
      : [{ code: 'migrated', message: `This workspace was saved by an older Glassgrid (format ${from}); saving it writes format ${CURRENT_FORMAT_VERSION}` }];
  return { file: parsed.data, workspace: parsed.data.workspace, data: parsed.data.data, migratedFrom: from, warnings };
}
