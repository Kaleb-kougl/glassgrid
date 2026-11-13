import type { Table } from 'apache-arrow';
import {
  effectiveColumnType,
  effectiveFilters,
  GRID_VIEW_ID,
  gridColumnOrder,
  type ColumnState,
  type Filter,
  type GridSelection,
  type GridState,
  type SortKey,
  type TableId,
  type WorkspaceState,
} from '@glassgrid/core';
import {
  ArrowPagedSource,
  columnWidthFor,
  PAGE_SIZE,
  type GridColumn,
  type GridSelection as IndexSelection,
} from '@glassgrid/ui';
import type { EngineClientLike, FetchPage, RowsResult } from '../engine';

/*
 * The grid's side of the workspace: which rows the canvas grid pages from
 * the engine (one ArrowPagedSource per table, reset whenever the view
 * changes) and how the store's column order, widths and name-based selection
 * map onto the grid's display indexes.
 */

/** Columns in file order with their effective types: what the engine returns per page. */
export function sourceColumns(columns: readonly ColumnState[]): GridColumn[] {
  return columns.map((column) => {
    const type = effectiveColumnType(column);
    return { name: column.name, type, width: columnWidthFor(column.name, type) };
  });
}

/** Columns as the grid shows them: `grid.columnOrder`, with the widths people set. */
export function displayColumns(columns: readonly ColumnState[], grid: Pick<GridState, 'columnOrder' | 'columnWidths'>): GridColumn[] {
  const byName = new Map(columns.map((column) => [column.name, column]));
  const widths = new Map(grid.columnWidths.map((entry) => [entry.column, entry.width]));
  return gridColumnOrder({ columns, grid }).map((name) => {
    const column = byName.get(name) as ColumnState;
    const type = effectiveColumnType(column);
    return { name, type, width: widths.get(name) ?? columnWidthFor(name, type) };
  });
}

/** The store's selection (columns by name) as the grid's (display indexes); null when a column is gone. */
export function toIndexSelection(selection: GridSelection | null, columns: readonly Pick<GridColumn, 'name'>[]): IndexSelection | null {
  if (!selection) return null;
  const anchor = columns.findIndex((column) => column.name === selection.anchor.column);
  const focus = columns.findIndex((column) => column.name === selection.focus.column);
  if (anchor < 0 || focus < 0) return null;
  return { anchor: { row: selection.anchor.row, col: anchor }, focus: { row: selection.focus.row, col: focus } };
}

/** The grid's selection as the store keeps it. */
export function fromIndexSelection(selection: IndexSelection | null, columns: readonly Pick<GridColumn, 'name'>[]): GridSelection | null {
  if (!selection) return null;
  const anchor = columns[selection.anchor.col]?.name;
  const focus = columns[selection.focus.col]?.name;
  if (anchor === undefined || focus === undefined) return null;
  return { anchor: { row: selection.anchor.row, column: anchor }, focus: { row: selection.focus.row, column: focus } };
}

/** Columns the selection covers, in display order (the column list marks them selected). */
export function selectedColumnNames(selection: GridSelection | null, columns: readonly Pick<GridColumn, 'name'>[]): string[] {
  const range = toIndexSelection(selection, columns);
  if (!range) return [];
  const left = Math.min(range.anchor.col, range.focus.col);
  const right = Math.max(range.anchor.col, range.focus.col);
  return columns.slice(left, right + 1).map((column) => column.name);
}

/** What the grid shows: anything that changes which rows sit at which index, or how they read. */
export interface GridView {
  readonly sort: readonly SortKey[];
  readonly filters: readonly Filter[];
  /** Bumped when the engine's data for the table changed (type overrides applied, engine restarted). */
  readonly dataVersion: number;
  /** File order, effective types. */
  readonly columns: readonly GridColumn[];
  /** Rows in the view once counted; null while unknown. */
  readonly rowCount: number | null;
  /**
   * What the person asked the grid to show (sort, their filters and
   * selections, column types), without what moves on its own (a map's
   * viewport, the time window, new live data). A new view with the same
   * intent keeps the grid's scroll position and selection; a new intent
   * sends it back to the top. Undefined: every new view is a new intent.
   */
  readonly intent?: string | undefined;
}

/**
 * The grid's intent (GridView.intent) in a workspace: its sort, the user
 * filters and every selection but its own, each map's "Filter to map view"
 * switch, "Charts follow time" and the column types; not the maps'
 * viewports, the time window's position or the data version, which move on
 * their own.
 */
export function gridIntentKey(
  state: Pick<WorkspaceState, 'charts' | 'selections' | 'userFilters' | 'maps' | 'chartsFollowTime'> & { readonly grid: Pick<GridState, 'sort'> },
  columns: readonly Pick<GridColumn, 'name' | 'type'>[],
): string {
  return JSON.stringify([
    state.grid.sort,
    effectiveFilters({ charts: state.charts, selections: state.selections, userFilters: state.userFilters }, GRID_VIEW_ID),
    state.maps.map((map) => map.filterToView !== false),
    state.chartsFollowTime === true,
    columns.map((column) => [column.name, column.type]),
  ]);
}

/**
 * The canvas grid's data source for one table. Pages come from
 * `engine.pageFetcher(table, { viewId: 'grid', sort, filters })`; a new sort,
 * filter set, type change or engine restart is a new view, which resets the
 * source (pages dropped, requests aborted, the grid back at the top with
 * nothing selected, unless only what moves on its own changed: `intent`). Until the count arrives the view shows one page; a
 * first page shorter than that is the whole view.
 */
export class EngineGridSource {
  readonly source: ArrowPagedSource;
  private readonly firstPageListeners = new Set<(result: RowsResult) => void>();
  private key: string;
  private intent: string | undefined;
  private fetch: FetchPage;

  constructor(
    private readonly engine: Pick<EngineClientLike, 'pageFetcher'>,
    readonly table: TableId,
    view: GridView,
  ) {
    this.key = EngineGridSource.keyOf(view);
    this.intent = view.intent;
    this.fetch = this.fetcherFor(view);
    this.source = new ArrowPagedSource({
      columns: view.columns,
      rowCount: view.rowCount ?? PAGE_SIZE,
      fetchPage: (offset, limit, signal) => this.page(offset, limit, signal),
    });
  }

  private static keyOf(view: GridView): string {
    return JSON.stringify([view.sort, view.filters, view.dataVersion, view.columns.map((column) => [column.name, column.type])]);
  }

  private fetcherFor(view: GridView): FetchPage {
    return this.engine.pageFetcher(this.table, { viewId: 'grid', sort: [...view.sort], filters: view.filters });
  }

  private async page(offset: number, limit: number, signal: AbortSignal): Promise<Table> {
    const key = this.key;
    const result = await this.fetch(offset, limit, signal);
    if (key === this.key && offset === 0) {
      // A short first page is the whole view: no need to wait for the count.
      if (result.table.numRows < limit) this.source.setRowCount(result.table.numRows);
      for (const listener of [...this.firstPageListeners]) listener(result);
    }
    return result.table;
  }

  /** Called with every first page of a view as it arrives (perf marks, unlocking the profile). Returns an unsubscribe function. */
  onFirstPage(listener: (result: RowsResult) => void): () => void {
    this.firstPageListeners.add(listener);
    return () => this.firstPageListeners.delete(listener);
  }

  /**
   * Applies the latest view: resets on a new view (keeping the grid's
   * position when its intent is the same, and the old row count until the
   * new one is known), otherwise takes a newly arrived row count.
   */
  update(view: GridView): 'reset' | 'resized' | 'unchanged' {
    const key = EngineGridSource.keyOf(view);
    if (key !== this.key) {
      const keepPosition = view.intent !== undefined && view.intent === this.intent;
      this.key = key;
      this.intent = view.intent;
      this.fetch = this.fetcherFor(view);
      this.source.reset({ rowCount: view.rowCount ?? (keepPosition ? this.source.rowCount : PAGE_SIZE), columns: view.columns, keepPosition });
      return 'reset';
    }
    if (view.rowCount !== null && view.rowCount !== this.source.rowCount) {
      this.source.setRowCount(view.rowCount);
      return 'resized';
    }
    return 'unchanged';
  }

  /** Aborts everything in flight (the table was replaced or the grid unmounted). */
  cancel(): void {
    this.source.reset();
  }
}
