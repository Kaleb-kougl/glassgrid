import type { ResolvedTokens } from '../tokens.js';
import { createColWindow, createRowWindow, type ColWindow, type RowWindow } from './geometry.js';
import { FitCache, FontMetrics, RowLabels, type MeasureContext } from './text.js';
import type { GridDataSource } from './types.js';

/** Column kinds as stored in `GridFrame.kinds`. */
export const KIND_TEXT = 0;
export const KIND_NUMBER = 1;
export const KIND_TEMPORAL = 2;

/** Sort state per column as stored in `GridFrame.sortDir`. */
export const SORT_NONE = 0;
export const SORT_ASC = 1;
export const SORT_DESC = 2;

/**
 * Everything one frame needs, owned and mutated in place by the controller
 * so painting allocates nothing.
 */
export interface GridFrame {
  /** Viewport (canvas) size in CSS px and the device pixel ratio. */
  width: number;
  height: number;
  dpr: number;
  rowHeight: number;
  headerHeight: number;
  cellPx: number;
  gutterWidth: number;
  rowCount: number;
  colCount: number;
  /** Per display column. */
  names: string[];
  kinds: Uint8Array;
  widths: Float64Array;
  offsets: Float64Array;
  sourceIndex: Int32Array;
  sortDir: Int8Array;
  source: GridDataSource | null;
  virtualTop: number;
  scrollLeft: number;
  /** The rows and columns to draw (visible plus overscan). */
  rows: RowWindow;
  cols: ColWindow;
  hasSelection: boolean;
  selTop: number;
  selBottom: number;
  selLeft: number;
  selRight: number;
  focusRow: number;
  focusCol: number;
  /** Header cell with keyboard focus, or -1. */
  headerFocusCol: number;
  /** The grid (its accessibility mirror) has focus. */
  hasFocus: boolean;
  hoverHeaderCol: number;
  hoverResizeCol: number;
  /** Column being resized, or -1. */
  resizingCol: number;
  /** Column being dragged to a new place, or -1; the pointer's viewport x; the target index. */
  reorderFrom: number;
  reorderX: number;
  reorderTo: number;
  emptyMessage: string;
  /** Written by `paintGrid`: visible rows with data / visible rows. */
  loadedRows: number;
  visibleRows: number;
}

export function createFrame(): GridFrame {
  return {
    width: 0,
    height: 0,
    dpr: 1,
    rowHeight: 32,
    headerHeight: 32,
    cellPx: 10,
    gutterWidth: 52,
    rowCount: 0,
    colCount: 0,
    names: [],
    kinds: new Uint8Array(0),
    widths: new Float64Array(0),
    offsets: new Float64Array(1),
    sourceIndex: new Int32Array(0),
    sortDir: new Int8Array(0),
    source: null,
    virtualTop: 0,
    scrollLeft: 0,
    rows: createRowWindow(),
    cols: createColWindow(),
    hasSelection: false,
    selTop: 0,
    selBottom: 0,
    selLeft: 0,
    selRight: 0,
    focusRow: -1,
    focusCol: -1,
    headerFocusCol: -1,
    hasFocus: false,
    hoverHeaderCol: -1,
    hoverResizeCol: -1,
    resizingCol: -1,
    reorderFrom: -1,
    reorderX: 0,
    reorderTo: -1,
    emptyMessage: 'No rows',
    loadedRows: 0,
    visibleRows: 0,
  };
}

/** The subset of CanvasRenderingContext2D the grid draws with. */
export type GridContext = Pick<
  CanvasRenderingContext2D,
  'fillRect' | 'fillText' | 'setTransform' | 'save' | 'restore' | 'beginPath' | 'rect' | 'clip'
> & {
  fillStyle: CanvasRenderingContext2D['fillStyle'];
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  fontKerning?: CanvasFontKerning;
};

const withUi = (tokens: ResolvedTokens, weight: number | string, size: number, style = '') =>
  `${style}${style ? ' ' : ''}${weight} ${size}px ${tokens.font.ui}`;
const withMono = (tokens: ResolvedTokens, weight: number | string, size: number) => `${weight} ${size}px ${tokens.font.mono}`;

/** Fonts and colours of one theme, plus measurement and string caches. */
export class PaintResources {
  readonly tokens: ResolvedTokens;
  readonly fonts: {
    readonly cell: string;
    readonly mono: string;
    readonly nullCell: string;
    readonly header: string;
    readonly headerSelected: string;
    readonly sort: string;
    readonly rowNumber: string;
    readonly rowNumberSelected: string;
    readonly empty: string;
  };
  readonly metrics: {
    readonly cell: FontMetrics;
    readonly mono: FontMetrics;
    readonly nullCell: FontMetrics;
    readonly header: FontMetrics;
    readonly headerSelected: FontMetrics;
    readonly sort: FontMetrics;
    readonly rowNumber: FontMetrics;
  };
  readonly rowLabels = new RowLabels(256);
  private readonly cellFits: FitCache[] = [];
  private readonly headerFits: FitCache[] = [];
  /** Placeholder bar widths (fractions of the cell's text room), varied so loading rows read as rows. */
  readonly placeholder = new Float64Array([0.62, 0.48, 0.74, 0.55, 0.68, 0.42, 0.58]);

  constructor(tokens: ResolvedTokens, measure: MeasureContext | null) {
    this.tokens = tokens;
    const t = tokens.type;
    this.fonts = {
      cell: withUi(tokens, t['grid-cell'].weight, t['grid-cell'].size),
      mono: withMono(tokens, t['grid-cell-num'].weight, t['grid-cell-num'].size),
      nullCell: withUi(tokens, t['grid-cell'].weight, t['grid-cell-num'].size, 'italic'),
      header: withUi(tokens, t['grid-header'].weight, t['grid-header'].size),
      headerSelected: withUi(tokens, 600, t['grid-header'].size),
      sort: withUi(tokens, 600, t['grid-header'].size),
      rowNumber: withMono(tokens, 400, 11),
      rowNumberSelected: withMono(tokens, 600, 11),
      empty: withUi(tokens, t['ui-md'].weight, t['ui-md'].size),
    };
    this.metrics = {
      cell: new FontMetrics(this.fonts.cell, measure),
      mono: new FontMetrics(this.fonts.mono, measure),
      nullCell: new FontMetrics(this.fonts.nullCell, measure),
      header: new FontMetrics(this.fonts.header, measure),
      headerSelected: new FontMetrics(this.fonts.headerSelected, measure),
      sort: new FontMetrics(this.fonts.sort, measure),
      rowNumber: new FontMetrics(this.fonts.rowNumber, measure),
    };
  }

  /** Every font family the grid draws with (to wait for before the first paint). */
  get fontList(): string[] {
    return Object.values(this.fonts);
  }

  cellFit(col: number): FitCache {
    while (this.cellFits.length <= col) this.cellFits.push(new FitCache());
    return this.cellFits[col] as FitCache;
  }

  headerFit(col: number): FitCache {
    while (this.headerFits.length <= col) this.headerFits.push(new FitCache(8));
    return this.headerFits[col] as FitCache;
  }
}

/** Sort arrows as drawn in the header (and announced by the mirror). */
export const SORT_ARROW_ASC = '↑';
export const SORT_ARROW_DESC = '↓';
const SORT_GAP = 4;
const PLACEHOLDER_HEIGHT = 10;
const FOCUS_WIDTH = 2;

function frameRect(ctx: GridContext, x: number, y: number, w: number, h: number, line: number): void {
  ctx.fillRect(x, y, w, line);
  ctx.fillRect(x, y + h - line, w, line);
  ctx.fillRect(x, y + line, line, h - 2 * line);
  ctx.fillRect(x + w - line, y + line, line, h - 2 * line);
}

/**
 * Draws one frame of the rows and columns in `frame.rows` / `frame.cols`
 * (computed by the controller); writes `frame.loadedRows` and
 * `frame.visibleRows`. Allocation-free once the strings on screen have been
 * fitted.
 */
export function paintGrid(ctx: GridContext, frame: GridFrame, res: PaintResources): void {
  const { width, height, dpr, rowHeight, headerHeight, cellPx, gutterWidth, rowCount, colCount } = frame;
  const tokens = res.tokens;
  const color = tokens.color;
  const grid = tokens.grid;
  const fonts = res.fonts;
  const metrics = res.metrics;
  const offsets = frame.offsets;
  const rows = frame.rows;
  const cols = frame.cols;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.textBaseline = 'middle';
  if (ctx.fontKerning !== undefined) ctx.fontKerning = 'none';

  // Background.
  ctx.fillStyle = color.gridBg;
  ctx.fillRect(0, 0, width, height);

  // Snap the scroll offset to device pixels so text and rules stay crisp.
  const virtualTop = Math.round(frame.virtualTop * dpr) / dpr;
  const scrollLeft = Math.round(frame.scrollLeft * dpr) / dpr;
  const contentRight = Math.min(width, (offsets[colCount] ?? gutterWidth) - scrollLeft);
  const bodyLeft = gutterWidth;
  const bodyWidth = Math.max(0, contentRight - bodyLeft);
  const firstRow = rows.first;
  const lastRow = rows.last;

  // ---- Body ------------------------------------------------------------------
  // Zebra.
  ctx.fillStyle = grid.zebra;
  for (let r = firstRow; r <= lastRow; r += 1) {
    if ((r & 1) === 1) ctx.fillRect(bodyLeft, headerHeight + r * rowHeight - virtualTop, bodyWidth, rowHeight);
  }

  // Selection fill under the text.
  const multi = frame.hasSelection && (frame.selTop !== frame.selBottom || frame.selLeft !== frame.selRight);
  let selX = 0;
  let selY = 0;
  let selW = 0;
  let selH = 0;
  if (frame.hasSelection) {
    selX = (offsets[frame.selLeft] ?? 0) - scrollLeft;
    const selRightX = (offsets[frame.selRight + 1] ?? 0) - scrollLeft;
    selY = headerHeight + frame.selTop * rowHeight - virtualTop;
    selH = (frame.selBottom - frame.selTop + 1) * rowHeight;
    selW = selRightX - selX;
    if (multi) {
      // Clamp to the body so huge selections stay finite.
      const top = Math.max(selY, headerHeight - 4);
      const bottom = Math.min(selY + selH, height + 4);
      if (bottom > top) {
        ctx.fillStyle = grid.selFill;
        ctx.fillRect(Math.max(selX, bodyLeft), top, Math.min(selRightX, contentRight) - Math.max(selX, bodyLeft), bottom - top);
      }
    }
  }

  // Cells, column by column so font and alignment change rarely.
  const source = frame.source;
  let loaded = 0;
  const textY = rowHeight / 2;
  for (let c = cols.first; c <= cols.last; c += 1) {
    const x = (offsets[c] ?? 0) - scrollLeft;
    const w = frame.widths[c] ?? 0;
    const room = w - cellPx * 2;
    if (room <= 0) continue;
    const kind = frame.kinds[c] ?? KIND_TEXT;
    const right = kind === KIND_NUMBER;
    const valueFont = kind === KIND_TEXT ? fonts.cell : fonts.mono;
    const valueMetrics = kind === KIND_TEXT ? metrics.cell : metrics.mono;
    const fit = res.cellFit(c);
    const nullFit = res.cellFit(colCount + c);
    const sourceCol = frame.sourceIndex[c] ?? c;
    const textX = right ? x + w - cellPx : x + cellPx;
    ctx.textAlign = right ? 'right' : 'left';
    // 0 = value, 1 = null, 2 = placeholder; set lazily.
    let style = -1;
    for (let r = firstRow; r <= lastRow; r += 1) {
      const top = headerHeight + r * rowHeight - virtualTop;
      const value = source ? source.getCell(r, sourceCol) : undefined;
      if (value === undefined) {
        if (style !== 2) {
          ctx.fillStyle = tokens.chart.skeleton;
          style = 2;
        }
        const barW = Math.max(8, Math.round(room * (res.placeholder[(r + c * 3) % res.placeholder.length] ?? 0.6)));
        ctx.fillRect(right ? x + w - cellPx - barW : x + cellPx, top + (rowHeight - PLACEHOLDER_HEIGHT) / 2, barW, PLACEHOLDER_HEIGHT);
        continue;
      }
      if (c === cols.first) loaded += 1;
      if (value === null) {
        if (style !== 1) {
          ctx.font = fonts.nullCell;
          ctx.fillStyle = grid.null;
          style = 1;
        }
        ctx.fillText(nullFit.get('null', room, metrics.nullCell), textX, top + textY);
        continue;
      }
      if (style !== 0) {
        ctx.font = valueFont;
        ctx.fillStyle = color.textPrimary;
        style = 0;
      }
      ctx.fillText(fit.get(value, room, valueMetrics), textX, top + textY);
    }
  }
  frame.loadedRows = cols.last >= cols.first ? loaded : 0;
  frame.visibleRows = lastRow >= firstRow ? rows.lastVisible - rows.firstVisible + 1 : 0;

  // ---- Gutter ------------------------------------------------------------------
  ctx.fillStyle = grid.headerBg;
  ctx.fillRect(0, headerHeight, gutterWidth, height - headerHeight);
  ctx.textAlign = 'right';
  let gutterFont = '';
  for (let r = firstRow; r <= lastRow; r += 1) {
    const top = headerHeight + r * rowHeight - virtualTop;
    const selected = frame.hasSelection && r >= frame.selTop && r <= frame.selBottom;
    const font = selected ? fonts.rowNumberSelected : fonts.rowNumber;
    if (font !== gutterFont) {
      ctx.font = font;
      ctx.fillStyle = selected ? color.accentText : color.textTertiary;
      gutterFont = font;
    }
    ctx.fillText(res.rowLabels.get(r), gutterWidth - cellPx, top + textY);
  }

  // Row rules across gutter and body.
  ctx.fillStyle = grid.line;
  for (let r = firstRow; r <= lastRow; r += 1) {
    ctx.fillRect(0, headerHeight + (r + 1) * rowHeight - virtualTop - 1, contentRight, 1);
  }
  ctx.fillRect(gutterWidth - 1, headerHeight, 1, Math.min(height, headerHeight + rowCount * rowHeight - virtualTop) - headerHeight);

  // Selection outline and focused cell, clipped to the body.
  if (frame.hasSelection && (multi || frame.focusRow >= 0)) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(bodyLeft, headerHeight, Math.max(0, width - bodyLeft), Math.max(0, height - headerHeight));
    ctx.clip();
    if (multi && selH > 0) {
      ctx.fillStyle = grid.selBorder;
      const top = Math.max(selY, headerHeight - 4);
      const bottom = Math.min(selY + selH, height + 4);
      if (bottom > top) {
        // Only the edges that are on screen.
        if (selY >= headerHeight - 4) ctx.fillRect(selX, selY, selW, 1);
        if (selY + selH <= height + 4) ctx.fillRect(selX, selY + selH - 1, selW, 1);
        ctx.fillRect(selX, top, 1, bottom - top);
        ctx.fillRect(selX + selW - 1, top, 1, bottom - top);
      }
    }
    if (frame.focusRow >= 0 && frame.focusCol >= 0 && frame.headerFocusCol < 0) {
      const fx = (offsets[frame.focusCol] ?? 0) - scrollLeft;
      const fy = headerHeight + frame.focusRow * rowHeight - virtualTop;
      if (fy + rowHeight > headerHeight && fy < height) {
        ctx.fillStyle = color.focus;
        frameRect(ctx, fx, fy, frame.widths[frame.focusCol] ?? 0, rowHeight, FOCUS_WIDTH);
      }
    }
    ctx.restore();
  }

  // ---- Header ------------------------------------------------------------------
  ctx.fillStyle = grid.headerBg;
  ctx.fillRect(0, 0, width, headerHeight);
  const headerY = headerHeight / 2;
  for (let c = cols.first; c <= cols.last; c += 1) {
    const x = (offsets[c] ?? 0) - scrollLeft;
    const w = frame.widths[c] ?? 0;
    const selected = frame.hasSelection && c >= frame.selLeft && c <= frame.selRight;
    if (selected) {
      ctx.fillStyle = grid.headerSelBg;
      ctx.fillRect(x, 0, w, headerHeight);
    }
    const dir = frame.sortDir[c] ?? SORT_NONE;
    const arrow = dir === SORT_ASC ? SORT_ARROW_ASC : dir === SORT_DESC ? SORT_ARROW_DESC : '';
    const arrowW = arrow ? metrics.sort.width(arrow) + SORT_GAP : 0;
    const nameMetrics = selected ? metrics.headerSelected : metrics.header;
    const name = res.headerFit(c).get(frame.names[c] ?? '', w - cellPx * 2 - arrowW, nameMetrics);
    const nameW = nameMetrics.width(name);
    const right = frame.kinds[c] === KIND_NUMBER;
    const nameX = right ? x + w - cellPx - arrowW - nameW : x + cellPx;
    ctx.font = selected ? fonts.headerSelected : fonts.header;
    ctx.fillStyle = selected || frame.hoverHeaderCol === c || frame.reorderFrom === c ? color.textPrimary : color.textSecondary;
    ctx.textAlign = 'left';
    ctx.fillText(name, nameX, headerY);
    if (arrow) {
      ctx.font = fonts.sort;
      ctx.fillStyle = color.accentText;
      ctx.fillText(arrow, nameX + nameW + SORT_GAP, headerY);
    }
    ctx.fillStyle = grid.line;
    ctx.fillRect(x + w - 1, 0, 1, headerHeight);
    if (frame.hasFocus && frame.headerFocusCol === c) {
      ctx.fillStyle = color.focus;
      frameRect(ctx, x, 0, w, headerHeight, FOCUS_WIDTH);
    }
  }
  ctx.fillStyle = grid.lineStrong;
  ctx.fillRect(0, headerHeight - 1, width, 1);
  // Corner.
  ctx.fillStyle = grid.headerBg;
  ctx.fillRect(0, 0, gutterWidth, headerHeight - 1);
  ctx.fillStyle = grid.line;
  ctx.fillRect(gutterWidth - 1, 0, 1, headerHeight);

  // ---- Overlays ----------------------------------------------------------------
  const edgeCol = frame.resizingCol >= 0 ? frame.resizingCol : frame.hoverResizeCol;
  if (edgeCol >= 0 && frame.reorderFrom < 0) {
    const edge = (offsets[edgeCol + 1] ?? 0) - scrollLeft;
    ctx.fillStyle = color.accent;
    ctx.fillRect(edge - 1, 0, 2, frame.resizingCol >= 0 ? height : headerHeight);
  }
  if (frame.reorderFrom >= 0) {
    const from = frame.reorderFrom;
    const w = frame.widths[from] ?? 0;
    // Ghost header following the pointer.
    const ghostX = Math.max(gutterWidth - w / 2, Math.min(width - w / 2, frame.reorderX - w / 2));
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = grid.headerSelBg;
    ctx.fillRect(ghostX, 0, w, headerHeight);
    ctx.globalAlpha = 1;
    ctx.fillStyle = grid.selBorder;
    frameRect(ctx, ghostX, 0, w, headerHeight, 1);
    ctx.font = fonts.headerSelected;
    ctx.fillStyle = color.textPrimary;
    ctx.textAlign = 'left';
    ctx.fillText(res.headerFit(from).get(frame.names[from] ?? '', w - cellPx * 2, metrics.headerSelected), ghostX + cellPx, headerY);
    // Insertion marker at the target gap.
    const to = frame.reorderTo;
    if (to >= 0) {
      const gap = to <= from ? (offsets[to] ?? 0) : (offsets[to + 1] ?? 0);
      ctx.fillStyle = color.accent;
      ctx.fillRect(gap - scrollLeft - 1, 0, 2, height);
    }
  }

  if (rowCount === 0 && colCount >= 0) {
    ctx.font = fonts.empty;
    ctx.fillStyle = color.textSecondary;
    ctx.textAlign = 'left';
    ctx.fillText(frame.emptyMessage, gutterWidth + 24, headerHeight + 32);
  }
}
