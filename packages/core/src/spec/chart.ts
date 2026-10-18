import { z } from 'zod';
import { FieldSchema, YFieldSchema } from './field.js';
import { FilterSchema } from './filter.js';

export const MarkSchema = z.enum(['bar', 'line', 'area', 'histogram', 'heatmap', 'scatter']);
export type Mark = z.infer<typeof MarkSchema>;

/** Bars returned when `limit` is omitted. */
export const DEFAULT_BAR_LIMIT = 20;
/** Largest top-N a bar chart may ask for. */
export const MAX_BAR_LIMIT = 1_000;
/** Named colour series; anything beyond folds into one "Other" series. */
export const MAX_COLOR_SERIES = 8;
/** Raw points a scatter plot may draw; above this the engine falls back to a heatmap. */
export const SCATTER_MAX_POINTS = 50_000;

/**
 * A declarative chart, compiled to one aggregate query. Validated with this
 * schema at every boundary (UI, saved workspace, model output).
 *
 * Per-mark rules the schema cannot express (checked by the compiler, which
 * reports them as `CompileError`s): which column types each channel accepts,
 * which marks take `limit`, `bin` and `timeUnit`, and `y.aggregate` usage.
 */
export const ChartSpecSchema = z.strictObject({
  mark: MarkSchema,
  x: FieldSchema,
  y: YFieldSchema.optional(),
  /** Series split; at most 8 named series, the rest fold into "Other". */
  color: FieldSchema.optional(),
  /** Cross-filter selections from other views (excluding this chart's own brush). */
  filters: z.array(FilterSchema).default([]),
  /** Top-N categories for bar charts (default 20) or a point cap for scatter. */
  limit: z.number().int().positive().max(SCATTER_MAX_POINTS).optional(),
  /**
   * Bar charts only: fold every x value beyond the top `limit` into one
   * "Other" bar (`x` NULL, `x_other` TRUE), whose measure is computed from
   * its rows. Used by the default chart for categories with many values.
   */
  other: z.boolean().optional(),
});
export type ChartSpec = z.infer<typeof ChartSpecSchema>;
export type ChartSpecInput = z.input<typeof ChartSpecSchema>;
