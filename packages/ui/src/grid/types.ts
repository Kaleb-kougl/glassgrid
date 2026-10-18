import type { ColumnType } from '@glassgrid/core';

/** A grid column as shown: name, logical type and width in px (padding included). */
export interface GridColumn {
  readonly name: string;
  readonly type: ColumnType;
  /** Width in px, including padding. */
  readonly width: number;
}

/**
 * A cell as displayed: its formatted text, or `null` for SQL NULL. Data
 * sources return `undefined` for a cell whose page has not arrived yet.
 */
export type GridCell = string | null;

export interface GridCellRef {
  readonly row: number;
  readonly col: number;
}

/** A range selection: `anchor` is where it started, `focus` is the focused cell. */
export interface GridSelection {
  readonly anchor: GridCellRef;
  readonly focus: GridCellRef;
}

/** A selection as an inclusive rectangle (rows and display columns). */
export interface GridRange {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** What changed in a data source; listeners repaint the rows it touches. */
export type GridSourceChange =
  /** Rows `firstRow..lastRow` (inclusive) arrived. */
  | { readonly kind: 'rows'; readonly firstRow: number; readonly lastRow: number }
  /** Everything was dropped: a new view (sort or filters), possibly with a new row count or columns. */
  | { readonly kind: 'reset' }
  /** The row count changed (e.g. the count arrived after the first page); loaded rows stay. */
  | { readonly kind: 'resize' }
  /** A page failed to load; it is retried on a later `ensureRange`. */
  | { readonly kind: 'error'; readonly firstRow: number; readonly lastRow: number; readonly error: unknown };

export type GridSourceListener = (change: GridSourceChange) => void;

/**
 * Where the canvas grid gets its rows. Engine-agnostic: the app adapts its
 * query service to this (see `ArrowPagedSource`), tests and benchmarks use
 * `SyntheticSource`.
 *
 * `getCell` is called for every visible cell on every frame, so it must be a
 * cheap, allocation-free lookup into already formatted values.
 */
export interface GridDataSource {
  /** Rows in the current view (after filters). */
  readonly rowCount: number;
  /** Columns in source order; `getCell`'s `col` indexes this list. */
  readonly columns: readonly GridColumn[];
  /** The cell's display value, `null` for SQL NULL, `undefined` while its page is not loaded. */
  getCell(row: number, col: number): GridCell | undefined;
  /**
   * The rows the grid shows right now (visible window plus overscan). The
   * source fetches the pages covering them, debounced and coalesced, and
   * cancels requests for pages that are no longer wanted.
   */
  ensureRange(firstRow: number, lastRow: number): void;
  /**
   * Loads every page covering `firstRow..lastRow` and resolves once all of
   * them are cached (for copy). Not cancelled by later `ensureRange` calls;
   * rejects when `signal` aborts or the source resets.
   */
  loadRange(firstRow: number, lastRow: number, signal?: AbortSignal): Promise<void>;
  /** Called on page arrival, reset and errors. Returns an unsubscribe function. */
  subscribe(listener: GridSourceListener): () => void;
}
