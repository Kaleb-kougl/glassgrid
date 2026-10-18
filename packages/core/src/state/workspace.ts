import { z } from 'zod';
import { FileHandleSchema } from '../ids.js';
import { FingerprintSchema } from '../protocol/engine.js';
import { ChartSpecSchema } from '../spec/chart.js';
import { ColumnTypeSchema, ProfileValueSchema, type ColumnType } from '../spec/column.js';
import { FilterSchema } from '../spec/filter.js';
import { SortKeySchema } from '../spec/rows.js';

/*
 * Workspace state: the user's work, owned by the renderer's store and saved to
 * `.glassgrid` files. It must stay plain JSON (no Dates, Maps, class instances
 * or undefined values) so it can be serialised, diffed and undone as patches.
 */

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

/** The view id of the data grid's own selection. */
export const GRID_VIEW_ID = 'grid';

export const DataSourceSchema = z.strictObject({
  handleId: FileHandleSchema,
  /** Display name only; the path never reaches the renderer. */
  fileName: z.string().min(1).max(1024),
  /** As returned by the engine's `open` (size, mtime, head/tail SHA-256, cache key). */
  fingerprint: FingerprintSchema,
});
export type DataSource = z.infer<typeof DataSourceSchema>;

export const ColumnNameSchema = z.string().min(1).max(1024);

/**
 * What the engine's profile says about a column, kept in state so commands
 * (default charts, brush snapping) can use it. Recorded by `setColumnProfiles`
 * after the profile arrives; `type` is the type it was computed for, so a
 * summary whose type differs from the column's effective type is stale.
 */
export const ColumnProfileSummarySchema = z.strictObject({
  type: ColumnTypeSchema,
  /** Approximate number of distinct non-NULL values. */
  distinctCount: z.number().int().nonnegative(),
  nullFraction: z.number().min(0).max(1),
  min: ProfileValueSchema,
  max: ProfileValueSchema,
});
export type ColumnProfileSummary = z.infer<typeof ColumnProfileSummarySchema>;

export const ColumnStateSchema = z.strictObject({
  name: ColumnNameSchema,
  /** What the engine inferred when the file was opened. */
  inferredType: ColumnTypeSchema,
  /** The user's choice, or null to use the inferred type. */
  typeOverride: ColumnTypeSchema.nullable(),
  /** The engine's profile of the column; absent until it has been recorded. */
  profile: ColumnProfileSummarySchema.optional(),
});
export type ColumnState = z.infer<typeof ColumnStateSchema>;

/** Longest chart title a card shows or a caller may set. */
export const MAX_CHART_TITLE = 200;

export const ChartStateSchema = z.strictObject({
  id: ChartIdSchema,
  spec: ChartSpecSchema,
  /** The card title; absent means "derive one from the spec". */
  title: z.string().trim().min(1).max(MAX_CHART_TITLE).optional(),
});
export type ChartState = z.infer<typeof ChartStateSchema>;

/** Narrowest and widest a grid column may be dragged (px, padding included). */
export const MIN_GRID_COLUMN_WIDTH = 48;
export const MAX_GRID_COLUMN_WIDTH = 2_000;

export const GridColumnWidthSchema = z.strictObject({
  column: ColumnNameSchema,
  /** Width in px, padding included. */
  width: z.number().int().min(MIN_GRID_COLUMN_WIDTH).max(MAX_GRID_COLUMN_WIDTH),
});
export type GridColumnWidth = z.infer<typeof GridColumnWidthSchema>;

/** One cell of the grid: a row of the current view (sort and filters applied) and a column by name. */
export const GridCellRefSchema = z.strictObject({
  row: z.number().int().nonnegative(),
  column: ColumnNameSchema,
});
export type GridCellRef = z.infer<typeof GridCellRefSchema>;

/**
 * A rectangular cell range: from `anchor` (where it started) to `focus` (the
 * focused cell), both inclusive. Columns are named, so the corners stay on the
 * same columns when columns are reordered; the range covers the columns
 * between them in display order.
 */
export const GridSelectionSchema = z.strictObject({
  anchor: GridCellRefSchema,
  focus: GridCellRefSchema,
});
export type GridSelection = z.infer<typeof GridSelectionSchema>;

export const GridStateSchema = z.strictObject({
  sort: z.array(SortKeySchema),
  /**
   * Display order by column name. Empty means file order; columns missing
   * from a non-empty list follow in file order.
   */
  columnOrder: z.array(ColumnNameSchema),
  /** Widths the person or agent set; other columns use their default width. */
  columnWidths: z.array(GridColumnWidthSchema),
  /**
   * The selected cell range, or null. View state: changing it is not an undo
   * entry (`setSelection` is `undoable: false`), and rows refer to the current
   * view, so the app clears it whenever the sort, filters or data change.
   * Kept in the store so `get_state` and agents can read and drive it.
   */
  selection: GridSelectionSchema.nullable(),
});
export type GridState = z.infer<typeof GridStateSchema>;

export function createInitialGridState(): GridState {
  return { sort: [], columnOrder: [], columnWidths: [], selection: null };
}

/** Column names in display order: `grid.columnOrder` first (known names only), then the rest in file order. */
export function gridColumnOrder(state: {
  readonly columns: readonly Pick<ColumnState, 'name'>[];
  readonly grid: { readonly columnOrder: readonly string[] };
}): string[] {
  const known = new Set(state.columns.map((column) => column.name));
  const ordered = state.grid.columnOrder.filter((name) => known.delete(name));
  for (const column of state.columns) if (known.has(column.name)) ordered.push(column.name);
  return ordered;
}

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

/** How a selection was made: a brush (ranges), a click on marks (values) or a filter set directly. */
export const SelectionSourceSchema = z.enum(['brush', 'click', 'filter']);
export type SelectionSource = z.infer<typeof SelectionSourceSchema>;

/** The chart channel a clause selects on; null for the grid and for filters not on an axis. */
export const SelectionChannelSchema = z.enum(['x', 'y']);
export type SelectionChannel = z.infer<typeof SelectionChannelSchema>;

export const SelectionClauseSchema = z.strictObject({
  channel: SelectionChannelSchema.nullable(),
  filter: FilterSchema,
});
export type SelectionClause = z.infer<typeof SelectionClauseSchema>;

/**
 * A view's selection: one clause per brushed axis (a 2-D brush has two
 * ranges), ANDed. Every other view queries with it; the owning view does not.
 */
export const SelectionSchema = z.strictObject({
  source: SelectionSourceSchema,
  clauses: z.array(SelectionClauseSchema).min(1).max(2),
});
export type Selection = z.infer<typeof SelectionSchema>;

/** A filter chip not tied to a view (the "+ Filter" editor, or an agent): applies to every view. */
export const UserFilterSchema = z.strictObject({
  id: SafeIdSchema,
  filter: FilterSchema,
});
export type UserFilter = z.infer<typeof UserFilterSchema>;

/** Most filters not tied to a view a workspace may hold. */
export const MAX_USER_FILTERS = 64;

/** Main's opaque id for a `.glassgrid` file a window opened or saved. The path stays in main. */
export const DocumentIdSchema = z.string().regex(/^doc_[A-Za-z0-9-]{8,64}$/, 'Invalid document id');
export type DocumentId = z.infer<typeof DocumentIdSchema>;

/** Digest of a workspace's persisted subset (`persistedDigest`): 16 lowercase hex digits. */
export const WorkspaceDigestSchema = z.string().regex(/^[0-9a-f]{16}$/, 'Invalid workspace digest');

/**
 * Which `.glassgrid` file the workspace belongs to and what it held when last
 * saved or opened, so `isWorkspaceDirty` can tell whether there is unsaved
 * work. Set by `openFile` (untitled, clean), `loadWorkspace` and
 * `markWorkspaceSaved`; never written to the file itself.
 */
export const WorkspaceDocumentSchema = z.strictObject({
  /** The file's id in main, or null for an untitled workspace. */
  id: DocumentIdSchema.nullable(),
  /** The file's display name (e.g. `sales.glassgrid`), or null for an untitled workspace. */
  fileName: z.string().min(1).max(1024).nullable(),
  /** `persistedDigest` of the workspace as last saved or opened; null when it has never been saved (always dirty). */
  savedDigest: WorkspaceDigestSchema.nullable(),
});
export type WorkspaceDocument = z.infer<typeof WorkspaceDocumentSchema>;

export const WorkspaceStateSchema = z.strictObject({
  dataSource: DataSourceSchema.nullable(),
  columns: z.array(ColumnStateSchema),
  charts: z.array(ChartStateSchema),
  /**
   * One selection per view (chart id or "grid"); see Cross-filtering. Each
   * view queries with every selection except its own, plus `userFilters`.
   */
  selections: z.record(ViewIdSchema, SelectionSchema),
  /** Filters that apply to every view, in the order they were added. */
  userFilters: z.array(UserFilterSchema).max(MAX_USER_FILTERS),
  grid: GridStateSchema,
  layout: LayoutStateSchema,
  /**
   * The workspace file this state belongs to (see `WorkspaceDocumentSchema`).
   * Absent until a file is opened; an absent document with a data source
   * counts as unsaved work.
   */
  document: WorkspaceDocumentSchema.optional(),
});
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

/** A fresh, empty workspace. Returns a new object on every call. */
export function createInitialWorkspaceState(): WorkspaceState {
  return {
    dataSource: null,
    columns: [],
    charts: [],
    selections: {},
    userFilters: [],
    grid: createInitialGridState(),
    layout: { cards: [] },
  };
}

/** The type the grid and compiler should use for a column. */
export function effectiveColumnType(column: Pick<ColumnState, 'inferredType' | 'typeOverride'>): ColumnType {
  return column.typeOverride ?? column.inferredType;
}

/** The column's profile summary if it is current (computed for the column's effective type). */
export function currentProfile(column: Pick<ColumnState, 'inferredType' | 'typeOverride' | 'profile'>): ColumnProfileSummary | null {
  const profile = column.profile;
  return profile !== undefined && profile.type === effectiveColumnType(column) ? profile : null;
}
