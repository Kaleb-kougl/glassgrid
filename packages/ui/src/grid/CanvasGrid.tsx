import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import type { SortKey } from '@glassgrid/core';
import { cx } from '../cx.js';
import type { ResolvedTokens } from '../tokens.js';
import { GridController, type GridWindow } from './controller.js';
import { MAX_COLUMN_WIDTH, MAX_SCROLL_HEIGHT, MIN_COLUMN_WIDTH } from './geometry.js';
import { cellSelection, clampSelection, copyRowCount, keyToMove, MAX_COPY_CELLS, MAX_COPY_ROWS, moveSelection, normalizeSelection, rangeToTsv, type TsvLimits, type TsvResult } from './selection.js';
import type { GridColumn, GridDataSource, GridSelection } from './types.js';

export interface GridCopyInfo extends Omit<TsvResult, 'text'> {
  /** What was copied, in words (also announced to screen readers). Says so when the copy limit cut it short. */
  readonly message: string;
}

export interface CanvasGridHandle {
  /** Scrolls the least needed to show a cell (pass -1 for `col` to scroll rows only). */
  scrollCellIntoView(row: number, col?: number): void;
  /** Scrolls so `row` is the first row of the body. */
  scrollToRow(row: number): void;
  /** Copies the selection now (as Cmd/Ctrl+C does). */
  copySelection(): Promise<GridCopyInfo | null>;
  /** Paints synchronously (benchmarks and tests). */
  paintNow(): void;
  /** The rows and columns on screen (the accessibility mirror's window). */
  readonly window: GridWindow;
  readonly controller: GridController | null;
}

export interface CanvasGridProps {
  source: GridDataSource;
  /** Display order and widths; defaults to `source.columns`. Columns are matched to the source by name. */
  columns?: readonly GridColumn[] | undefined;
  /** Resolved tokens of the current theme (canvas cannot read CSS variables). */
  tokens: ResolvedTokens;
  /** Controlled selection (rows and display-column indexes). */
  selection: GridSelection | null;
  onSelectionChange?: ((selection: GridSelection | null) => void) | undefined;
  /** Sort keys, for the header arrows and `aria-sort`. */
  sort?: readonly SortKey[] | undefined;
  /** Header click, or Enter/Space on a focused header. */
  onSortRequest?: ((column: string) => void) | undefined;
  /** End of a header-edge drag (or Alt+Shift+←/→ on a focused header), with the new width in px. */
  onColumnResize?: ((column: string, width: number) => void) | undefined;
  /** Header dragged (or Alt+←/→ on a focused header) from display index `from` to `to`. */
  onColumnReorder?: ((from: number, to: number) => void) | undefined;
  /** Cmd/Ctrl+C. Without it the TSV goes to `navigator.clipboard`. */
  onCopy?: ((tsv: string, info: GridCopyInfo) => void) | undefined;
  /**
   * Cmd/Ctrl+C, handled by the app instead of the grid (e.g. a `copySelection`
   * command that builds the TSV with `copySelectionAsTsv`). When set, the grid
   * neither builds the TSV nor calls `onCopy`; the app reports the outcome.
   */
  onCopyRequest?: (() => void) | undefined;
  /** The window on screen changed (throttled). */
  onVisibleWindowChange?: ((window: GridWindow) => void) | undefined;
  /** Once per source and view: the first frame that showed rows with data. */
  onFirstRowsPainted?: (() => void) | undefined;
  /** Accessible name of the grid. */
  label: string;
  /** Shown when the view has no rows. */
  emptyMessage?: string | undefined;
  /** Largest spacer height before scroll positions are scaled (tests). */
  maxScrollHeight?: number | undefined;
  /** Copy limits (default 10,000 rows / 250,000 cells). */
  copyLimits?: TsvLimits | undefined;
  className?: string | undefined;
  testId?: string | undefined;
  handleRef?: Ref<CanvasGridHandle> | undefined;
}

const numberFormat = new Intl.NumberFormat('en-US');

export function copyMessage(info: Omit<TsvResult, 'text'>, limits: TsvLimits = {}): string {
  const rows = (n: number) => `${numberFormat.format(n)} ${n === 1 ? 'row' : 'rows'}`;
  const columns = `${numberFormat.format(info.columns)} ${info.columns === 1 ? 'column' : 'columns'}`;
  if (!info.truncated) return `Copied ${rows(info.rows)} × ${columns}.`;
  const maxRows = limits.maxRows ?? MAX_COPY_ROWS;
  const maxCells = limits.maxCells ?? MAX_COPY_CELLS;
  return `Copied the first ${rows(info.rows)} of ${numberFormat.format(info.selectedRows)} selected (copy is limited to ${numberFormat.format(maxRows)} rows or ${numberFormat.format(maxCells)} cells).`;
}

/**
 * The selection as TSV, loading the rows it needs first. Exported so a
 * "copy" command can run without a keyboard event.
 */
export async function copySelectionAsTsv(
  source: GridDataSource,
  columns: readonly GridColumn[],
  selection: GridSelection | null,
  options: { signal?: AbortSignal; limits?: TsvLimits } = {},
): Promise<(TsvResult & { message: string }) | null> {
  const range = normalizeSelection(clampSelection(selection, source.rowCount, columns.length));
  if (!range) return null;
  const rows = copyRowCount(range, options.limits);
  await source.loadRange(range.top, range.top + rows - 1, options.signal);
  const index = columns.map((column, i) => {
    const found = source.columns.findIndex((candidate) => candidate.name === column.name);
    return found >= 0 ? found : i;
  });
  const result = rangeToTsv(range, (row, col) => source.getCell(row, index[col] ?? col), options.limits);
  return { ...result, message: copyMessage(result, options.limits) };
}

function sortLabel(sort: readonly SortKey[], column: string): string {
  const index = sort.findIndex((key) => key.column === column);
  if (index < 0) return '';
  const key = sort[index] as SortKey;
  const direction = key.direction === 'asc' ? 'sorted ascending' : 'sorted descending';
  return sort.length > 1 ? `, ${direction}, sort ${index + 1} of ${sort.length}` : `, ${direction}`;
}

/** first..last plus any extra indexes outside it (ignoring negatives), ascending. */
function range(first: number, last: number, ...extras: number[]): number[] {
  const out: number[] = [];
  for (let i = first; i <= last; i += 1) out.push(i);
  let added = false;
  for (const extra of extras) {
    if (extra >= 0 && (extra < first || extra > last) && !out.includes(extra)) {
      out.push(extra);
      added = true;
    }
  }
  if (added) out.sort((a, b) => a - b);
  return out;
}

/**
 * The data grid drawn on one canvas: 1,000-row pages from a
 * `GridDataSource`, only the visible window painted (plus one row and
 * column of overscan), scaled scrolling past the browser's height limit so
 * 50M rows stay reachable, and a visually hidden ARIA grid that mirrors the
 * window on screen and owns keyboard focus.
 *
 * Everything that changes app state (selection, sort, resize, reorder, copy)
 * is a controlled prop plus a callback, so the app can route it through its
 * command registry.
 */
export function CanvasGrid({
  source,
  columns: columnsProp,
  tokens,
  selection,
  onSelectionChange,
  sort = [],
  onSortRequest,
  onColumnResize,
  onColumnReorder,
  onCopy,
  onCopyRequest,
  onVisibleWindowChange,
  onFirstRowsPainted,
  label,
  emptyMessage = 'No rows',
  maxScrollHeight = MAX_SCROLL_HEIGHT,
  copyLimits,
  className,
  testId,
  handleRef,
}: CanvasGridProps) {
  const columns = columnsProp ?? source.columns;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<GridController | null>(null);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [window_, setWindow] = useState<GridWindow>({ firstRow: 0, lastRow: -1, firstCol: 0, lastCol: -1 });
  const [, setDataVersion] = useState(0);
  const [hasFocus, setHasFocus] = useState(false);
  const [headerFocus, setHeaderFocus] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const focusPending = useRef(false);
  const focusing = useRef(false);
  const [, setFocusRequest] = useState(0);

  const painted = useRef<{ source: GridDataSource | null; done: boolean }>({ source: null, done: false });
  const copyAbort = useRef<AbortController | null>(null);

  // Latest props for callbacks invoked from the controller.
  const latest = useRef({ selection, onSelectionChange, onFirstRowsPainted, onVisibleWindowChange });
  useLayoutEffect(() => {
    latest.current = { selection, onSelectionChange, onFirstRowsPainted, onVisibleWindowChange };
  });

  const rowCount = source.rowCount;
  const colCount = columns.length;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const scroller = scrollerRef.current;
    const spacer = spacerRef.current;
    if (!canvas || !scroller || !spacer) return;
    const controller = new GridController(canvas, scroller, spacer);
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    controller.callbacks = {
      onSelectionChange: (next) => latest.current.onSelectionChange?.(next),
      onSortRequest,
      onColumnResize,
      onColumnReorder,
      onWindowChange: (next) => {
        setWindow(next);
        latest.current.onVisibleWindowChange?.(next);
      },
      onDataChange: () => setDataVersion((v) => v + 1),
      onPaint: (loaded) => {
        const state = painted.current;
        if (state.source !== source) {
          state.source = source;
          state.done = false;
        }
        if (!state.done && loaded > 0) {
          state.done = true;
          latest.current.onFirstRowsPainted?.();
        }
      },
      requestFocus: () => {
        // Focus lands on the new focused cell once this render commits.
        focusPending.current = true;
        setHeaderFocus(null);
        setFocusRequest((n) => n + 1);
      },
    };
    controller.setProps({
      source,
      columns,
      tokens,
      selection,
      sort,
      headerFocusCol: hasFocus && headerFocus !== null ? headerFocus : -1,
      hasFocus,
      emptyMessage,
      maxScrollHeight,
    });
  });

  // A new view resets "first rows painted".
  useEffect(
    () =>
      source.subscribe((change) => {
        if (change.kind === 'reset') painted.current.done = false;
      }),
    [source],
  );

  // Keyboard and external selection changes scroll the focused cell into view.
  const focusRow = selection?.focus.row ?? -1;
  const focusCol = selection?.focus.col ?? -1;
  // The previously focused cell stays mirrored, so focus never falls out of the
  // grid while it moves to a cell the throttled window has not caught up with.
  const [focusTrail, setFocusTrail] = useState({ row: focusRow, col: focusCol, previousRow: -1, previousCol: -1 });
  if (focusTrail.row !== focusRow || focusTrail.col !== focusCol) {
    setFocusTrail({ row: focusRow, col: focusCol, previousRow: focusTrail.row, previousCol: focusTrail.col });
  }
  // Only while a cell has focus: once the selection is cleared (e.g. a new view), the old cell is not mirrored.
  const keptFocus = focusRow >= 0 ? { row: focusTrail.previousRow, col: focusTrail.previousCol } : { row: -1, col: -1 };
  useLayoutEffect(() => {
    const controller = controllerRef.current;
    if (!controller || focusRow < 0) return;
    if (controller.consumePointerSelection(latest.current.selection)) return;
    controller.scrollCellIntoView(focusRow, focusCol);
  }, [focusRow, focusCol]);

  // Focus follows the selection inside the mirror (roving tabindex).
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const active = document.activeElement;
    if (!focusPending.current && !(active && grid.contains(active))) return;
    const target =
      headerFocus !== null
        ? document.getElementById(`${id}-h${headerFocus}`)
        : focusRow >= 0
          ? document.getElementById(`${id}-r${focusRow}-c${focusCol}`)
          : grid.querySelector<HTMLElement>('[tabindex="0"]');
    if (target && target !== active) {
      focusing.current = true;
      target.focus({ preventScroll: true });
      focusing.current = false;
    }
    if (target) focusPending.current = false;
  });

  const runCopy = useCallback(async (): Promise<GridCopyInfo | null> => {
    copyAbort.current?.abort();
    const abort = new AbortController();
    copyAbort.current = abort;
    try {
      const result = await copySelectionAsTsv(source, columns, selection, { signal: abort.signal, ...(copyLimits ? { limits: copyLimits } : {}) });
      if (!result || abort.signal.aborted) return null;
      const { text, ...info } = result;
      if (onCopy) onCopy(text, info);
      else void (navigator as Partial<Navigator>).clipboard?.writeText(text);
      setAnnouncement(info.message);
      return info;
    } catch {
      return null;
    }
  }, [source, columns, selection, copyLimits, onCopy]);

  useEffect(() => () => copyAbort.current?.abort(), []);

  useImperativeHandle(
    handleRef,
    () => ({
      scrollCellIntoView: (row, col = -1) => controllerRef.current?.scrollCellIntoView(row, col),
      scrollToRow: (row) => {
        const controller = controllerRef.current;
        if (controller) controller.setVirtualTop(row * controller.frame.rowHeight);
      },
      copySelection: runCopy,
      paintNow: () => controllerRef.current?.paintNow(),
      get window() {
        return controllerRef.current?.window ?? { firstRow: 0, lastRow: -1, firstCol: 0, lastCol: -1 };
      },
      get controller() {
        return controllerRef.current;
      },
    }),
    [runCopy],
  );

  const select = (next: GridSelection | null) => {
    onSelectionChange?.(next);
  };

  const onHeaderKey = (event: KeyboardEvent<HTMLDivElement>, col: number): boolean => {
    const name = columns[col]?.name;
    if (name === undefined) return false;
    const width = columns[col]?.width ?? 0;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const step = event.key === 'ArrowLeft' ? -1 : 1;
        if (event.altKey && event.shiftKey) {
          onColumnResize?.(name, Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width + step * 16)));
          return true;
        }
        const target = Math.max(0, Math.min(colCount - 1, col + step));
        if (event.altKey) {
          if (target !== col) {
            onColumnReorder?.(col, target);
            setHeaderFocus(target);
          }
          return true;
        }
        setHeaderFocus(target);
        controllerRef.current?.scrollCellIntoView(-1, target);
        return true;
      }
      case 'Home':
      case 'End': {
        const target = event.key === 'Home' ? 0 : colCount - 1;
        setHeaderFocus(target);
        controllerRef.current?.scrollCellIntoView(-1, target);
        return true;
      }
      case 'ArrowDown': {
        if (rowCount === 0) return true;
        const row = controllerRef.current?.topLeftCell.row ?? 0;
        setHeaderFocus(null);
        select(cellSelection(row, col));
        return true;
      }
      case 'Enter':
      case ' ':
        onSortRequest?.(name);
        return true;
      default:
        return false;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const controller = controllerRef.current;
    if (!controller) return;
    if (event.key === 'Escape' && controller.cancelDrag()) {
      event.preventDefault();
      return;
    }
    if (headerFocus !== null) {
      if (onHeaderKey(event, headerFocus)) event.preventDefault();
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && (event.key === 'c' || event.key === 'C')) {
      event.preventDefault();
      if (onCopyRequest) onCopyRequest();
      else void runCopy();
      return;
    }
    if (mod && !event.altKey && (event.key === 'a' || event.key === 'A')) {
      event.preventDefault();
      // Everything, with focus on the first cell.
      if (rowCount > 0 && colCount > 0) select({ anchor: { row: rowCount - 1, col: colCount - 1 }, focus: { row: 0, col: 0 } });
      return;
    }
    if (event.key === 'Escape') {
      if (selection && (selection.anchor.row !== selection.focus.row || selection.anchor.col !== selection.focus.col)) {
        event.preventDefault();
        select(cellSelection(selection.focus.row, selection.focus.col));
      }
      return;
    }
    if (event.key === 'ArrowUp' && !event.shiftKey && !mod && selection && selection.focus.row === 0) {
      event.preventDefault();
      setHeaderFocus(selection.focus.col);
      return;
    }
    const move = keyToMove(event);
    if (!move) return;
    event.preventDefault();
    const next = moveSelection(selection, move.move, move.extend, {
      rowCount,
      colCount,
      pageRows: controller.pageRows,
      fallback: controller.topLeftCell,
    });
    if (next) select(next);
  };

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    setHasFocus(true);
    // Focus the grid moved itself already matches the selection.
    if (focusing.current) return;
    const target = event.target as HTMLElement;
    const header = target.dataset['headerCol'];
    if (header !== undefined) {
      setHeaderFocus(Number(header));
      return;
    }
    const row = Number(target.dataset['row']);
    const col = Number(target.dataset['col']);
    if (target.dataset['row'] === undefined || !Number.isFinite(row) || !Number.isFinite(col)) return;
    setHeaderFocus(null);
    if (!selection || selection.focus.row !== row || selection.focus.col !== col) select(cellSelection(row, col));
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setHasFocus(false);
  };

  // ---- Accessibility mirror: the window on screen, plus the focused cell. ----
  const range_ = normalizeSelection(selection);
  const lastRow = Math.min(rowCount - 1, window_.lastRow);
  const lastCol = Math.min(colCount - 1, window_.lastCol);
  const inRows = (row: number) => (row < rowCount ? row : -1);
  const inCols = (col: number) => (col < colCount ? col : -1);
  const mirrorRows = rowCount > 0 ? range(Math.max(0, window_.firstRow), lastRow, inRows(focusRow), inRows(keptFocus.row)) : [];
  const mirrorCols =
    colCount > 0 ? range(Math.max(0, window_.firstCol), lastCol, inCols(headerFocus ?? -1), inCols(focusCol), inCols(keptFocus.col)) : [];
  // The tab stop: the focused cell, else the first cell on screen.
  const tabRow = focusRow >= 0 ? focusRow : (mirrorRows[0] ?? -1);
  const tabCol = focusRow >= 0 ? focusCol : (mirrorCols[0] ?? -1);
  const sourceIndex = columns.map((column, i) => {
    const found = source.columns.findIndex((candidate) => candidate.name === column.name);
    return found >= 0 ? found : i;
  });

  const headerCells: ReactNode[] = [
    <div key="corner" role="columnheader" aria-colindex={1}>
      Row
    </div>,
  ];
  for (const c of mirrorCols) {
    const column = columns[c];
    if (!column) continue;
    const primary = sort[0]?.column === column.name ? sort[0] : undefined;
    headerCells.push(
      <div
        key={column.name}
        id={`${id}-h${c}`}
        role="columnheader"
        aria-colindex={c + 2}
        aria-sort={primary ? (primary.direction === 'asc' ? 'ascending' : 'descending') : undefined}
        tabIndex={headerFocus === c ? 0 : -1}
        data-header-col={c}
      >
        {column.name}
        {sortLabel(sort, column.name)}
      </div>,
    );
  }

  return (
    <div className={cx('gg-cgrid', className)} data-testid={testId}>
      <canvas ref={canvasRef} className="gg-cgrid__canvas" aria-hidden="true" data-testid={testId ? `${testId}-canvas` : undefined} />
      <div ref={scrollerRef} className="gg-cgrid__scroller" data-testid={testId ? `${testId}-scroller` : undefined}>
        <div ref={spacerRef} className="gg-cgrid__spacer" />
      </div>
      <div
        ref={gridRef}
        className="gg-visually-hidden"
        role="grid"
        aria-label={label}
        aria-rowcount={rowCount + 1}
        aria-colcount={colCount + 1}
        aria-multiselectable="true"
        data-testid={testId ? `${testId}-mirror` : undefined}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        <div role="rowgroup">
          <div role="row" aria-rowindex={1}>
            {headerCells}
          </div>
        </div>
        <div role="rowgroup">
          {mirrorRows.map((r) => {
            const inRange = range_ !== null && r >= range_.top && r <= range_.bottom;
            return (
              <div key={r} role="row" aria-rowindex={r + 2}>
                <div role="rowheader" aria-colindex={1}>
                  {r + 1}
                </div>
                {mirrorCols.map((c) => {
                  const value = source.getCell(r, sourceIndex[c] ?? c);
                  const selected = inRange && c >= range_.left && c <= range_.right;
                  return (
                    <div
                      key={c}
                      id={`${id}-r${r}-c${c}`}
                      role="gridcell"
                      aria-colindex={c + 2}
                      aria-selected={selected}
                      tabIndex={headerFocus === null && r === tabRow && c === tabCol ? 0 : -1}
                      data-row={r}
                      data-col={c}
                    >
                      {value === undefined ? 'Loading' : value === null ? 'null (empty value)' : value}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div className="gg-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
      {rowCount === 0 && <div className="gg-visually-hidden">{emptyMessage}</div>}
    </div>
  );
}
