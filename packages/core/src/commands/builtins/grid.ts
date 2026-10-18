import { z } from 'zod';
import { SortKeySchema } from '../../spec/rows.js';
import { defineCommand } from '../define.js';
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
