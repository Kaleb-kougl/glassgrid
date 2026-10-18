import { z } from 'zod';
import { TimeUnitSchema } from './field.js';

/*
 * Cross-filter pre-aggregation contract shared by the workspace model (which
 * knows how each chart bins its axis) and the engine (which keeps per-chart
 * cubes over the brushed dimension). See docs/m3-xfilter-notes.md.
 */

/**
 * How a brushed view groups its dimension, i.e. which selections it can make:
 * - `width`: numeric bins `[k * width, (k + 1) * width)` (a histogram or heatmap axis);
 * - `time`: `date_trunc(unit)` buckets (a time axis);
 * - `value`: distinct values (bar clicks, the grid); any filter on the column fits.
 */
export const CrossfilterBinSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('width'), width: z.number().positive() }),
  z.strictObject({ kind: z.literal('time'), unit: TimeUnitSchema }),
  z.strictObject({ kind: z.literal('value') }),
]);
export type CrossfilterBin = z.infer<typeof CrossfilterBinSchema>;

export const CrossfilterDimensionSchema = z.strictObject({
  column: z.string().min(1),
  bin: CrossfilterBinSchema,
});
export type CrossfilterDimension = z.infer<typeof CrossfilterDimensionSchema>;

/**
 * Attached to a view's aggregate or count request while another view is
 * brushed: `filter` is the index, in the request's filters, of the brushed
 * view's selection, and `dimension` how that view bins its column. The engine
 * may answer from a cube of the request's other filters grouped by the
 * dimension, re-summing the bins the selection covers. Answers equal the
 * plain query's (sums up to floating-point rounding order). A hint the engine
 * cannot use (selection not aligned to the bins, cube too large, scatter) is
 * ignored and the request runs as SQL.
 */
export const CrossfilterHintSchema = z.strictObject({
  filter: z.number().int().nonnegative(),
  dimension: CrossfilterDimensionSchema,
});
export type CrossfilterHint = z.infer<typeof CrossfilterHintSchema>;
