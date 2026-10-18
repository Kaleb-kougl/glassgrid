import { z } from 'zod';
import { FilterSchema } from '../../spec/filter.js';
import { GRID_VIEW_ID, ViewIdSchema } from '../../state/workspace.js';
import { defineCommand } from '../define.js';
import { CommandError } from '../errors.js';
import { requireColumn } from './preconditions.js';

export const SetFilterInputSchema = z.strictObject({
  /** The view that owns the selection: a chart id, or "grid". */
  viewId: ViewIdSchema,
  filter: FilterSchema,
});
export type SetFilterInput = z.input<typeof SetFilterInputSchema>;

export const ClearFilterInputSchema = z.strictObject({
  viewId: ViewIdSchema,
});
export type ClearFilterInput = z.input<typeof ClearFilterInputSchema>;

/**
 * Sets a view's selection (see "Cross-filtering": one selection per view).
 * Every other view, and the grid, re-query with it; the owning chart keeps
 * showing its full distribution.
 */
export const setFilter = defineCommand({
  name: 'setFilter',
  description:
    'Sets the selection a view (a chart id, or "grid") applies to every other view: a range, a set of values ("in"), isNull or notNull on one column. Replaces that view\'s previous selection.',
  input: SetFilterInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    if (input.viewId !== GRID_VIEW_ID && !draft.charts.some((chart) => chart.id === input.viewId)) {
      throw new CommandError(
        'precondition_failed',
        `Unknown view ${JSON.stringify(input.viewId)}; use "grid" or a chart id (${draft.charts.map((c) => JSON.stringify(c.id)).join(', ') || 'there are no charts'})`,
        { command: 'setFilter', issues: [{ path: 'viewId', message: 'Unknown view' }] },
      );
    }
    requireColumn(draft, input.filter.column, 'setFilter', 'filter.column');
    draft.filters[input.viewId] = input.filter;
  },
});

/** Removes a view's selection; a no-op (nothing recorded) when it has none. */
export const clearFilter = defineCommand({
  name: 'clearFilter',
  description: 'Removes the selection a view (a chart id, or "grid") applies to the other views.',
  input: ClearFilterInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    if (Object.hasOwn(draft.filters, input.viewId)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by validated view ids
      delete draft.filters[input.viewId];
    }
  },
});
