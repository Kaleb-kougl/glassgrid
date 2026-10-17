import { z } from 'zod';
import { FileHandleSchema } from '../../ids.js';
import { ColumnTypeSchema } from '../../spec/column.js';
import { FingerprintSchema } from '../../protocol/engine.js';
import { ColumnNameSchema } from '../../state/workspace.js';
import { defineCommand } from '../define.js';
import { MCP_EXEMPTIONS } from '../mcp-exemptions.js';

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
 * file starts a fresh workspace; undo restores the previous one.
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
    draft.filters = {};
    draft.grid = { sort: [] };
    draft.layout = { cards: [] };
  },
});
