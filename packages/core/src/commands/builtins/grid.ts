import { z } from 'zod';
import { SortKeySchema } from '../../spec/rows.js';
import {
  ColumnNameSchema,
  GridSelectionSchema,
  gridColumnOrder,
  MAX_GRID_COLUMN_WIDTH,
  MIN_GRID_COLUMN_WIDTH,
} from '../../state/workspace.js';
import { defineCommand, defineEffect } from '../define.js';
import { CommandError } from '../errors.js';
import { requireColumn } from './preconditions.js';

export const SortGridInputSchema = z.strictObject({
  /** Sort keys, most significant first; an empty list restores file order. */
  sort: z.array(SortKeySchema).max(64),
});
export type SortGridInput = z.input<typeof SortGridInputSchema>;

/**
 * Sorts the data grid. Replaces the whole sort, so a header click (one key)
 * and an agent asking for several keys use the same command. NULLs sort last
 * in both directions.
 */
export const sortGrid = defineCommand({
  name: 'sortGrid',
  description:
    'Sorts the data grid by one or more columns (most significant first, "asc" or "desc"; NULLs last). An empty list restores file order.',
  input: SortGridInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    const seen = new Set<string>();
    input.sort.forEach((key, i) => {
      requireColumn(draft, key.column, 'sortGrid', `sort[${i}].column`);
      if (seen.has(key.column)) {
        throw new CommandError('precondition_failed', `Column ${JSON.stringify(key.column)} appears twice in the sort`, {
          command: 'sortGrid',
          issues: [{ path: `sort[${i}].column`, message: 'Duplicate sort column' }],
        });
      }
      seen.add(key.column);
    });
    draft.grid.sort = input.sort.map((key) => ({ column: key.column, direction: key.direction }));
  },
});

export const ResizeColumnInputSchema = z.strictObject({
  column: ColumnNameSchema,
  /** New width in px, padding included. */
  width: z.number().int().min(MIN_GRID_COLUMN_WIDTH).max(MAX_GRID_COLUMN_WIDTH),
});
export type ResizeColumnInput = z.input<typeof ResizeColumnInputSchema>;

/** Sets a grid column's width (a header-edge drag, or Alt+Shift+←/→ on a focused header). */
export const resizeColumn = defineCommand({
  name: 'resizeColumn',
  description: `Sets the width of a data grid column in pixels (${MIN_GRID_COLUMN_WIDTH} to ${MAX_GRID_COLUMN_WIDTH}).`,
  input: ResizeColumnInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    requireColumn(draft, input.column, 'resizeColumn', 'column');
    const existing = draft.grid.columnWidths.find((entry) => entry.column === input.column);
    if (existing) existing.width = input.width;
    else draft.grid.columnWidths.push({ column: input.column, width: input.width });
  },
});

export const ReorderColumnInputSchema = z.strictObject({
  column: ColumnNameSchema,
  /** The column's display index after the move (0 is first). */
  toIndex: z.number().int().nonnegative(),
});
export type ReorderColumnInput = z.input<typeof ReorderColumnInputSchema>;

/**
 * Moves a grid column to a new display position (a header drag, or Alt+←/→
 * on a focused header). The selection names its columns, so it stays on the
 * same cells.
 */
export const reorderColumn = defineCommand({
  name: 'reorderColumn',
  description:
    'Moves a data grid column to a new display position: toIndex is its index after the move (0 is first). Only the display order changes, not the file.',
  input: ReorderColumnInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    requireColumn(draft, input.column, 'reorderColumn', 'column');
    const order = gridColumnOrder(draft);
    if (input.toIndex >= order.length) {
      throw new CommandError('precondition_failed', `toIndex must be below ${order.length} (the number of columns)`, {
        command: 'reorderColumn',
        issues: [{ path: 'toIndex', message: 'Out of range' }],
      });
    }
    const from = order.indexOf(input.column);
    if (from === input.toIndex) return;
    order.splice(from, 1);
    order.splice(input.toIndex, 0, input.column);
    draft.grid.columnOrder = order;
  },
});

export const SetSelectionInputSchema = z.strictObject({
  /** The new range, or null to select nothing. Rows index the current view (sort and filters applied). */
  selection: GridSelectionSchema.nullable(),
});
export type SetSelectionInput = z.input<typeof SetSelectionInputSchema>;

/**
 * Selects a cell range in the grid. Not an undo entry: selecting is how a
 * person looks around, and Undo should step through changes to the work.
 */
export const setSelection = defineCommand({
  name: 'setSelection',
  description:
    'Selects a rectangular cell range in the data grid, from anchor to focus (rows of the current sorted and filtered view, columns by name), or clears it with null. Not recorded in undo history.',
  input: SetSelectionInputSchema,
  tier: 'edit',
  mcp: true,
  undoable: false,
  apply(draft, input) {
    if (input.selection) {
      requireColumn(draft, input.selection.anchor.column, 'setSelection', 'selection.anchor.column');
      requireColumn(draft, input.selection.focus.column, 'setSelection', 'selection.focus.column');
    }
    draft.grid.selection = input.selection;
  },
});

/** Most rows and cells one copy takes (the grid's own limits). */
export const MAX_COPY_ROWS = 10_000;
export const MAX_COPY_CELLS = 250_000;

/**
 * Copies the grid selection to the clipboard as TSV. Write tier: the cells
 * leave the app. A person's Cmd/Ctrl+C is their confirmation; an AI caller
 * needs the person to confirm (refused until that UI exists).
 */
export const copySelection = defineEffect({
  name: 'copySelection',
  description: `Copies the selected grid cells to the system clipboard as tab-separated text, header-less, in display order (at most ${MAX_COPY_ROWS.toLocaleString('en-US')} rows or ${MAX_COPY_CELLS.toLocaleString('en-US')} cells). The data leaves the app, so an AI caller needs the person's confirmation.`,
  input: z.strictObject({}),
  tier: 'write',
  mcp: true,
});
