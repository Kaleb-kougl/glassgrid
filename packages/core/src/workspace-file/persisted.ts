import { z } from 'zod';
import { MAX_CHARTS } from '../commands/builtins/charts.js';
import { FingerprintSchema } from '../protocol/engine.js';
import type { ChartSpec } from '../spec/chart.js';
import { ColumnTypeSchema, type ColumnType } from '../spec/column.js';
import { SortKeySchema } from '../spec/rows.js';
import {
  ChartStateSchema,
  ColumnNameSchema,
  DataSourceSchema,
  GRID_VIEW_ID,
  GridColumnWidthSchema,
  LayoutStateSchema,
  MAX_USER_FILTERS,
  SelectionSchema,
  UserFilterSchema,
  ViewIdSchema,
  type ChartState,
  type LayoutCard,
  type Selection,
  type WorkspaceDocument,
  type WorkspaceState,
} from '../state/workspace.js';
import { FileHandleSchema } from '../ids.js';
import { canonicalJson, digestString } from './digest.js';

/*
 * What of a workspace is the user's work, and therefore saved:
 *
 *   saved                                   not saved (and why)
 *   ─────────────────────────────────────   ───────────────────────────────────────────────
 *   columns: name, inferred type, override  column profiles (recomputed from the data)
 *   charts: id, spec, title                 grid cell selection (view state; rows refer to
 *   layout cards                              the current view and go stale)
 *   selections (brushes, clicks, filters)   undo history, the data handle (per session)
 *   user filters ("+ Filter" chips)         the document id and saved digest (main's)
 *   grid sort, column order, column widths  AI and MCP settings, raw-row access (app state)
 *
 * The data file itself is referenced by the file format's `data` block
 * (paths + fingerprint), never copied.
 */

/** A column as saved: its name, what the engine inferred, and the user's override. */
export const PersistedColumnSchema = z.strictObject({
  name: ColumnNameSchema,
  /** What the engine inferred when the workspace was saved; compared with the data on open. */
  inferredType: ColumnTypeSchema,
  typeOverride: ColumnTypeSchema.nullable(),
});
export type PersistedColumn = z.infer<typeof PersistedColumnSchema>;

/** The grid as saved: everything but the cell selection. */
export const PersistedGridSchema = z.strictObject({
  sort: z.array(SortKeySchema).max(64),
  columnOrder: z.array(ColumnNameSchema).max(10_000),
  columnWidths: z.array(GridColumnWidthSchema).max(10_000),
});
export type PersistedGrid = z.infer<typeof PersistedGridSchema>;

const MAX_COLUMNS = 10_000;

/** The persisted subset of `WorkspaceState` (the `workspace` block of a `.glassgrid` file). */
export const PersistedWorkspaceSchema = z
  .strictObject({
    columns: z.array(PersistedColumnSchema).max(MAX_COLUMNS),
    charts: z.array(ChartStateSchema).max(MAX_CHARTS),
    /** One selection per view (chart id or "grid"): brushes and clicks are part of the analysis. */
    selections: z.record(ViewIdSchema, SelectionSchema),
    userFilters: z.array(UserFilterSchema).max(MAX_USER_FILTERS),
    grid: PersistedGridSchema,
    layout: LayoutStateSchema,
  })
  .superRefine((workspace, ctx) => {
    const duplicate = (values: readonly string[]): string | undefined => {
      const seen = new Set<string>();
      return values.find((value) => (seen.has(value) ? true : (seen.add(value), false)));
    };
    const column = duplicate(workspace.columns.map((c) => c.name));
    if (column !== undefined) ctx.addIssue({ code: 'custom', path: ['columns'], message: `Column ${JSON.stringify(column)} appears twice` });
    const chart = duplicate(workspace.charts.map((c) => c.id));
    if (chart !== undefined) ctx.addIssue({ code: 'custom', path: ['charts'], message: `Chart id ${JSON.stringify(chart)} appears twice` });
    const filter = duplicate(workspace.userFilters.map((f) => f.id));
    if (filter !== undefined) ctx.addIssue({ code: 'custom', path: ['userFilters'], message: `Filter id ${JSON.stringify(filter)} appears twice` });
  });
export type PersistedWorkspace = z.infer<typeof PersistedWorkspaceSchema>;

/**
 * What the renderer hands main to save or autosave: the data source (by
 * handle; main knows its path) and the persisted subset. Plain JSON.
 */
export const WorkspaceSnapshotSchema = z.strictObject({
  dataSource: DataSourceSchema,
  workspace: PersistedWorkspaceSchema,
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

/** The persisted subset of a state. Drops profiles, the grid selection, the data handle and the document. */
export function persistedWorkspace(state: WorkspaceState): PersistedWorkspace {
  return {
    columns: state.columns.map((column) => ({
      name: column.name,
      inferredType: column.inferredType,
      typeOverride: column.typeOverride,
    })),
    charts: state.charts.map((chart) => structuredCloneJson(chart)),
    selections: structuredCloneJson(state.selections),
    userFilters: structuredCloneJson(state.userFilters),
    grid: {
      sort: structuredCloneJson(state.grid.sort),
      columnOrder: [...state.grid.columnOrder],
      columnWidths: structuredCloneJson(state.grid.columnWidths),
    },
    layout: structuredCloneJson(state.layout),
  };
}

/** The snapshot main needs to save `state`. Throws when no data file is open (there is nothing to save). */
export function snapshotWorkspace(state: WorkspaceState): WorkspaceSnapshot {
  if (state.dataSource === null) throw new Error('No file is open, so there is no workspace to save');
  return { dataSource: structuredCloneJson(state.dataSource), workspace: persistedWorkspace(state) };
}

/** Digest of a persisted subset; equal subsets (whatever their key order) give equal digests. */
export function digestPersisted(workspace: PersistedWorkspace): string {
  return digestString(canonicalJson(workspace));
}

/** `digestPersisted(persistedWorkspace(state))`. */
export function persistedDigest(state: WorkspaceState): string {
  return digestPersisted(persistedWorkspace(state));
}

/**
 * Whether the workspace has work that is not in its file: a data file is open
 * and the persisted subset differs from what was last saved or opened (or was
 * never saved). Profiles, the grid selection and undo history do not count.
 * Undoing back to the saved state makes it clean again.
 */
export function isWorkspaceDirty(state: WorkspaceState): boolean {
  if (state.dataSource === null) return false;
  const saved = state.document?.savedDigest ?? null;
  return saved === null || persistedDigest(state) !== saved;
}

// ---------------------------------------------------------------------------
// Restoring a saved workspace over freshly opened data

export const WorkspaceWarningCodeSchema = z.enum([
  /** The file was written in an older format and upgraded in memory. */
  'migrated',
  /** A saved column is not in the data any more; what used it was dropped. */
  'column_missing',
  /** The data has columns the workspace did not know about (they are shown). */
  'column_added',
  /** The engine now infers a different type for a saved column. */
  'column_type_changed',
  'chart_dropped',
  'selection_dropped',
  'filter_dropped',
  /** Sort keys, widths or order entries for missing columns were dropped. */
  'grid_trimmed',
  /** Cards were added, deduplicated or removed so every chart has exactly one. */
  'layout_repaired',
]);
export type WorkspaceWarningCode = z.infer<typeof WorkspaceWarningCodeSchema>;

export const WorkspaceWarningSchema = z.strictObject({
  code: WorkspaceWarningCodeSchema,
  /** One sentence for the person (and an agent): what changed and why. */
  message: z.string(),
});
export type WorkspaceWarning = z.infer<typeof WorkspaceWarningSchema>;

/** The data a saved workspace is restored over: what the engine reported when it opened the file. */
export const OpenedDataSchema = z.strictObject({
  handleId: FileHandleSchema,
  fileName: z.string().min(1).max(1024),
  fingerprint: FingerprintSchema,
  columns: z
    .array(z.strictObject({ name: ColumnNameSchema, type: ColumnTypeSchema }))
    .max(MAX_COLUMNS)
    .refine((columns) => new Set(columns.map((column) => column.name)).size === columns.length, {
      message: 'Column names must be unique',
    }),
});
export type OpenedData = z.infer<typeof OpenedDataSchema>;

const MAX_NAMED = 8;

function names(values: readonly string[]): string {
  const shown = values.slice(0, MAX_NAMED).map((value) => JSON.stringify(value));
  return values.length > MAX_NAMED ? `${shown.join(', ')} and ${values.length - MAX_NAMED} more` : shown.join(', ');
}

function chartColumns(spec: ChartSpec): string[] {
  const columns = [spec.x.column];
  if (spec.y) columns.push(spec.y.column);
  if (spec.color) columns.push(spec.color.column);
  for (const filter of spec.filters) columns.push(filter.column);
  return columns;
}

function chartLabel(chart: ChartState): string {
  return chart.title === undefined ? `chart ${JSON.stringify(chart.id)}` : `chart ${JSON.stringify(chart.title)}`;
}

/**
 * Builds the workspace state for a saved workspace opened over `data` (the
 * engine's view of the file found by relinking). The data decides which
 * columns exist and their inferred types; the saved workspace contributes
 * type overrides, charts, selections, filters, grid settings and layout.
 * Anything that refers to a column the data no longer has is dropped, with
 * a warning, so the result is always a valid state. Profiles and the grid
 * selection start empty.
 *
 * Pure and deterministic: `loadWorkspace` runs it in `apply`, and the host
 * may run it first to show the warnings.
 */
export function restoreWorkspace(
  saved: PersistedWorkspace,
  data: OpenedData,
  document: WorkspaceDocument,
): { state: WorkspaceState; warnings: WorkspaceWarning[] } {
  const warnings: WorkspaceWarning[] = [];
  const savedColumns = new Map(saved.columns.map((column) => [column.name, column]));
  const known = new Set(data.columns.map((column) => column.name));

  const typeChanged: string[] = [];
  const columns = data.columns.map((column) => {
    const before = savedColumns.get(column.name);
    if (before !== undefined && before.inferredType !== column.type) typeChanged.push(column.name);
    const override: ColumnType | null = before?.typeOverride ?? null;
    return { name: column.name, inferredType: column.type, typeOverride: override === column.type ? null : override };
  });
  const missing = saved.columns.filter((column) => !known.has(column.name)).map((column) => column.name);
  const added = data.columns.filter((column) => !savedColumns.has(column.name)).map((column) => column.name);
  if (missing.length > 0) {
    warnings.push({ code: 'column_missing', message: `The data no longer has ${missing.length === 1 ? 'column' : 'columns'} ${names(missing)}` });
  }
  if (added.length > 0 && saved.columns.length > 0) {
    warnings.push({ code: 'column_added', message: `The data has new ${added.length === 1 ? 'column' : 'columns'} ${names(added)}` });
  }
  if (typeChanged.length > 0) {
    warnings.push({
      code: 'column_type_changed',
      message: `The data's type changed for ${names(typeChanged)}; type overrides still apply, charts may need a new field`,
    });
  }

  const charts: ChartState[] = [];
  for (const chart of saved.charts) {
    const gone = [...new Set(chartColumns(chart.spec).filter((name) => !known.has(name)))];
    if (gone.length > 0) {
      warnings.push({ code: 'chart_dropped', message: `Removed ${chartLabel(chart)}: it uses ${names(gone)}, which the data no longer has` });
    } else {
      charts.push(structuredCloneJson(chart));
    }
  }
  const chartIds = new Set(charts.map((chart) => chart.id));
  const droppedCharts = new Set(saved.charts.map((chart) => chart.id).filter((id) => !chartIds.has(id)));

  const selections: Record<string, Selection> = {};
  for (const [view, selection] of Object.entries(saved.selections)) {
    if (droppedCharts.has(view)) continue; // already reported with the chart
    if (view !== GRID_VIEW_ID && !chartIds.has(view)) {
      warnings.push({ code: 'selection_dropped', message: `Removed a selection on ${JSON.stringify(view)}, which is not a chart in this workspace` });
      continue;
    }
    const gone = selection.clauses.map((clause) => clause.filter.column).filter((name) => !known.has(name));
    if (gone.length > 0) {
      warnings.push({ code: 'selection_dropped', message: `Removed a selection on ${names([...new Set(gone)])}, which the data no longer has` });
      continue;
    }
    selections[view] = structuredCloneJson(selection);
  }

  const userFilters = saved.userFilters.filter((entry) => {
    if (known.has(entry.filter.column)) return true;
    warnings.push({ code: 'filter_dropped', message: `Removed the filter on ${JSON.stringify(entry.filter.column)}, which the data no longer has` });
    return false;
  });

  const sort = saved.grid.sort.filter((key) => known.has(key.column));
  const columnOrder = saved.grid.columnOrder.filter((name) => known.has(name));
  const columnWidths = saved.grid.columnWidths.filter((entry) => known.has(entry.column));
  if (sort.length !== saved.grid.sort.length) {
    warnings.push({ code: 'grid_trimmed', message: 'The grid sort used columns the data no longer has; they were removed from the sort' });
  }

  const cards: LayoutCard[] = [];
  const placed = new Set<string>();
  let repaired = false;
  for (const card of saved.layout.cards) {
    if (!chartIds.has(card.chartId) || placed.has(card.chartId)) {
      repaired ||= !droppedCharts.has(card.chartId);
      continue;
    }
    placed.add(card.chartId);
    cards.push({ ...card });
  }
  for (const chart of charts) {
    if (placed.has(chart.id)) continue;
    const y = cards.reduce((bottom, card) => Math.max(bottom, card.y + card.h), 0);
    cards.push({ chartId: chart.id, x: 0, y, w: 1, h: 1 });
    repaired = true;
  }
  if (repaired) warnings.push({ code: 'layout_repaired', message: 'Some chart cards were missing or duplicated in the layout and were rearranged' });

  const state: WorkspaceState = {
    dataSource: { handleId: data.handleId, fileName: data.fileName, fingerprint: { ...data.fingerprint } },
    columns,
    charts,
    selections,
    userFilters: structuredCloneJson(userFilters),
    grid: { sort: structuredCloneJson(sort), columnOrder, columnWidths: structuredCloneJson(columnWidths), selection: null },
    layout: { cards },
    document: { ...document },
  };
  return { state, warnings };
}

/** Deep copy of plain JSON data (state is frozen by the store; restored state must not share it). */
function structuredCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
