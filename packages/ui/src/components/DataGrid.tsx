import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { isNumericType, isTemporalType, type ColumnType, type SortKey } from '@glassgrid/core';
import { cx } from '../cx.js';

export interface GridColumn {
  readonly name: string;
  readonly type: ColumnType;
  /** Width in px, including padding. */
  readonly width: number;
}

/** A cell as displayed: its text, or null for SQL NULL. */
export type GridCell = string | null;

export interface GridCellRef {
  readonly row: number;
  readonly col: number;
}

export interface GridSelection {
  readonly anchor: GridCellRef;
  readonly focus: GridCellRef;
}

export interface DataGridProps {
  columns: readonly GridColumn[];
  /** Rows in the current view (after filters); null while unknown. */
  rowCount: number | null;
  /** Display values of a row, or undefined while its page is loading. */
  getRow: (index: number) => readonly GridCell[] | undefined;
  /** Called with the first and last row index that should be loaded (visible + overscan). */
  onVisibleRangeChange?: (first: number, last: number) => void;
  sort: readonly SortKey[];
  /** Header click / Enter on a header. */
  onSortColumn?: (column: string) => void;
  /** Columns touched by the selection, for the column list's "selected" state. */
  onSelectedColumnsChange?: (columns: readonly string[]) => void;
  /** Changing this scrolls back to the top and clears the selection (new filters or sort). */
  resetKey?: string;
  label: string;
  testId?: string;
}

/** Chromium caps element heights near 33.5M px; past this the scroll position is scaled. */
export const MAX_SCROLL_HEIGHT = 15_000_000;
export const ROW_HEIGHT = 32;
export const HEADER_HEIGHT = 32;
export const ROWNUM_WIDTH = 52;
const OVERSCAN = 6;

/** Default width for a column of `type` named `name` (header text must fit). */
export function defaultColumnWidth(name: string, type: ColumnType): number {
  const base: Record<ColumnType, number> = {
    integer: 104,
    float: 104,
    decimal: 104,
    boolean: 88,
    date: 112,
    timestamp: 168,
    text: 160,
  };
  return Math.max(base[type], Math.min(320, Math.round(name.length * 7.2 + 40)));
}

/**
 * Maps between the scroll position and the row at the top of the viewport.
 * Below MAX_SCROLL_HEIGHT this is the identity (scale 1); above it the
 * scroll range is compressed linearly so every row stays reachable.
 */
export function scrollMapping(rowCount: number, viewportHeight: number) {
  const total = rowCount * ROW_HEIGHT;
  const spacer = Math.min(total, MAX_SCROLL_HEIGHT);
  const scaled = total > spacer;
  const scrollRange = Math.max(1, spacer - viewportHeight);
  const virtualRange = Math.max(1, total - viewportHeight);
  return {
    spacer,
    scaled,
    /** Virtual (unscaled) pixel offset of the viewport's top edge. */
    toVirtual: (scrollTop: number) => (scaled ? (scrollTop / scrollRange) * virtualRange : scrollTop),
    /** scrollTop that puts virtual offset `y` at the top. */
    toScroll: (y: number) => (scaled ? (y / virtualRange) * scrollRange : y),
  };
}

function cellKind(type: ColumnType): 'num' | 'mono' | 'text' {
  if (isNumericType(type)) return 'num';
  if (isTemporalType(type)) return 'mono';
  return 'text';
}

function rangeOf(selection: GridSelection | null) {
  if (!selection) return null;
  return {
    top: Math.min(selection.anchor.row, selection.focus.row),
    bottom: Math.max(selection.anchor.row, selection.focus.row),
    left: Math.min(selection.anchor.col, selection.focus.col),
    right: Math.max(selection.anchor.col, selection.focus.col),
  };
}

/**
 * The data grid as a windowed DOM table until the M2 canvas grid: 32px rows,
 * tabular figures, right-aligned numbers, muted `null`, a sticky header with
 * the sort indicator, a focused cell and range selection. Only the visible
 * rows (plus overscan) exist in the DOM; rows come from `getRow`, so the
 * paging contract with the engine stays outside the component.
 */
export function DataGrid({
  columns,
  rowCount,
  getRow,
  onVisibleRangeChange,
  sort,
  onSortColumn,
  onSelectedColumnsChange,
  resetKey,
  label,
  testId,
}: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const dragging = useRef(false);

  const rows = rowCount ?? 0;
  const bodyHeight = Math.max(0, viewport.height - HEADER_HEIGHT);
  const mapping = useMemo(() => scrollMapping(rows, bodyHeight), [rows, bodyHeight]);
  const virtualTop = mapping.toVirtual(scrollTop);
  const first = Math.max(0, Math.min(Math.floor(virtualTop / ROW_HEIGHT), Math.max(0, rows - 1)));
  const offset = virtualTop - first * ROW_HEIGHT;
  const visible = Math.ceil(bodyHeight / ROW_HEIGHT) + 1;
  const last = Math.min(rows - 1, first + visible);
  const rowsTop = scrollTop - offset;
  const contentWidth = ROWNUM_WIDTH + columns.reduce((sum, column) => sum + column.width, 0);
  const columnLeft = useMemo(() => {
    const lefts: number[] = [];
    let x = ROWNUM_WIDTH;
    for (const column of columns) {
      lefts.push(x);
      x += column.width;
    }
    return lefts;
  }, [columns]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (rows === 0) return;
    onVisibleRangeChange?.(Math.max(0, first - OVERSCAN), Math.min(rows - 1, last + OVERSCAN));
  }, [first, last, rows, onVisibleRangeChange]);

  // New view (filters or sort changed): back to the top, selection cleared.
  const [viewKey, setViewKey] = useState(resetKey);
  if (viewKey !== resetKey) {
    setViewKey(resetKey);
    setScrollTop(0);
    setSelection(null);
  }
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [resetKey]);

  const range = rangeOf(selection);
  const selectedColumns = useMemo(
    () => (range ? columns.slice(range.left, range.right + 1).map((column) => column.name) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range?.left, range?.right, columns],
  );
  useEffect(() => {
    onSelectedColumnsChange?.(selectedColumns);
  }, [selectedColumns, onSelectedColumnsChange]);

  const scrollRowIntoView = useCallback(
    (row: number) => {
      const element = scrollRef.current;
      if (!element) return;
      const top = row * ROW_HEIGHT;
      const current = mapping.toVirtual(element.scrollTop);
      let next: number | null = null;
      if (top < current) next = top;
      else if (top + ROW_HEIGHT > current + bodyHeight) next = top + ROW_HEIGHT - bodyHeight;
      if (next !== null) element.scrollTop = mapping.toScroll(next);
    },
    [mapping, bodyHeight],
  );

  const moveFocus = (row: number, col: number, extend: boolean) => {
    if (rows === 0 || columns.length === 0) return;
    const target = { row: Math.max(0, Math.min(rows - 1, row)), col: Math.max(0, Math.min(columns.length - 1, col)) };
    setSelection((current) => ({ anchor: extend && current ? current.anchor : target, focus: target }));
    scrollRowIntoView(target.row);
  };

  const copySelection = () => {
    if (!range) return;
    const lines: string[] = [];
    for (let r = range.top; r <= range.bottom && lines.length < 10_000; r += 1) {
      const values = getRow(r);
      if (!values) continue;
      lines.push(values.slice(range.left, range.right + 1).map((value) => value ?? '').join('\t'));
    }
    void (navigator as Partial<Navigator>).clipboard?.writeText(lines.join('\n'));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const focus = selection?.focus ?? { row: first, col: 0 };
    const page = Math.max(1, Math.floor(bodyHeight / ROW_HEIGHT) - 1);
    const mod = event.metaKey || event.ctrlKey;
    const handled = (() => {
      switch (event.key) {
        case 'ArrowDown':
          moveFocus(mod ? rows - 1 : focus.row + 1, focus.col, event.shiftKey);
          return true;
        case 'ArrowUp':
          moveFocus(mod ? 0 : focus.row - 1, focus.col, event.shiftKey);
          return true;
        case 'ArrowRight':
          moveFocus(focus.row, mod ? columns.length - 1 : focus.col + 1, event.shiftKey);
          return true;
        case 'ArrowLeft':
          moveFocus(focus.row, mod ? 0 : focus.col - 1, event.shiftKey);
          return true;
        case 'PageDown':
          moveFocus(focus.row + page, focus.col, event.shiftKey);
          return true;
        case 'PageUp':
          moveFocus(focus.row - page, focus.col, event.shiftKey);
          return true;
        case 'Home':
          moveFocus(mod ? 0 : focus.row, 0, event.shiftKey);
          return true;
        case 'End':
          moveFocus(mod ? rows - 1 : focus.row, columns.length - 1, event.shiftKey);
          return true;
        case 'Escape':
          setSelection(null);
          return true;
        case 'c':
          if (mod) {
            copySelection();
            return true;
          }
          return false;
        default:
          return false;
      }
    })();
    if (handled) event.preventDefault();
  };

  const cellFromMouse = (event: MouseEvent): GridCellRef | null => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]');
    if (!target) return null;
    const row = Number(target.dataset['row']);
    const col = Number(target.dataset['col']);
    return Number.isFinite(row) && Number.isFinite(col) ? { row, col } : null;
  };

  const sortOf = (name: string) => sort.find((key) => key.column === name);

  const rowElements = [];
  for (let r = first; r <= last && rows > 0; r += 1) {
    const values = getRow(r);
    const inRange = range !== null && r >= range.top && r <= range.bottom;
    rowElements.push(
      <div
        key={r}
        role="row"
        aria-rowindex={r + 2}
        className={cx('gg-grid__row', r % 2 === 1 && 'gg-grid__row--zebra')}
        style={{ width: contentWidth }}
      >
        <div role="rowheader" className={cx('gg-grid__rownum', inRange && 'gg-grid__rownum--selected')}>
          {r + 1}
        </div>
        {columns.map((column, c) => {
          const value = values?.[c];
          const kind = cellKind(column.type);
          const isNull = values !== undefined && (value === null || value === undefined);
          return (
            <div
              key={column.name}
              role="gridcell"
              aria-colindex={c + 2}
              aria-selected={range !== null && inRange && c >= range.left && c <= range.right}
              data-cell=""
              data-row={r}
              data-col={c}
              className={cx(
                'gg-grid__cell',
                values === undefined && 'gg-grid__cell--placeholder',
                isNull ? 'gg-grid__cell--null' : kind === 'num' ? 'gg-grid__cell--num' : kind === 'mono' && 'gg-grid__cell--mono',
              )}
              style={{ width: column.width, textAlign: isNull && kind === 'num' ? 'right' : undefined }}
            >
              {values === undefined ? '' : isNull ? 'null' : value}
            </div>
          );
        })}
      </div>,
    );
  }

  const overlay = (() => {
    if (!range || !selection) return null;
    const top = (row: number) => HEADER_HEIGHT + rowsTop + (row - first) * ROW_HEIGHT;
    const left = columnLeft[range.left] ?? ROWNUM_WIDTH;
    const right = (columnLeft[range.right] ?? ROWNUM_WIDTH) + (columns[range.right]?.width ?? 0);
    const focusLeft = columnLeft[selection.focus.col] ?? ROWNUM_WIDTH;
    const multi = range.top !== range.bottom || range.left !== range.right;
    return (
      <>
        {multi && (
          <div
            className="gg-grid__selection"
            style={{ left, top: top(range.top), width: right - left, height: (range.bottom - range.top + 1) * ROW_HEIGHT }}
          />
        )}
        <div
          className="gg-grid__focus"
          data-testid={testId ? `${testId}-focus` : undefined}
          style={{
            left: focusLeft,
            top: top(selection.focus.row),
            width: columns[selection.focus.col]?.width ?? 0,
            height: ROW_HEIGHT,
          }}
        />
      </>
    );
  })();

  return (
    <div
      ref={scrollRef}
      className="gg-grid"
      role="grid"
      aria-label={label}
      aria-rowcount={rowCount === null ? -1 : rowCount + 1}
      aria-colcount={columns.length + 1}
      aria-multiselectable="true"
      tabIndex={0}
      data-testid={testId}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        const cell = cellFromMouse(event);
        if (!cell) return;
        dragging.current = true;
        setSelection((current) => ({ anchor: event.shiftKey && current ? current.anchor : cell, focus: cell }));
      }}
      onMouseOver={(event) => {
        if (!dragging.current) return;
        const cell = cellFromMouse(event);
        if (cell) setSelection((current) => (current ? { anchor: current.anchor, focus: cell } : null));
      }}
      onMouseUp={() => {
        dragging.current = false;
      }}
    >
      <div className="gg-grid__content" style={{ width: contentWidth, height: HEADER_HEIGHT + mapping.spacer }}>
        <div className="gg-grid__header" role="row" aria-rowindex={1} style={{ width: contentWidth }}>
          <div className="gg-grid__corner" role="columnheader" aria-label="Row number" />
          {columns.map((column, c) => {
            const key = sortOf(column.name);
            const selected = range !== null && c >= range.left && c <= range.right;
            return (
              <button
                key={column.name}
                type="button"
                role="columnheader"
                aria-colindex={c + 2}
                aria-sort={key ? (key.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                title={`Sort by ${column.name}`}
                className={cx(
                  'gg-grid__colheader',
                  cellKind(column.type) === 'num' && 'gg-grid__colheader--right',
                  selected && 'gg-grid__colheader--selected',
                )}
                style={{ width: column.width }}
                data-testid={testId ? `${testId}-header-${column.name}` : undefined}
                onClick={() => onSortColumn?.(column.name)}
              >
                <span className="gg-grid__colname">{column.name}</span>
                {key && (
                  <span className="gg-grid__sort" aria-hidden="true">
                    {key.direction === 'asc' ? '↑' : '↓'}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="gg-grid__rows" role="rowgroup" style={{ top: HEADER_HEIGHT + rowsTop, width: contentWidth }}>
          {rowElements}
        </div>
        {overlay}
        {rowCount === 0 && <div className="gg-grid__empty">No rows match the filters.</div>}
      </div>
    </div>
  );
}
