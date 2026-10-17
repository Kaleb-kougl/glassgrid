import { z } from 'zod';
import { FilterSchema } from './filter.js';

/** Largest page the grid may request in one call. */
export const MAX_ROWS_PAGE = 1_000;

export const SortDirectionSchema = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof SortDirectionSchema>;

export const SortKeySchema = z.strictObject({
  column: z.string().min(1),
  direction: SortDirectionSchema.default('asc'),
});
export type SortKey = z.infer<typeof SortKeySchema>;

/** A page of grid rows. NULLs sort last in both directions. */
export const RowQuerySchema = z.strictObject({
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().positive().max(MAX_ROWS_PAGE),
  sort: z.array(SortKeySchema).max(64).default([]),
  filters: z.array(FilterSchema).default([]),
});
export type RowQuery = z.infer<typeof RowQuerySchema>;
export type RowQueryInput = z.input<typeof RowQuerySchema>;
