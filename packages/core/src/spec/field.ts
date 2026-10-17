import { z } from 'zod';

export const TimeUnitSchema = z.enum(['hour', 'day', 'month']);
export type TimeUnit = z.infer<typeof TimeUnitSchema>;

export const AggregateSchema = z.enum(['count', 'sum', 'avg', 'min', 'max']);
export type Aggregate = z.infer<typeof AggregateSchema>;

const fieldShape = {
  column: z.string().min(1),
  /**
   * Numeric binning. A number is the bin width in the column's units (bins
   * are `[k * width, (k + 1) * width)`); `'auto'` picks a "nice" width
   * (1, 2 or 5 x 10^n) from the profile's min and max. On date/timestamp
   * columns only `'auto'` is accepted and means "pick a time unit".
   */
  bin: z.union([z.number().positive(), z.literal('auto')]).optional(),
  /** Truncate a date/timestamp column to this unit (`date_trunc`). */
  timeUnit: TimeUnitSchema.optional(),
};

export const FieldSchema = z.strictObject(fieldShape);
export type Field = z.infer<typeof FieldSchema>;

/**
 * The y channel. For bar, histogram, line and area charts `aggregate` says how
 * rows are summarised per x value. For heatmap and scatter, y is a second
 * positional dimension: heatmap cells always count rows (`aggregate` may be
 * omitted or `'count'`) and scatter plots raw points (no `aggregate`).
 */
export const YFieldSchema = z.strictObject({
  ...fieldShape,
  aggregate: AggregateSchema.optional(),
});
export type YField = z.infer<typeof YFieldSchema>;
