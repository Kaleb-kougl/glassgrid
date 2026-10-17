import { z } from 'zod';
import { ColumnTypeSchema } from '../../spec/column.js';
import { ColumnNameSchema } from '../../state/workspace.js';
import { defineCommand } from '../define.js';
import { CommandError } from '../errors.js';

export const SetColumnTypeInputSchema = z.strictObject({
  column: ColumnNameSchema,
  type: ColumnTypeSchema,
});
export type SetColumnTypeInput = z.infer<typeof SetColumnTypeInputSchema>;

const MAX_LISTED_COLUMNS = 20;

/**
 * Overrides how a column is typed. Setting a column back to its inferred type
 * clears the override, so the saved workspace only records real choices.
 */
export const setColumnType = defineCommand({
  name: 'setColumnType',
  description:
    "Sets a column's type (integer, float, decimal, boolean, date, timestamp or text). Choosing the inferred type removes the override.",
  input: SetColumnTypeInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    const column = draft.columns.find((candidate) => candidate.name === input.column);
    if (column === undefined) {
      if (draft.columns.length === 0) {
        throw new CommandError('precondition_failed', 'No file is open, so there are no columns to type', {
          command: 'setColumnType',
          issues: [{ path: 'column', message: 'No file is open' }],
        });
      }
      const names = draft.columns.slice(0, MAX_LISTED_COLUMNS).map((candidate) => JSON.stringify(candidate.name));
      const more = draft.columns.length > MAX_LISTED_COLUMNS ? `, … (${draft.columns.length} in total)` : '';
      throw new CommandError(
        'precondition_failed',
        `Unknown column ${JSON.stringify(input.column)}; columns are ${names.join(', ')}${more}`,
        { command: 'setColumnType', issues: [{ path: 'column', message: 'Unknown column' }] },
      );
    }
    column.typeOverride = input.type === column.inferredType ? null : input.type;
  },
});
