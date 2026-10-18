import { z } from 'zod';

/** Upper bound on set-membership filter size; larger selections should be ranges. */
export const MAX_FILTER_VALUES = 10_000;

/**
 * A bound of a range filter. Numeric columns take a finite number.
 * Date/timestamp columns take an ISO 8601 string (`2024-01-31`,
 * `2024-01-31 12:00:00`) or an integer number of epoch milliseconds; dates
 * compare as midnight timestamps.
 */
export const RangeBoundSchema = z.union([z.number(), z.string().min(1)]);
export type RangeBound = z.infer<typeof RangeBoundSchema>;

/** A value of a set-membership filter. `null` selects NULL cells. */
export const FilterValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type FilterValue = z.infer<typeof FilterValueSchema>;

export const RangeFilterSchema = z
  .strictObject({
    kind: z.literal('range'),
    column: z.string().min(1),
    min: RangeBoundSchema.optional(),
    max: RangeBoundSchema.optional(),
    /** Whether `min` itself matches. Defaults to true. */
    minInclusive: z.boolean().default(true),
    /** Whether `max` itself matches. Defaults to true; brushes over bins pass false. */
    maxInclusive: z.boolean().default(true),
  })
  .refine((filter) => filter.min !== undefined || filter.max !== undefined, {
    message: 'A range filter needs min, max or both',
  });

export const InFilterSchema = z.strictObject({
  kind: z.literal('in'),
  column: z.string().min(1),
  /** Matching values; an empty list matches no rows. */
  values: z.array(FilterValueSchema).max(MAX_FILTER_VALUES),
});

/**
 * The complement of `in`: rows whose value is not listed. NULL cells match
 * unless `null` is listed, so `notIn` of the named bars of a top-N chart
 * selects exactly its "Other" bar. An empty list matches every row.
 */
export const NotInFilterSchema = z.strictObject({
  kind: z.literal('notIn'),
  column: z.string().min(1),
  values: z.array(FilterValueSchema).max(MAX_FILTER_VALUES),
});

export const IsNullFilterSchema = z.strictObject({
  kind: z.literal('isNull'),
  column: z.string().min(1),
});

export const NotNullFilterSchema = z.strictObject({
  kind: z.literal('notNull'),
  column: z.string().min(1),
});

/**
 * One predicate on one column. A list of filters is combined with AND. Range
 * and set filters never match NULL cells unless the set contains `null`.
 */
export const FilterSchema = z.discriminatedUnion('kind', [
  RangeFilterSchema,
  InFilterSchema,
  NotInFilterSchema,
  IsNullFilterSchema,
  NotNullFilterSchema,
]);
export type Filter = z.infer<typeof FilterSchema>;
export type FilterInput = z.input<typeof FilterSchema>;
export type RangeFilter = z.infer<typeof RangeFilterSchema>;
export type InFilter = z.infer<typeof InFilterSchema>;
export type NotInFilter = z.infer<typeof NotInFilterSchema>;
