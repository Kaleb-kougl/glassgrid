import { z } from 'zod';
import { OpenWorkspaceRequestSchema } from '../../protocol/workspace.js';
import { DocumentIdSchema, WorkspaceDigestSchema } from '../../state/workspace.js';
import { digestPersisted, OpenedDataSchema, PersistedWorkspaceSchema, restoreWorkspace } from '../../workspace-file/persisted.js';
import { defineCommand, defineEffect } from '../define.js';
import { CommandError } from '../errors.js';
import { MCP_EXEMPTIONS } from '../mcp-exemptions.js';

/*
 * Workspace files. Saving and opening need the host (native dialogs, the
 * file system, the engine), so the user-facing commands are effect commands
 * the app implements with `registry.provide` (see
 * `provideWorkspacePersistence`); the state changes they lead to are the two
 * state commands at the bottom, which only the app dispatches.
 *
 * Rules for AI callers:
 * - `saveWorkspace` / `saveWorkspaceAs` are `write` tier: they run only when
 *   the host's `confirmWrite` allows it (the desktop asks the person; until
 *   that UI exists it refuses AI callers). The path is always chosen by the
 *   person in a native dialog or is the file the workspace came from; no
 *   command takes a path.
 * - `openWorkspace` is `edit` tier (it replaces the workspace, undoably),
 *   but an AI caller may only open an entry of the recent list
 *   (`listRecentWorkspaces`); `dialog` and `external` are refused, because
 *   they choose a file on the person's behalf or act on the OS's hand-off.
 */

export const saveWorkspace = defineEffect({
  name: 'saveWorkspace',
  description:
    'Saves the workspace (charts, filters and selections, column types, grid sort and layout; never data rows) to its .glassgrid file, or asks for a file name in a native dialog when it has none. Writes a file, so an AI caller needs the person to confirm.',
  input: z.strictObject({}),
  tier: 'write',
  mcp: true,
});

export const saveWorkspaceAs = defineEffect({
  name: 'saveWorkspaceAs',
  description:
    'Saves the workspace to a new .glassgrid file the person chooses in a native save dialog. Writes a file, so an AI caller needs the person to confirm.',
  input: z.strictObject({}),
  tier: 'write',
  mcp: true,
});

export const OpenWorkspaceInputSchema = OpenWorkspaceRequestSchema;
export type OpenWorkspaceInput = z.input<typeof OpenWorkspaceInputSchema>;

export const openWorkspace = defineEffect({
  name: 'openWorkspace',
  description:
    'Opens a saved .glassgrid workspace, replacing the current one (undo restores it). AI callers may only open an entry of the recent list: { source: "recent", id } with an id from listRecentWorkspaces. If the data file has moved, the person is asked to locate it.',
  input: OpenWorkspaceInputSchema,
  tier: 'edit',
  mcp: true,
  checkCaller(input, caller) {
    if (caller === 'ai' && input.source !== 'recent') {
      throw new CommandError(
        'forbidden',
        'AI callers may only open workspaces from the recent list: call listRecentWorkspaces and pass { source: "recent", id }',
        { command: 'openWorkspace', issues: [{ path: 'source', message: 'Only "recent" is allowed for AI callers' }] },
      );
    }
  },
});

export const listRecentWorkspaces = defineEffect({
  name: 'listRecentWorkspaces',
  description: 'Lists recently opened or saved workspaces (id, file name, when last opened), newest first, for openWorkspace.',
  input: z.strictObject({}),
  tier: 'read',
  mcp: true,
});

export const LoadWorkspaceInputSchema = z.strictObject({
  /** The data file as the engine opened it (handle, fingerprint, inferred columns). */
  data: OpenedDataSchema,
  /** The saved workspace (the file's `workspace` block, migrated). */
  workspace: PersistedWorkspaceSchema,
  /** The file it came from; `id` and `fileName` null for a restored untitled workspace. */
  document: z.strictObject({ id: DocumentIdSchema.nullable(), fileName: z.string().min(1).max(1024).nullable() }),
  /** True for a crash-recovery snapshot: the workspace is unsaved work, so it starts dirty. */
  recovered: z.boolean(),
});
export type LoadWorkspaceInput = z.input<typeof LoadWorkspaceInputSchema>;

/**
 * Replaces the workspace with a saved one restored over freshly opened data
 * (`restoreWorkspace`: missing columns drop what used them; profiles and the
 * grid selection start empty). One undo entry; undo brings back the previous
 * workspace. The result is clean unless restoring had to change something
 * or it is a recovery snapshot.
 */
export const loadWorkspace = defineCommand({
  name: 'loadWorkspace',
  description:
    'Replaces the workspace with a saved .glassgrid workspace restored over data the engine has opened (app-internal; agents use openWorkspace).',
  input: LoadWorkspaceInputSchema,
  tier: 'edit',
  mcp: { exempt: MCP_EXEMPTIONS.loadWorkspace },
  apply(draft, input) {
    const { state } = restoreWorkspace(input.workspace, input.data, {
      id: input.document.id,
      fileName: input.document.fileName,
      savedDigest: input.recovered ? null : digestPersisted(input.workspace),
    });
    draft.dataSource = state.dataSource;
    draft.columns = state.columns;
    draft.charts = state.charts;
    draft.selections = state.selections;
    draft.userFilters = state.userFilters;
    draft.grid = state.grid;
    draft.layout = state.layout;
    draft.document = state.document;
  },
});

export const MarkWorkspaceSavedInputSchema = z.strictObject({
  documentId: DocumentIdSchema,
  fileName: z.string().min(1).max(1024),
  /** `digestPersisted` of the snapshot that was written (not of the state now: it may have changed while saving). */
  savedDigest: WorkspaceDigestSchema,
});
export type MarkWorkspaceSavedInput = z.input<typeof MarkWorkspaceSavedInputSchema>;

/**
 * Records a completed save: the workspace now belongs to that file and is
 * clean as long as its persisted subset matches what was written. Not an
 * undo entry (saving is not a change to the work).
 */
export const markWorkspaceSaved = defineCommand({
  name: 'markWorkspaceSaved',
  description: 'Records that the app saved the workspace to a file (app-internal; agents use saveWorkspace).',
  input: MarkWorkspaceSavedInputSchema,
  tier: 'edit',
  mcp: { exempt: MCP_EXEMPTIONS.markWorkspaceSaved },
  undoable: false,
  apply(draft, input) {
    draft.document = { id: input.documentId, fileName: input.fileName, savedDigest: input.savedDigest };
  },
});
