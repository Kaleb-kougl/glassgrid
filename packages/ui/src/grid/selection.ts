import type { GridCell, GridCellRef, GridRange, GridSelection } from './types.js';

/** The selection as an inclusive rectangle, or null. */
export function normalizeSelection(selection: GridSelection | null): GridRange | null {
  if (!selection) return null;
  const { anchor, focus } = selection;
  return {
    top: Math.min(anchor.row, focus.row),
    bottom: Math.max(anchor.row, focus.row),
    left: Math.min(anchor.col, focus.col),
    right: Math.max(anchor.col, focus.col),
  };
}

function clampCell(cell: GridCellRef, rowCount: number, colCount: number): GridCellRef {
  const row = Math.max(0, Math.min(rowCount - 1, cell.row));
  const col = Math.max(0, Math.min(colCount - 1, cell.col));
  return row === cell.row && col === cell.col ? cell : { row, col };
}

/**
 * Keeps a selection inside the grid after the row count or columns change;
 * null when the grid is empty. Returns the same object when nothing moved.
 */
export function clampSelection(selection: GridSelection | null, rowCount: number, colCount: number): GridSelection | null {
  if (!selection) return null;
  if (rowCount <= 0 || colCount <= 0) return null;
  const anchor = clampCell(selection.anchor, rowCount, colCount);
  const focus = clampCell(selection.focus, rowCount, colCount);
  return anchor === selection.anchor && focus === selection.focus ? selection : { anchor, focus };
}

export function selectionContains(range: GridRange | null, row: number, col: number): boolean {
  return range !== null && row >= range.top && row <= range.bottom && col >= range.left && col <= range.right;
}

export function sameSelection(a: GridSelection | null, b: GridSelection | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.anchor.row === b.anchor.row && a.anchor.col === b.anchor.col && a.focus.row === b.focus.row && a.focus.col === b.focus.col;
}

/** A single-cell selection. */
export function cellSelection(row: number, col: number): GridSelection {
  const cell = { row, col };
  return { anchor: cell, focus: cell };
}

export type GridMove =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'pageUp'
  | 'pageDown'
  | 'rowStart'
  | 'rowEnd'
  | 'gridStart'
  | 'gridEnd'
  | 'top'
  | 'bottom'
  | 'firstColumn'
  | 'lastColumn';

export interface KeyLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/**
 * The move a key press asks for (spreadsheet conventions): arrows,
 * Page Up/Down, Home/End within the row, Cmd/Ctrl+Home/End to the first and
 * last cell, Cmd/Ctrl+arrows to the edge. Shift extends the selection.
 */
export function keyToMove(event: KeyLike): { move: GridMove; extend: boolean } | null {
  if (event.altKey) return null;
  const mod = event.metaKey || event.ctrlKey;
  const extend = event.shiftKey;
  let move: GridMove;
  switch (event.key) {
    case 'ArrowUp':
      move = mod ? 'top' : 'up';
      break;
    case 'ArrowDown':
      move = mod ? 'bottom' : 'down';
      break;
    case 'ArrowLeft':
      move = mod ? 'firstColumn' : 'left';
      break;
    case 'ArrowRight':
      move = mod ? 'lastColumn' : 'right';
      break;
    case 'PageUp':
      move = 'pageUp';
      break;
    case 'PageDown':
      move = 'pageDown';
      break;
    case 'Home':
      move = mod ? 'gridStart' : 'rowStart';
      break;
    case 'End':
      move = mod ? 'gridEnd' : 'rowEnd';
      break;
    default:
      return null;
  }
  return { move, extend };
}

export interface MoveContext {
  readonly rowCount: number;
  readonly colCount: number;
  /** Rows per Page Up/Down. */
  readonly pageRows: number;
  /** Where focus starts when there is no selection yet (usually the top visible row). */
  readonly fallback: GridCellRef;
}

/** The selection after a keyboard move; extends from the anchor when `extend`. Null on an empty grid. */
export function moveSelection(selection: GridSelection | null, move: GridMove, extend: boolean, context: MoveContext): GridSelection | null {
  const { rowCount, colCount, pageRows } = context;
  if (rowCount <= 0 || colCount <= 0) return null;
  const focus = selection?.focus ?? context.fallback;
  if (!selection) {
    // First key press focuses the fallback cell without moving.
    return { anchor: clampCell(focus, rowCount, colCount), focus: clampCell(focus, rowCount, colCount) };
  }
  let { row, col } = focus;
  switch (move) {
    case 'up':
      row -= 1;
      break;
    case 'down':
      row += 1;
      break;
    case 'left':
      col -= 1;
      break;
    case 'right':
      col += 1;
      break;
    case 'pageUp':
      row -= pageRows;
      break;
    case 'pageDown':
      row += pageRows;
      break;
    case 'rowStart':
    case 'firstColumn':
      col = 0;
      break;
    case 'rowEnd':
    case 'lastColumn':
      col = colCount - 1;
      break;
    case 'gridStart':
      row = 0;
      col = 0;
      break;
    case 'gridEnd':
      row = rowCount - 1;
      col = colCount - 1;
      break;
    case 'top':
      row = 0;
      break;
    case 'bottom':
      row = rowCount - 1;
      break;
  }
  const target = clampCell({ row, col }, rowCount, colCount);
  return { anchor: extend ? selection.anchor : target, focus: target };
}

/* --------------------------------------------------------------------------
 * Copy as TSV
 */

/** Copies stop at this many rows… */
export const MAX_COPY_ROWS = 10_000;
/** …or this many cells, whichever comes first. */
export const MAX_COPY_CELLS = 250_000;

/**
 * One TSV field. NULL is an empty field; values with a tab, newline,
 * carriage return or double quote are quoted with inner quotes doubled, the
 * convention Excel, Numbers and Google Sheets read back on paste.
 */
export function tsvField(value: GridCell | undefined): string {
  if (value === null || value === undefined) return '';
  if (!/[\t\n\r"]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export interface TsvResult {
  readonly text: string;
  /** Rows and columns actually copied. */
  readonly rows: number;
  readonly columns: number;
  /** Rows in the selection. */
  readonly selectedRows: number;
  /** True when the copy stopped at `MAX_COPY_ROWS` / `MAX_COPY_CELLS`. */
  readonly truncated: boolean;
}

export interface TsvLimits {
  readonly maxRows?: number;
  readonly maxCells?: number;
}

/** Rows of `range` that a copy includes, given the limits. */
export function copyRowCount(range: GridRange, limits: TsvLimits = {}): number {
  const columns = range.right - range.left + 1;
  const maxRows = Math.min(limits.maxRows ?? MAX_COPY_ROWS, Math.floor((limits.maxCells ?? MAX_COPY_CELLS) / Math.max(1, columns)));
  return Math.max(0, Math.min(range.bottom - range.top + 1, Math.max(1, maxRows)));
}

/**
 * The selected range as TSV (no header row), reading display values through
 * `cell(row, displayCol)`. Stops at the copy limits; unloaded cells copy as
 * empty fields (callers load the rows first, see `GridDataSource.loadRange`).
 */
export function rangeToTsv(range: GridRange, cell: (row: number, col: number) => GridCell | undefined, limits: TsvLimits = {}): TsvResult {
  const selectedRows = range.bottom - range.top + 1;
  const rows = copyRowCount(range, limits);
  const lines: string[] = [];
  for (let r = range.top; r < range.top + rows; r += 1) {
    const fields: string[] = [];
    for (let c = range.left; c <= range.right; c += 1) fields.push(tsvField(cell(r, c)));
    lines.push(fields.join('\t'));
  }
  return {
    text: lines.join('\n'),
    rows,
    columns: range.right - range.left + 1,
    selectedRows,
    truncated: rows < selectedRows,
  };
}
