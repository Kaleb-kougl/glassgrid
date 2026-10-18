import { current } from 'immer';
import { z } from 'zod';
import { FileHandleSchema } from '../../ids.js';
import { ColumnTypeSchema, ProfileValueSchema } from '../../spec/column.js';
import { FingerprintSchema } from '../../protocol/engine.js';
import { ColumnNameSchema, createInitialGridState } from '../../state/workspace.js';
import { defineCommand } from '../define.js';
import { MCP_EXEMPTIONS } from '../mcp-exemptions.js';
import { persistedDigest } from '../../workspace-file/persisted.js';

export const OpenFileInputSchema = z.strictObject({
  handleId: FileHandleSchema,
  fileName: z.string().min(1).max(1024),
  fingerprint: FingerprintSchema,
  columns: z
    .array(z.strictObject({ name: ColumnNameSchema, type: ColumnTypeSchema }))
    .max(10_000)
    .refine((columns) => new Set(columns.map((column) => column.name)).size === columns.length, {
      message: 'Column names must be unique',
    }),
});
export type OpenFileInput = z.infer<typeof OpenFileInputSchema>;

/**
 * Records a file the engine has already opened and profiled.
 *
 * This is the synchronous half of the "async action -> engine -> dispatch"
 * pattern: the renderer's `openFileAction` asks main for a handle (native
 * dialog or drag-drop), asks the engine for the fingerprint and inferred
 * columns, and only then dispatches `openFile` with the results. Opening a
 * file starts a fresh, untitled workspace that is clean until something
 * changes (so closing it right away does not ask to save); undo restores
 * the previous one.
 */
export const openFile = defineCommand({
  name: 'openFile',
  description:
    'Starts a new workspace over a file the engine has opened, with its fingerprint and inferred column types.',
  input: OpenFileInputSchema,
  tier: 'edit',
  mcp: { exempt: MCP_EXEMPTIONS.openFile },
  apply(draft, input) {
    draft.dataSource = { handleId: input.handleId, fileName: input.fileName, fingerprint: input.fingerprint };
    draft.columns = input.columns.map((column) => ({
      name: column.name,
      inferredType: column.type,
      typeOverride: null,
    }));
    draft.charts = [];
    draft.selections = {};
    draft.userFilters = [];
    draft.grid = createInitialGridState();
    draft.layout = { cards: [] };
    // An untitled workspace that is clean until the person changes something.
    draft.document = { id: null, fileName: null, savedDigest: null };
    draft.document.savedDigest = persistedDigest(current(draft));
  },
});

export const SetColumnProfilesInputSchema = z.strictObject({
  /** Profiles as the engine reported them, for some or all columns. */
  columns: z
    .array(
      z.strictObject({
        name: ColumnNameSchema,
        type: ColumnTypeSchema,
        distinctCount: z.number().int().nonnegative(),
        nullFraction: z.number().min(0).max(1),
        min: ProfileValueSchema,
        max: ProfileValueSchema,
      }),
    )
    .max(10_000),
});
export type SetColumnProfilesInput = z.input<typeof SetColumnProfilesInputSchema>;

/**
 * Records the engine's column profile (type, distinct count, null share,
 * min and max) so the default chart rules and brush snapping can read it from
 * state. The async half of the open action dispatches it whenever a profile
 * arrives (after open, after a type change, after undoing back to a file).
 * Not an undo entry: it records what the data is, not a change to the work.
 */
export const setColumnProfiles = defineCommand({
  name: 'setColumnProfiles',
  description: "Records the engine's profile of the open file's columns (type, distinct count, null share, min, max).",
  input: SetColumnProfilesInputSchema,
  tier: 'edit',
  mcp: { exempt: MCP_EXEMPTIONS.setColumnProfiles },
  undoable: false,
  apply(draft, input) {
    for (const profile of input.columns) {
      const column = draft.columns.find((candidate) => candidate.name === profile.name);
      if (!column) continue;
      const { name: _name, ...summary } = profile;
      column.profile = summary;
    }
  },
});
