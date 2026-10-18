import type { Draft } from 'immer';
import { z } from 'zod';
import { BrushError, BrushSelectionSchema, chartSelection, gridSelection } from '../../crossfilter/brush.js';
import { stateColumns } from '../../crossfilter/axes.js';
import { FilterSchema, type Filter } from '../../spec/filter.js';
import { compileWhere } from '../../sql/where.js';
import { isCompileError } from '../../sql/errors.js';
import {
  ColumnNameSchema,
  GRID_VIEW_ID,
  MAX_USER_FILTERS,
  SelectionChannelSchema,
  ViewIdSchema,
  type Selection,
  type SelectionChannel,
  type WorkspaceState,
} from '../../state/workspace.js';
import { defineCommand } from '../define.js';
import { CommandError } from '../errors.js';
import { requireColumn } from './preconditions.js';

export const SetFilterInputSchema = z.strictObject({
  /** The view that owns the selection: a chart id, or "grid". */
  viewId: ViewIdSchema,
  filter: FilterSchema,
});
export type SetFilterInput = z.input<typeof SetFilterInputSchema>;

export const ClearFilterInputSchema = z.union([
  z.strictObject({
    /** Clear this view's selection (a chart id, or "grid")... */
    viewId: ViewIdSchema,
    /** ...or only its clause on this axis (one axis of a 2-D brush)... */
    channel: SelectionChannelSchema.optional(),
    /** ...or only its clauses on this column. */
    column: ColumnNameSchema.optional(),
  }),
  z.strictObject({
    /** Remove a filter that is not tied to a view (its id from `userFilters`). */
    filterId: ViewIdSchema,
  }),
]);
export type ClearFilterInput = z.input<typeof ClearFilterInputSchema>;

export const AddFilterInputSchema = z.strictObject({ filter: FilterSchema });
export type AddFilterInput = z.input<typeof AddFilterInputSchema>;

export const BrushInputSchema = z.strictObject({
  /** The brushed view: a chart id, or "grid". */
  viewId: ViewIdSchema,
  /** The committed brush or click, or null to clear the view's selection. */
  selection: BrushSelectionSchema.nullable(),
});
export type BrushInput = z.input<typeof BrushInputSchema>;

function requireView(draft: Draft<WorkspaceState>, viewId: string, command: string, path = 'viewId'): void {
  if (viewId === GRID_VIEW_ID || draft.charts.some((chart) => chart.id === viewId)) return;
  throw new CommandError(
    'precondition_failed',
    `Unknown view ${JSON.stringify(viewId)}; use "grid" or a chart id (${draft.charts.map((c) => JSON.stringify(c.id)).join(', ') || 'there are no charts'})`,
    { command, issues: [{ path, message: 'Unknown view' }] },
  );
}

/** Check filters the way the compiler will read them (column types, value types), so a bad value fails now. */
function requireCompilable(draft: Draft<WorkspaceState>, filters: readonly Filter[], command: string, path: string): void {
  try {
    compileWhere(filters, stateColumns(draft));
  } catch (error) {
    if (!isCompileError(error)) throw error;
    throw new CommandError('precondition_failed', error.message, { command, issues: [{ path, message: error.message }] });
  }
}

function clearSelection(draft: Draft<WorkspaceState>, viewId: string): void {
  if (Object.hasOwn(draft.selections, viewId)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by validated view ids
    delete draft.selections[viewId];
  }
}

/** The channel a filter on `column` occupies in a chart (x first), or null. */
function channelOf(draft: Draft<WorkspaceState>, viewId: string, column: string): SelectionChannel | null {
  const chart = draft.charts.find((candidate) => candidate.id === viewId);
  if (!chart) return null;
  if (chart.spec.x.column === column) return 'x';
  if (chart.spec.y?.column === column) return 'y';
  return null;
}

/**
 * Sets a view's selection to one filter (see "Cross-filtering": one
 * selection per view). Every other view, and the grid, re-query with it; the
 * owning view keeps showing its full distribution.
 */
export const setFilter = defineCommand({
  name: 'setFilter',
  description:
    'Sets the selection a view (a chart id, or "grid") applies to every other view: a range, a set of values ("in" / "notIn"), isNull or notNull on one column. Replaces that view\'s previous selection. Use brush to select the way a drag or click does (snapped to bins).',
  input: SetFilterInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    requireView(draft, input.viewId, 'setFilter');
    requireColumn(draft, input.filter.column, 'setFilter', 'filter.column');
    requireCompilable(draft, [input.filter], 'setFilter', 'filter');
    draft.selections[input.viewId] = {
      source: 'filter',
      clauses: [{ channel: channelOf(draft, input.viewId, input.filter.column), filter: input.filter }],
    };
  },
});

/**
 * Removes a view's selection (or one axis of a 2-D brush), or a filter that
 * is not tied to a view. Removing a filter chip dispatches this, so the brush
 * or click it came from is cleared too. A no-op (nothing recorded) when there
 * is nothing to remove.
 */
export const clearFilter = defineCommand({
  name: 'clearFilter',
  description:
    'Removes the selection a view (a chart id, or "grid") applies to the other views, or with channel ("x" or "y") or column only that part of a 2-D brush; or, with filterId, a filter added with addFilter.',
  input: ClearFilterInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    if ('filterId' in input) {
      const index = draft.userFilters.findIndex((entry) => entry.id === input.filterId);
      if (index >= 0) draft.userFilters.splice(index, 1);
      return;
    }
    const selection = draft.selections[input.viewId];
    if (!selection) return;
    if (input.column === undefined && input.channel === undefined) {
      clearSelection(draft, input.viewId);
      return;
    }
    const kept = selection.clauses.filter(
      (clause) =>
        (input.channel !== undefined && clause.channel !== input.channel) ||
        (input.column !== undefined && clause.filter.column !== input.column),
    );
    if (kept.length === selection.clauses.length) return;
    if (kept.length === 0) clearSelection(draft, input.viewId);
    else selection.clauses = kept;
  },
});

/** Adds a filter chip that is not tied to a view: every view, the grid included, queries with it. */
export const addFilter = defineCommand({
  name: 'addFilter',
  description:
    'Adds a filter that applies to every view, the grid included (a filter chip not tied to a chart): range, in, notIn, isNull or notNull on one column. Its id is the last entry of `userFilters` in the returned state; remove it with clearFilter { filterId }.',
  input: AddFilterInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input, ctx) {
    if (draft.dataSource === null) {
      throw new CommandError('precondition_failed', 'No file is open, so there is nothing to filter', { command: 'addFilter' });
    }
    requireColumn(draft, input.filter.column, 'addFilter', 'filter.column');
    requireCompilable(draft, [input.filter], 'addFilter', 'filter');
    if (draft.userFilters.length >= MAX_USER_FILTERS) {
      throw new CommandError('precondition_failed', `A workspace holds at most ${MAX_USER_FILTERS} filters`, { command: 'addFilter' });
    }
    draft.userFilters.push({ id: ctx.newId('filter'), filter: input.filter });
  },
});

/**
 * Commits a brush or click on a view. The UI dispatches it once, when the
 * pointer is released (moving the brush is local UI state), so each brush is
 * one undo entry. Brushes on binned axes snap outwards to whole bins.
 */
export const brush = defineCommand({
  name: 'brush',
  description:
    'Selects on a view the way a person brushes or clicks it, and cross-filters every other view and the grid with it. ' +
    'Charts: { type: "interval", x?: { min?, max? }, y?: { min?, max? } } in data units (dates as ISO text or epoch ms); ranges on binned axes (histogram, heatmap, time buckets) snap outwards to whole bins and become [min, max); y only on heatmap and scatter. ' +
    'Bar charts: { type: "points", values: [...] } selects bars by their x value; add other: { shown: [named bar values] } to include the "Other" bar. ' +
    'The grid: the same shapes with column set. null clears the view\'s selection.',
  input: BrushInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    requireView(draft, input.viewId, 'brush');
    if (input.selection === null) {
      clearSelection(draft, input.viewId);
      return;
    }
    const columns = stateColumns(draft);
    let selection: Selection;
    try {
      if (input.viewId === GRID_VIEW_ID) {
        selection = gridSelection(input.selection, columns);
      } else {
        const chart = draft.charts.find((candidate) => candidate.id === input.viewId);
        if (!chart) throw new BrushError('Unknown chart', 'viewId');
        selection = chartSelection(chart.spec, input.selection, columns);
      }
    } catch (error) {
      if (!(error instanceof BrushError)) throw error;
      throw new CommandError('precondition_failed', error.message, { command: 'brush', issues: [{ path: error.path, message: error.message }] });
    }
    requireCompilable(
      draft,
      selection.clauses.map((clause) => clause.filter),
      'brush',
      'selection',
    );
    draft.selections[input.viewId] = selection;
  },
});
