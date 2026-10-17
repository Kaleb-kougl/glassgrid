import { z } from 'zod';
import { FileHandleSchema } from '../ids.js';
import { ColumnTypeSchema, type ColumnType } from '../spec/column.js';
import { SortKeySchema } from '../spec/rows.js';

/*
 * Workspace state: the user's work, owned by the renderer's store and saved to
 * `.glassgrid` files. It must stay plain JSON (no Dates, Maps, class instances
 * or undefined values) so it can be serialised, diffed and undone as patches.
 */

/**
 * Placeholder for a chart spec.
 *
 * INTEGRATION: replace with the real `ChartSpecSchema` from
 * packages/core/src/spec/** once it lands.
 */
export const ChartSpecLikeSchema = z.record(z.string(), z.unknown());
export type ChartSpecLike = z.infer<typeof ChartSpecLikeSchema>;

/**
 * Placeholder for one view's filter selection.
 *
 * INTEGRATION: replace with the real `Filter`/`Selection` schema from
 * packages/core/src/spec/**.
 */
export const FilterLikeSchema = z.record(z.string(), z.unknown());
export type FilterLike = z.infer<typeof FilterLikeSchema>;

/**
 * Ids used as object keys in state. Restricting the alphabet keeps keys such
 * as `__proto__` out of plain-object records.
 */
const SafeIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'Invalid id');

export const ChartIdSchema = SafeIdSchema;
export type ChartId = z.infer<typeof ChartIdSchema>;

/** A view is anything that can own a filter selection: a chart card or the grid. */
export const ViewIdSchema = SafeIdSchema;
export type ViewId = z.infer<typeof ViewIdSchema>;

/** Identifies a CSV on disk: size, mtime and a hash of its first and last 1 MB. */
export const FingerprintSchema = z.strictObject({
  sizeBytes: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  sampleHash: z.string().min(1).max(128),
});
export type Fingerprint = z.infer<typeof FingerprintSchema>;

export const DataSourceSchema = z.strictObject({
  handleId: FileHandleSchema,
  /** Display name only; the path never reaches the renderer. */
  fileName: z.string().min(1).max(1024),
  fingerprint: FingerprintSchema,
});
export type DataSource = z.infer<typeof DataSourceSchema>;

export const ColumnNameSchema = z.string().min(1).max(1024);

export const ColumnStateSchema = z.strictObject({
  name: ColumnNameSchema,
  /** What the engine inferred when the file was opened. */
  inferredType: ColumnTypeSchema,
  /** The user's choice, or null to use the inferred type. */
  typeOverride: ColumnTypeSchema.nullable(),
});
export type ColumnState = z.infer<typeof ColumnStateSchema>;

export const ChartStateSchema = z.strictObject({
  id: ChartIdSchema,
  spec: ChartSpecLikeSchema,
});
export type ChartState = z.infer<typeof ChartStateSchema>;

export const GridStateSchema = z.strictObject({
  sort: z.array(SortKeySchema),
});
export type GridState = z.infer<typeof GridStateSchema>;

/** Position of a chart card on the dashboard grid, in grid units. */
export const LayoutCardSchema = z.strictObject({
  chartId: ChartIdSchema,
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
export type LayoutCard = z.infer<typeof LayoutCardSchema>;

export const LayoutStateSchema = z.strictObject({
  cards: z.array(LayoutCardSchema),
});
export type LayoutState = z.infer<typeof LayoutStateSchema>;

export const WorkspaceStateSchema = z.strictObject({
  dataSource: DataSourceSchema.nullable(),
  columns: z.array(ColumnStateSchema),
  charts: z.array(ChartStateSchema),
  /** One selection per view (chart id or grid); see Cross-filtering. */
  filters: z.record(ViewIdSchema, FilterLikeSchema),
  grid: GridStateSchema,
  layout: LayoutStateSchema,
});
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

/** A fresh, empty workspace. Returns a new object on every call. */
export function createInitialWorkspaceState(): WorkspaceState {
  return {
    dataSource: null,
    columns: [],
    charts: [],
    filters: {},
    grid: { sort: [] },
    layout: { cards: [] },
  };
}

/** The type the grid and compiler should use for a column. */
export function effectiveColumnType(column: Pick<ColumnState, 'inferredType' | 'typeOverride'>): ColumnType {
  return column.typeOverride ?? column.inferredType;
}
