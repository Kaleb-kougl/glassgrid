import type { SortKey } from '@glassgrid/core';
import type { ResolvedTokens } from '../tokens.js';
import { cellKind } from './format.js';
import {
  clampVirtual,
  clampedColumnAtX,
  clampedRowAtY,
  columnOffsets,
  createColWindow,
  createHitResult,
  createScrollMapping,
  gutterWidthFor,
  hitTest,
  MAX_COLUMN_WIDTH,
  MAX_SCROLL_HEIGHT,
  MIN_COLUMN_WIDTH,
  OVERSCAN,
  reorderTarget,
  rowsPerPage,
  scrollLeftForColumn,
  scrollToVirtual,
  scrollTopForRow,
  virtualToScroll,
  visibleColumns,
  visibleRows,
  type HitLayout,
  type ScrollMapping,
} from './geometry.js';
import { createFrame, KIND_NUMBER, KIND_TEMPORAL, KIND_TEXT, paintGrid, PaintResources, SORT_ASC, SORT_DESC, SORT_NONE, type GridContext } from './paint.js';
import { normalizeSelection, sameSelection } from './selection.js';
import type { MeasureContext } from './text.js';
import type { GridCellRef, GridColumn, GridDataSource, GridSelection, GridSourceChange } from './types.js';

export interface GridWindow {
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstCol: number;
  readonly lastCol: number;
}

export interface GridControllerCallbacks {
  onSelectionChange?: ((selection: GridSelection | null) => void) | undefined;
  onSortRequest?: ((column: string) => void) | undefined;
  onColumnResize?: ((column: string, width: number) => void) | undefined;
  onColumnReorder?: ((from: number, to: number) => void) | undefined;
  /** The visible window moved (throttled; drives the accessibility mirror). */
  onWindowChange?: ((window: GridWindow) => void) | undefined;
  /** Rows arrived for the visible window (throttled with the window). */
  onDataChange?: (() => void) | undefined;
  /** After each painted frame: visible rows with data, visible rows. */
  onPaint?: ((loadedRows: number, visibleRows: number) => void) | undefined;
  /** Pointer interaction wants keyboard focus on the grid. */
  requestFocus?: (() => void) | undefined;
}

export interface GridControllerProps {
  source: GridDataSource;
  columns: readonly GridColumn[];
  tokens: ResolvedTokens;
  selection: GridSelection | null;
  sort: readonly SortKey[];
  headerFocusCol: number;
  hasFocus: boolean;
  emptyMessage: string;
  maxScrollHeight: number;
}

type DragMode =
  | { kind: 'none' }
  | { kind: 'cells'; anchor: GridCellRef; rows: boolean }
  | { kind: 'resize'; col: number; startX: number; startWidth: number; width: number }
  | { kind: 'header'; col: number; startX: number }
  | { kind: 'reorder'; col: number };

const DRAG_THRESHOLD = 4;
const WINDOW_THROTTLE_MS = 100;
const FONT_TIMEOUT_MS = 2_000;

function measuringContext(): MeasureContext | null {
  try {
    return document.createElement('canvas').getContext('2d');
  } catch {
    return null;
  }
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/**
 * The canvas grid's imperative core: owns the frame state, paints on
 * requestAnimationFrame when something changed, maps scrolling (scaled past
 * the browser's height limit) and turns pointer input into callbacks. The
 * React component only feeds it props and renders the DOM around it.
 */
export class GridController {
  readonly frame = createFrame();
  private readonly canvas: HTMLCanvasElement;
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private ctx: GridContext | null | undefined;
  private readonly measure = measuringContext();
  private resources: PaintResources | null = null;
  private props: GridControllerProps | null = null;
  callbacks: GridControllerCallbacks = {};

  private mapping: ScrollMapping = createScrollMapping(0, 32, 0);
  private expectedScrollTop = -1;
  private raf = 0;
  private fontsReady = false;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private dprQuery: MediaQueryList | null = null;
  private readonly hit = createHitResult();
  private readonly mirrorCols = createColWindow();
  private drag: DragMode = { kind: 'none' };
  private pointer = { x: 0, y: 0 };
  private autoScrollRaf = 0;
  private cursor = '';
  private lastSelection: GridSelection | null = null;
  private pointerSelection: GridSelection | null = null;
  /** Width set by a resize drag, kept until the columns prop catches up. */
  private pendingWidth: { name: string; width: number } | null = null;
  // Window last requested from the source and last reported to the mirror.
  private requestedFirst = -1;
  private requestedLast = -1;
  private reported: GridWindow = { firstRow: -1, lastRow: -1, firstCol: -1, lastCol: -1 };
  private reportTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReport = Number.NEGATIVE_INFINITY;
  private dataDirty = false;
  private spacerWidth = -1;
  private spacerHeight = -1;
  private readonly layoutView: { -readonly [K in keyof HitLayout]: HitLayout[K] } = {
    viewportWidth: 0,
    viewportHeight: 0,
    headerHeight: 32,
    rowHeight: 32,
    gutterWidth: 52,
    rowCount: 0,
    virtualTop: 0,
    scrollLeft: 0,
    offsets: new Float64Array(1),
  };

  constructor(canvas: HTMLCanvasElement, scroller: HTMLElement, spacer: HTMLElement) {
    this.canvas = canvas;
    this.scroller = scroller;
    this.spacer = spacer;
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    scroller.addEventListener('wheel', this.onWheel, { passive: false });
    scroller.addEventListener('pointerdown', this.onPointerDown);
    scroller.addEventListener('pointermove', this.onPointerMove);
    scroller.addEventListener('pointerup', this.onPointerUp);
    scroller.addEventListener('pointercancel', this.onPointerCancel);
    scroller.addEventListener('pointerleave', this.onPointerLeave);
    scroller.addEventListener('mousedown', this.onMouseDown);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.measureViewport();
      });
      this.resizeObserver.observe(scroller);
    }
    this.watchDpr();
  }

  // ---------------------------------------------------------------------------
  // Props

  setProps(props: GridControllerProps): void {
    const previous = this.props;
    this.props = props;
    const frame = this.frame;
    let layout = false;
    let changed = previous === null;
    if (!previous || previous.tokens !== props.tokens) {
      this.resources = new PaintResources(props.tokens, this.measure);
      if (!previous) this.waitForFonts();
      layout = true;
    }
    if (!previous || previous.source !== props.source) {
      this.unsubscribe?.();
      this.unsubscribe = props.source.subscribe(this.onSourceChange);
      frame.source = props.source;
      this.requestedFirst = -1;
      this.requestedLast = -1;
      if (previous) {
        this.scrollToTop();
        if (this.lastSelection) this.callbacks.onSelectionChange?.(null);
      }
      layout = true;
    }
    if (!previous || previous.columns !== props.columns || previous.source !== props.source) {
      if (previous && previous.columns !== props.columns) this.pendingWidth = null;
      this.syncColumns();
      layout = true;
    }
    if (!previous || previous.sort !== props.sort || previous.columns !== props.columns) {
      if (this.syncSort()) changed = true;
    }
    if (!previous || previous.maxScrollHeight !== props.maxScrollHeight) layout = true;
    if (!previous || !sameSelection(previous.selection, props.selection)) {
      this.syncSelection();
      changed = true;
    }
    if (frame.headerFocusCol !== props.headerFocusCol || frame.hasFocus !== props.hasFocus || frame.emptyMessage !== props.emptyMessage) {
      frame.headerFocusCol = props.headerFocusCol;
      frame.hasFocus = props.hasFocus;
      frame.emptyMessage = props.emptyMessage;
      changed = true;
    }
    if (layout) {
      this.layout();
      changed = true;
    }
    if (!previous) this.measureViewport();
    if (changed) this.invalidate();
  }

  private syncColumns(): void {
    const props = this.props;
    if (!props) return;
    const frame = this.frame;
    const columns = props.columns;
    const n = columns.length;
    const sourceColumns = props.source.columns;
    frame.colCount = n;
    frame.names = columns.map((column) => column.name);
    if (frame.kinds.length !== n) {
      frame.kinds = new Uint8Array(n);
      frame.widths = new Float64Array(n);
      frame.sourceIndex = new Int32Array(n);
      frame.sortDir = new Int8Array(n);
    }
    for (let i = 0; i < n; i += 1) {
      const column = columns[i] as GridColumn;
      const kind = cellKind(column.type);
      frame.kinds[i] = kind === 'number' ? KIND_NUMBER : kind === 'temporal' ? KIND_TEMPORAL : KIND_TEXT;
      const pending = this.pendingWidth;
      frame.widths[i] = pending && pending.name === column.name ? pending.width : column.width;
      const index = sourceColumns.findIndex((candidate) => candidate.name === column.name);
      frame.sourceIndex[i] = index >= 0 ? index : i;
    }
  }

  /** Returns true when any column's sort state changed. */
  private syncSort(): boolean {
    const props = this.props;
    if (!props) return false;
    const frame = this.frame;
    const before = frame.sortDir.join();
    frame.sortDir.fill(SORT_NONE);
    for (const key of props.sort) {
      const index = frame.names.indexOf(key.column);
      if (index >= 0) frame.sortDir[index] = key.direction === 'asc' ? SORT_ASC : SORT_DESC;
    }
    return frame.sortDir.join() !== before;
  }

  private syncSelection(): void {
    const selection = this.props?.selection ?? null;
    this.lastSelection = selection;
    const frame = this.frame;
    const range = normalizeSelection(selection);
    frame.hasSelection = range !== null;
    if (range && selection) {
      frame.selTop = range.top;
      frame.selBottom = range.bottom;
      frame.selLeft = range.left;
      frame.selRight = range.right;
      frame.focusRow = selection.focus.row;
      frame.focusCol = selection.focus.col;
    } else {
      frame.focusRow = -1;
      frame.focusCol = -1;
    }
  }

  // ---------------------------------------------------------------------------
  // Layout and scrolling

  private measureViewport(): void {
    const width = this.scroller.clientWidth;
    const height = this.scroller.clientHeight;
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const frame = this.frame;
    if (width === frame.width && height === frame.height && dpr === frame.dpr) return;
    frame.width = width;
    frame.height = height;
    frame.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.layout();
    this.invalidate();
  }

  private watchDpr(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  private readonly onDprChange = () => {
    this.watchDpr();
    this.measureViewport();
  };

  /** Recomputes gutter, column offsets, scroll mapping and the spacer. */
  private layout(): void {
    const props = this.props;
    const res = this.resources;
    if (!props || !res) return;
    const frame = this.frame;
    const grid = props.tokens.grid;
    frame.rowHeight = grid.rowH;
    frame.headerHeight = grid.headerH;
    frame.cellPx = grid.cellPx;
    frame.rowCount = props.source.rowCount;
    frame.gutterWidth = gutterWidthFor(frame.rowCount, res.metrics.rowNumber.digit * 1.08, frame.cellPx, grid.rownumW);
    frame.offsets = columnOffsets(frame.widths, frame.gutterWidth, frame.offsets);
    const previousVirtual = frame.virtualTop;
    this.mapping = createScrollMapping(frame.rowCount, frame.rowHeight, frame.height - frame.headerHeight, props.maxScrollHeight || MAX_SCROLL_HEIGHT);
    const spacerWidth = frame.offsets[frame.colCount] ?? frame.gutterWidth;
    const spacerHeight = frame.headerHeight + this.mapping.spacerHeight;
    if (spacerWidth !== this.spacerWidth || spacerHeight !== this.spacerHeight) {
      this.spacerWidth = spacerWidth;
      this.spacerHeight = spacerHeight;
      this.spacer.style.width = `${spacerWidth}px`;
      this.spacer.style.height = `${spacerHeight}px`;
    }
    this.setVirtualTop(previousVirtual);
    frame.scrollLeft = Math.min(frame.scrollLeft, Math.max(0, spacerWidth - frame.width));
  }

  /** The virtual (unscaled) offset of the body's top edge, in px. */
  get virtualTop(): number {
    return this.frame.virtualTop;
  }

  get scrollMapping(): ScrollMapping {
    return this.mapping;
  }

  get bodyHeight(): number {
    return Math.max(0, this.frame.height - this.frame.headerHeight);
  }

  get pageRows(): number {
    return rowsPerPage(this.bodyHeight, this.frame.rowHeight);
  }

  /** Top-left fully visible cell (keyboard focus starts here). */
  get topLeftCell(): GridCellRef {
    const frame = this.frame;
    const row = Math.min(Math.max(0, frame.rowCount - 1), Math.ceil(frame.virtualTop / frame.rowHeight));
    const col = clampedColumnAtX(frame.offsets, frame.scrollLeft, frame.gutterWidth, frame.gutterWidth + 1);
    return { row, col: Math.max(0, col) };
  }

  /** Scrolls so the body's top edge is at virtual offset `virtualTop`. */
  setVirtualTop(virtualTop: number): void {
    const frame = this.frame;
    const next = clampVirtual(this.mapping, virtualTop);
    frame.virtualTop = next;
    const target = virtualToScroll(this.mapping, next);
    if (Math.abs(this.scroller.scrollTop - target) >= 0.5) this.scroller.scrollTop = target;
    this.expectedScrollTop = this.scroller.scrollTop;
    this.invalidate();
  }

  setScrollLeft(scrollLeft: number): void {
    const frame = this.frame;
    const max = Math.max(0, (frame.offsets[frame.colCount] ?? 0) - frame.width);
    const next = Math.max(0, Math.min(max, scrollLeft));
    frame.scrollLeft = next;
    if (Math.abs(this.scroller.scrollLeft - next) >= 0.5) this.scroller.scrollLeft = next;
    this.invalidate();
  }

  scrollToTop(): void {
    this.setVirtualTop(0);
    this.setScrollLeft(0);
  }

  /** Scrolls the least needed to show the cell (row and/or column; pass -1 to skip one). */
  scrollCellIntoView(row: number, col: number): void {
    const frame = this.frame;
    if (row >= 0) {
      const top = scrollTopForRow(row, frame.virtualTop, this.bodyHeight, frame.rowHeight);
      if (top !== frame.virtualTop) this.setVirtualTop(top);
    }
    if (col >= 0 && col < frame.colCount) {
      const left = scrollLeftForColumn(frame.offsets, col, frame.scrollLeft, frame.width, frame.gutterWidth);
      if (left !== frame.scrollLeft) this.setScrollLeft(left);
    }
  }

  private readonly onScroll = () => {
    const frame = this.frame;
    const top = this.scroller.scrollTop;
    frame.scrollLeft = this.scroller.scrollLeft;
    if (!this.mapping.scaled) frame.virtualTop = top;
    else if (Math.abs(top - this.expectedScrollTop) >= 1) {
      // The scrollbar moved on its own (thumb drag, track click): map it.
      frame.virtualTop = scrollToVirtual(this.mapping, top);
      this.expectedScrollTop = top;
    }
    this.invalidate();
  };

  /**
   * In the scaled range one scrollbar pixel spans many rows, so wheel and
   * trackpad deltas (momentum included) are applied 1:1 in virtual pixels
   * instead of letting the browser scroll the compressed spacer.
   */
  private readonly onWheel = (event: WheelEvent) => {
    if (!this.mapping.scaled || event.ctrlKey) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? this.frame.rowHeight : event.deltaMode === 2 ? this.bodyHeight : 1;
    let dx = event.deltaX * unit;
    let dy = event.deltaY * unit;
    if (event.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    if (dy !== 0) this.setVirtualTop(this.frame.virtualTop + dy);
    if (dx !== 0) this.setScrollLeft(this.frame.scrollLeft + dx);
  };

  // ---------------------------------------------------------------------------
  // Data

  private readonly onSourceChange = (change: GridSourceChange) => {
    const frame = this.frame;
    switch (change.kind) {
      case 'rows':
        if (change.lastRow >= frame.rows.first && change.firstRow <= frame.rows.last) {
          this.dataDirty = true;
          this.invalidate();
        }
        break;
      case 'reset':
        // A new view: back to the top, nothing selected, nothing requested.
        this.requestedFirst = -1;
        this.requestedLast = -1;
        this.syncColumns();
        this.layout();
        this.scrollToTop();
        if (this.lastSelection) this.callbacks.onSelectionChange?.(null);
        this.dataDirty = true;
        this.invalidate();
        break;
      case 'resize':
        this.requestedFirst = -1;
        this.requestedLast = -1;
        this.layout();
        this.dataDirty = true;
        this.invalidate();
        break;
      case 'error':
        break;
    }
  };

  // ---------------------------------------------------------------------------
  // Fonts

  private waitForFonts(): void {
    const fonts = typeof document === 'undefined' ? undefined : (document as Partial<Pick<Document, 'fonts'>>).fonts;
    const res = this.resources;
    if (!fonts || !res) {
      this.fontsReady = true;
      return;
    }
    const ready = () => {
      if (this.disposed || this.fontsReady) return;
      this.fontsReady = true;
      this.refreshFonts();
    };
    const loads = res.fontList.map((font) => fonts.load(font, 'Aa0').catch(() => []));
    void Promise.all(loads).then(ready, ready);
    setTimeout(ready, FONT_TIMEOUT_MS);
    fonts.addEventListener('loadingdone', this.onFontsLoaded);
  }

  private readonly onFontsLoaded = () => {
    if (this.fontsReady) this.refreshFonts();
  };

  /** Webfonts arrived: drop width tables and fitted strings, then repaint. */
  private refreshFonts(): void {
    if (!this.props) return;
    this.resources = new PaintResources(this.props.tokens, this.measure);
    this.layout();
    this.invalidate();
  }

  // ---------------------------------------------------------------------------
  // Painting

  /** Schedules a repaint on the next animation frame (once). */
  invalidate(): void {
    if (this.raf !== 0 || this.disposed) return;
    this.raf = requestAnimationFrame(this.paintFrame);
  }

  private readonly paintFrame = () => {
    this.raf = 0;
    this.paintNow();
  };

  /** Paints synchronously (tests and the benchmark's allocation check). */
  paintNow(): void {
    const props = this.props;
    const res = this.resources;
    if (!props || !res || !this.fontsReady || this.disposed) return;
    if (this.ctx === undefined) this.ctx = this.canvas.getContext('2d');
    const frame = this.frame;
    visibleRows(frame.virtualTop, this.bodyHeight, frame.rowHeight, frame.rowCount, OVERSCAN, frame.rows);
    visibleColumns(frame.offsets, frame.scrollLeft, frame.width, frame.gutterWidth, OVERSCAN, frame.cols);
    if (frame.rows.last >= frame.rows.first && (frame.rows.first !== this.requestedFirst || frame.rows.last !== this.requestedLast)) {
      this.requestedFirst = frame.rows.first;
      this.requestedLast = frame.rows.last;
      props.source.ensureRange(frame.rows.first, frame.rows.last);
    }
    if (this.ctx) paintGrid(this.ctx, frame, res);
    this.reportWindow();
    this.callbacks.onPaint?.(frame.loadedRows, frame.visibleRows);
  }

  private reportWindow(): void {
    const frame = this.frame;
    const rows = frame.rows;
    const cols = visibleColumns(frame.offsets, frame.scrollLeft, frame.width, frame.gutterWidth, 0, this.mirrorCols);
    const r = this.reported;
    const changed = r.firstRow !== rows.firstVisible || r.lastRow !== rows.lastVisible || r.firstCol !== cols.first || r.lastCol !== cols.last;
    if ((!changed && !this.dataDirty) || this.reportTimer !== null) return;
    const delay = WINDOW_THROTTLE_MS - (now() - this.lastReport);
    if (delay <= 0) this.emitWindow();
    else this.reportTimer = setTimeout(this.emitWindow, delay);
  }

  private readonly emitWindow = () => {
    this.reportTimer = null;
    this.lastReport = now();
    const frame = this.frame;
    const cols = visibleColumns(frame.offsets, frame.scrollLeft, frame.width, frame.gutterWidth, 0, this.mirrorCols);
    this.reported = { firstRow: frame.rows.firstVisible, lastRow: frame.rows.lastVisible, firstCol: cols.first, lastCol: cols.last };
    const data = this.dataDirty;
    this.dataDirty = false;
    this.callbacks.onWindowChange?.(this.reported);
    if (data) this.callbacks.onDataChange?.();
  };

  /** The window the accessibility mirror shows. */
  get window(): GridWindow {
    return this.reported;
  }

  // ---------------------------------------------------------------------------
  // Pointer

  private local(event: MouseEvent): { x: number; y: number } {
    const rect = this.scroller.getBoundingClientRect();
    this.pointer.x = event.clientX - rect.left;
    this.pointer.y = event.clientY - rect.top;
    return this.pointer;
  }

  private hitLayout(): HitLayout {
    const frame = this.frame;
    const view = this.layoutView;
    view.viewportWidth = frame.width;
    view.viewportHeight = frame.height;
    view.headerHeight = frame.headerHeight;
    view.rowHeight = frame.rowHeight;
    view.gutterWidth = frame.gutterWidth;
    view.rowCount = frame.rowCount;
    view.virtualTop = frame.virtualTop;
    view.scrollLeft = frame.scrollLeft;
    view.offsets = frame.offsets;
    return view;
  }

  private emitSelection(selection: GridSelection | null): void {
    if (sameSelection(selection, this.lastSelection)) return;
    this.lastSelection = selection;
    this.pointerSelection = selection;
    this.callbacks.onSelectionChange?.(selection);
  }

  /**
   * True when `selection` is the one the pointer just made (the cell is
   * already where the person is looking, so it is not scrolled into view).
   * Forgets the pointer selection either way.
   */
  consumePointerSelection(selection: GridSelection | null): boolean {
    const result = selection !== null && sameSelection(selection, this.pointerSelection);
    this.pointerSelection = null;
    return result;
  }

  private readonly onMouseDown = (event: MouseEvent) => {
    const { x, y } = this.local(event);
    // Keep focus where the grid puts it and avoid text selection; leave the scrollbars alone.
    if (x < this.frame.width && y < this.frame.height) event.preventDefault();
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !this.props) return;
    const { x, y } = this.local(event);
    const frame = this.frame;
    if (x >= frame.width || y >= frame.height) return;
    const hit = hitTest(this.hitLayout(), x, y, this.hit);
    const lastCol = frame.colCount - 1;
    const current = this.lastSelection;
    switch (hit.area) {
      case 'header':
        if (hit.resizeCol >= 0) {
          const width = frame.widths[hit.resizeCol] ?? 0;
          this.drag = { kind: 'resize', col: hit.resizeCol, startX: x, startWidth: width, width };
          frame.resizingCol = hit.resizeCol;
          this.invalidate();
        } else if (hit.col >= 0) {
          this.drag = { kind: 'header', col: hit.col, startX: x };
        }
        break;
      case 'corner':
        if (frame.rowCount > 0 && frame.colCount > 0) {
          this.emitSelection({ anchor: { row: frame.rowCount - 1, col: lastCol }, focus: { row: 0, col: 0 } });
          this.callbacks.requestFocus?.();
        }
        return;
      case 'gutter': {
        const anchor = event.shiftKey && current ? { row: current.anchor.row, col: 0 } : { row: hit.row, col: 0 };
        this.emitSelection({ anchor, focus: { row: hit.row, col: lastCol } });
        this.drag = { kind: 'cells', anchor, rows: true };
        this.callbacks.requestFocus?.();
        break;
      }
      case 'cell': {
        const cell = { row: hit.row, col: hit.col };
        const anchor = event.shiftKey && current ? current.anchor : cell;
        this.emitSelection({ anchor, focus: cell });
        this.drag = { kind: 'cells', anchor, rows: false };
        this.callbacks.requestFocus?.();
        break;
      }
      default:
        return;
    }
    if (typeof this.scroller.setPointerCapture === 'function') {
      try {
        this.scroller.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic events have no active pointer to capture.
      }
    }
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const { x, y } = this.local(event);
    const frame = this.frame;
    const drag = this.drag;
    switch (drag.kind) {
      case 'none': {
        const hit = hitTest(this.hitLayout(), x, y, this.hit);
        const header = hit.area === 'header' ? hit.col : -1;
        const resize = hit.area === 'header' ? hit.resizeCol : -1;
        if (header !== frame.hoverHeaderCol || resize !== frame.hoverResizeCol) {
          frame.hoverHeaderCol = header;
          frame.hoverResizeCol = resize;
          this.invalidate();
        }
        this.setCursor(resize >= 0 ? 'col-resize' : header >= 0 || hit.area === 'corner' ? 'pointer' : '');
        return;
      }
      case 'resize': {
        const width = Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, drag.startWidth + x - drag.startX)));
        if (width !== drag.width) {
          drag.width = width;
          frame.widths[drag.col] = width;
          this.layout();
          this.invalidate();
        }
        return;
      }
      case 'header':
        if (Math.abs(x - drag.startX) > DRAG_THRESHOLD && frame.colCount > 1) {
          this.drag = { kind: 'reorder', col: drag.col };
          frame.reorderFrom = drag.col;
          this.setCursor('grabbing');
          this.updateReorder(x);
        }
        return;
      case 'reorder':
        this.updateReorder(x);
        return;
      case 'cells':
        this.updateDragSelection();
        this.autoScroll();
        return;
    }
  };

  private updateReorder(x: number): void {
    const frame = this.frame;
    frame.reorderX = x;
    frame.reorderTo = reorderTarget(frame.offsets, frame.reorderFrom, x + frame.scrollLeft);
    this.invalidate();
  }

  private updateDragSelection(): void {
    const drag = this.drag;
    if (drag.kind !== 'cells') return;
    const frame = this.frame;
    const view = this.hitLayout();
    const row = clampedRowAtY(view, this.pointer.y);
    const col = drag.rows ? frame.colCount - 1 : clampedColumnAtX(frame.offsets, frame.scrollLeft, frame.gutterWidth, this.pointer.x);
    if (row < 0 || col < 0) return;
    this.emitSelection({ anchor: drag.anchor, focus: { row, col } });
  }

  /** While a drag selection is outside the body, keep scrolling toward the pointer. */
  private autoScroll(): void {
    if (this.autoScrollRaf !== 0) return;
    const step = () => {
      this.autoScrollRaf = 0;
      if (this.drag.kind !== 'cells') return;
      const frame = this.frame;
      const { x, y } = this.pointer;
      let dy = 0;
      let dx = 0;
      if (y < frame.headerHeight) dy = -Math.min(64, frame.headerHeight - y + 4);
      else if (y > frame.height) dy = Math.min(64, y - frame.height + 4);
      if (x < frame.gutterWidth) dx = -Math.min(64, frame.gutterWidth - x + 4);
      else if (x > frame.width) dx = Math.min(64, x - frame.width + 4);
      if (dx === 0 && dy === 0) return;
      if (dy !== 0) this.setVirtualTop(frame.virtualTop + dy);
      if (dx !== 0) this.setScrollLeft(frame.scrollLeft + dx);
      this.updateDragSelection();
      this.autoScrollRaf = requestAnimationFrame(step);
    };
    this.autoScrollRaf = requestAnimationFrame(step);
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    const props = this.props;
    const drag = this.drag;
    this.endDrag(event);
    if (!props) return;
    const frame = this.frame;
    switch (drag.kind) {
      case 'resize': {
        const name = frame.names[drag.col];
        if (name !== undefined && drag.width !== drag.startWidth) {
          this.pendingWidth = { name, width: drag.width };
          this.callbacks.onColumnResize?.(name, drag.width);
        }
        break;
      }
      case 'header': {
        const name = frame.names[drag.col];
        if (name !== undefined) this.callbacks.onSortRequest?.(name);
        break;
      }
      case 'reorder': {
        const to = frame.reorderTo;
        frame.reorderFrom = -1;
        frame.reorderTo = -1;
        if (to >= 0 && to !== drag.col) this.callbacks.onColumnReorder?.(drag.col, to);
        this.invalidate();
        break;
      }
      default:
        break;
    }
  };

  private readonly onPointerCancel = (event: PointerEvent) => {
    this.cancelDrag();
    this.endDrag(event);
  };

  private readonly onPointerLeave = () => {
    const frame = this.frame;
    if (this.drag.kind !== 'none') return;
    if (frame.hoverHeaderCol !== -1 || frame.hoverResizeCol !== -1) {
      frame.hoverHeaderCol = -1;
      frame.hoverResizeCol = -1;
      this.invalidate();
    }
    this.setCursor('');
  };

  /** Escape during a resize or reorder drag puts things back. Returns true when a drag was cancelled. */
  cancelDrag(): boolean {
    const drag = this.drag;
    const frame = this.frame;
    if (drag.kind === 'resize') {
      frame.widths[drag.col] = drag.startWidth;
      this.layout();
    }
    const active = drag.kind !== 'none';
    frame.reorderFrom = -1;
    frame.reorderTo = -1;
    frame.resizingCol = -1;
    this.drag = { kind: 'none' };
    this.setCursor('');
    this.invalidate();
    return active;
  }

  private endDrag(event: PointerEvent): void {
    this.drag = { kind: 'none' };
    this.frame.resizingCol = -1;
    if (this.autoScrollRaf !== 0) cancelAnimationFrame(this.autoScrollRaf);
    this.autoScrollRaf = 0;
    if (typeof this.scroller.releasePointerCapture === 'function') {
      try {
        this.scroller.releasePointerCapture(event.pointerId);
      } catch {
        // Not captured.
      }
    }
    this.setCursor(this.frame.hoverResizeCol >= 0 ? 'col-resize' : '');
    this.invalidate();
  }

  private setCursor(cursor: string): void {
    if (cursor === this.cursor) return;
    this.cursor = cursor;
    this.scroller.style.cursor = cursor;
  }

  // ---------------------------------------------------------------------------

  dispose(): void {
    this.disposed = true;
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    if (this.autoScrollRaf !== 0) cancelAnimationFrame(this.autoScrollRaf);
    if (this.reportTimer !== null) clearTimeout(this.reportTimer);
    this.unsubscribe?.();
    this.resizeObserver?.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    const fonts = typeof document === 'undefined' ? undefined : (document as Partial<Pick<Document, 'fonts'>>).fonts;
    fonts?.removeEventListener('loadingdone', this.onFontsLoaded);
    const scroller = this.scroller;
    scroller.removeEventListener('scroll', this.onScroll);
    scroller.removeEventListener('wheel', this.onWheel);
    scroller.removeEventListener('pointerdown', this.onPointerDown);
    scroller.removeEventListener('pointermove', this.onPointerMove);
    scroller.removeEventListener('pointerup', this.onPointerUp);
    scroller.removeEventListener('pointercancel', this.onPointerCancel);
    scroller.removeEventListener('pointerleave', this.onPointerLeave);
    scroller.removeEventListener('mousedown', this.onMouseDown);
  }
}
