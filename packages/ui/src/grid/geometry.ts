/*
 * Pure layout math for the canvas grid: scroll mapping, visible windows,
 * hit-testing and scroll-into-view. No DOM, no allocation in the functions
 * the paint loop calls (they write into caller-owned `out` objects).
 */

/**
 * Largest spacer the grid puts in its scroll container. Chromium caps
 * element heights near 33.5M px, Firefox near 17.9M px; 16M keeps the web
 * demo safe everywhere. Past it the scroll position is mapped onto rows
 * through a scaled coordinate space, so every row stays reachable.
 */
export const MAX_SCROLL_HEIGHT = 16_000_000;

/** Rows a source pages at a time. */
export const PAGE_SIZE = 1_000;

/** Rows and columns drawn beyond the visible window. */
export const OVERSCAN = 1;

/** Half-width of the column-resize hit zone around a header's right edge. */
export const RESIZE_HANDLE = 4;

/** Narrowest a column can be resized to. */
export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 2_000;

export interface ScrollMapping {
  /** True when the virtual height exceeds the spacer and positions are scaled. */
  readonly scaled: boolean;
  /** rowCount × rowHeight: the unscaled content height of the body. */
  readonly virtualHeight: number;
  /** Height of the body spacer actually put in the DOM. */
  readonly spacerHeight: number;
  /** Largest scrollTop (spacer minus viewport body height, at least 0). */
  readonly scrollRange: number;
  /** Largest virtual offset (virtual height minus viewport body height, at least 0). */
  readonly virtualRange: number;
}

export function createScrollMapping(
  rowCount: number,
  rowHeight: number,
  bodyHeight: number,
  maxScrollHeight: number = MAX_SCROLL_HEIGHT,
): ScrollMapping {
  const virtualHeight = Math.max(0, rowCount) * rowHeight;
  const spacerHeight = Math.min(virtualHeight, maxScrollHeight);
  const body = Math.max(0, bodyHeight);
  return {
    scaled: virtualHeight > spacerHeight,
    virtualHeight,
    spacerHeight,
    scrollRange: Math.max(0, spacerHeight - body),
    virtualRange: Math.max(0, virtualHeight - body),
  };
}

/** Virtual (unscaled) offset of the body's top edge for a scrollTop. */
export function scrollToVirtual(mapping: ScrollMapping, scrollTop: number): number {
  const top = Math.max(0, Math.min(scrollTop, mapping.scrollRange));
  if (!mapping.scaled) return top;
  if (mapping.scrollRange <= 0) return 0;
  return (top / mapping.scrollRange) * mapping.virtualRange;
}

/** scrollTop that puts virtual offset `virtualTop` at the body's top edge. */
export function virtualToScroll(mapping: ScrollMapping, virtualTop: number): number {
  const top = clampVirtual(mapping, virtualTop);
  if (!mapping.scaled) return top;
  if (mapping.virtualRange <= 0) return 0;
  return (top / mapping.virtualRange) * mapping.scrollRange;
}

export function clampVirtual(mapping: ScrollMapping, virtualTop: number): number {
  return Math.max(0, Math.min(virtualTop, mapping.virtualRange));
}

export interface RowWindow {
  /** First and last row drawn (visible plus overscan); last < first when there are no rows. */
  first: number;
  last: number;
  /** First and last row at least partly inside the body. */
  firstVisible: number;
  lastVisible: number;
}

export function createRowWindow(): RowWindow {
  return { first: 0, last: -1, firstVisible: 0, lastVisible: -1 };
}

/** Rows intersecting a body of `bodyHeight` px whose top edge is at `virtualTop`. */
export function visibleRows(
  virtualTop: number,
  bodyHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan: number,
  out: RowWindow,
): RowWindow {
  if (rowCount <= 0 || bodyHeight <= 0) {
    out.first = 0;
    out.last = -1;
    out.firstVisible = 0;
    out.lastVisible = -1;
    return out;
  }
  const firstVisible = Math.min(rowCount - 1, Math.max(0, Math.floor(virtualTop / rowHeight)));
  // A row whose top edge is exactly at the body's bottom edge is not visible.
  const lastVisible = Math.min(rowCount - 1, Math.max(firstVisible, Math.ceil((virtualTop + bodyHeight) / rowHeight) - 1));
  out.firstVisible = firstVisible;
  out.lastVisible = lastVisible;
  out.first = Math.max(0, firstVisible - overscan);
  out.last = Math.min(rowCount - 1, lastVisible + overscan);
  return out;
}

/**
 * Left edges of the columns in content coordinates (the row-number gutter
 * starts at 0, so column 0 starts at `gutterWidth`). Has `widths.length + 1`
 * entries; the last one is the content's right edge.
 */
export function columnOffsets(widths: ArrayLike<number>, gutterWidth: number, out?: Float64Array): Float64Array {
  const offsets = out && out.length === widths.length + 1 ? out : new Float64Array(widths.length + 1);
  let x = gutterWidth;
  for (let i = 0; i < widths.length; i += 1) {
    offsets[i] = x;
    x += widths[i] ?? 0;
  }
  offsets[widths.length] = x;
  return offsets;
}

/** Index of the column containing content x, or -1 left of the first / right of the last column. */
export function columnAt(offsets: Float64Array, x: number): number {
  const count = offsets.length - 1;
  if (count <= 0 || x < (offsets[0] ?? 0) || x >= (offsets[count] ?? 0)) return -1;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] ?? 0) <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface ColWindow {
  first: number;
  last: number;
}

export function createColWindow(): ColWindow {
  return { first: 0, last: -1 };
}

/**
 * Columns intersecting the body: screen x from `gutterWidth` to
 * `viewportWidth`, scrolled by `scrollLeft`, plus overscan.
 */
export function visibleColumns(
  offsets: Float64Array,
  scrollLeft: number,
  viewportWidth: number,
  gutterWidth: number,
  overscan: number,
  out: ColWindow,
): ColWindow {
  const count = offsets.length - 1;
  const left = scrollLeft + gutterWidth;
  const right = scrollLeft + viewportWidth;
  if (count <= 0 || right <= left) {
    out.first = 0;
    out.last = -1;
    return out;
  }
  let first = columnAt(offsets, left);
  if (first < 0) first = left < (offsets[0] ?? 0) ? 0 : count;
  let last = columnAt(offsets, right - 0.001);
  if (last < 0) last = count - 1;
  if (first > last) {
    out.first = 0;
    out.last = -1;
    return out;
  }
  out.first = Math.max(0, first - overscan);
  out.last = Math.min(count - 1, last + overscan);
  return out;
}

export type HitArea = 'corner' | 'header' | 'gutter' | 'cell' | 'outside';

export interface HitResult {
  area: HitArea;
  /** Row under the point (cell and gutter areas), else -1. */
  row: number;
  /** Display column under the point (cell and header areas), else -1. */
  col: number;
  /** In the header: the column whose right edge is within the resize handle, else -1. */
  resizeCol: number;
}

export function createHitResult(): HitResult {
  return { area: 'outside', row: -1, col: -1, resizeCol: -1 };
}

export interface HitLayout {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly headerHeight: number;
  readonly rowHeight: number;
  readonly gutterWidth: number;
  readonly rowCount: number;
  readonly virtualTop: number;
  readonly scrollLeft: number;
  readonly offsets: Float64Array;
}

/** What is under viewport point (x, y): header, gutter, a cell or a resize edge. */
export function hitTest(layout: HitLayout, x: number, y: number, out: HitResult = createHitResult()): HitResult {
  out.area = 'outside';
  out.row = -1;
  out.col = -1;
  out.resizeCol = -1;
  if (x < 0 || y < 0 || x >= layout.viewportWidth || y >= layout.viewportHeight) return out;
  const inHeader = y < layout.headerHeight;
  const inGutter = x < layout.gutterWidth;
  if (inHeader && inGutter) {
    out.area = 'corner';
    return out;
  }
  const contentX = x + layout.scrollLeft;
  if (inHeader) {
    out.area = 'header';
    out.col = columnAt(layout.offsets, contentX);
    // Resize edge: nearest right edge within the handle (the edge belongs to the column on its left).
    const count = layout.offsets.length - 1;
    // Just past the last column still grabs its edge.
    const near = out.col >= 0 ? out.col : contentX >= (layout.offsets[count] ?? 0) ? count - 1 : -1;
    for (let c = Math.max(0, near - 1); near >= 0 && c <= Math.min(count - 1, near + 1); c += 1) {
      const edge = (layout.offsets[c + 1] ?? 0) - layout.scrollLeft;
      if (Math.abs(x - edge) <= RESIZE_HANDLE && edge > layout.gutterWidth) {
        out.resizeCol = c;
        break;
      }
    }
    if (out.col < 0 && out.resizeCol < 0) out.area = 'outside';
    return out;
  }
  const row = rowAtY(layout, y);
  if (row < 0) return out;
  out.row = row;
  if (inGutter) {
    out.area = 'gutter';
    return out;
  }
  out.col = columnAt(layout.offsets, contentX);
  out.area = out.col < 0 ? 'outside' : 'cell';
  return out;
}

/** Row at viewport y (below the header), or -1 past the last row. */
export function rowAtY(layout: Pick<HitLayout, 'headerHeight' | 'rowHeight' | 'rowCount' | 'virtualTop'>, y: number): number {
  const row = Math.floor((y - layout.headerHeight + layout.virtualTop) / layout.rowHeight);
  return row < 0 || row >= layout.rowCount ? -1 : row;
}

/** Like `rowAtY` but clamped into 0..rowCount-1 (for drag selection past the edges). */
export function clampedRowAtY(layout: Pick<HitLayout, 'headerHeight' | 'rowHeight' | 'rowCount' | 'virtualTop'>, y: number): number {
  const row = Math.floor((y - layout.headerHeight + layout.virtualTop) / layout.rowHeight);
  return Math.max(0, Math.min(layout.rowCount - 1, row));
}

/** Like `columnAt` for a viewport x, clamped to the first/last column. */
export function clampedColumnAtX(offsets: Float64Array, scrollLeft: number, gutterWidth: number, x: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return -1;
  const contentX = Math.max(x, gutterWidth) + scrollLeft;
  const col = columnAt(offsets, contentX);
  if (col >= 0) return col;
  return contentX < (offsets[0] ?? 0) ? 0 : count - 1;
}

/** Virtual top that brings `row` fully into a body of `bodyHeight` px, moving as little as possible. */
export function scrollTopForRow(row: number, virtualTop: number, bodyHeight: number, rowHeight: number): number {
  const top = row * rowHeight;
  if (top < virtualTop) return top;
  if (top + rowHeight > virtualTop + bodyHeight) return Math.max(0, top + rowHeight - bodyHeight);
  return virtualTop;
}

/** scrollLeft that brings column `col` fully into view right of the gutter, moving as little as possible. */
export function scrollLeftForColumn(
  offsets: Float64Array,
  col: number,
  scrollLeft: number,
  viewportWidth: number,
  gutterWidth: number,
): number {
  const left = (offsets[col] ?? 0) - gutterWidth;
  const right = offsets[col + 1] ?? 0;
  if (left < scrollLeft) return Math.max(0, left);
  if (right > scrollLeft + viewportWidth) return Math.max(0, Math.min(left, right - viewportWidth));
  return scrollLeft;
}

/** Whole rows that fit in the body (for Page Up/Down), at least 1. */
export function rowsPerPage(bodyHeight: number, rowHeight: number): number {
  return Math.max(1, Math.floor(bodyHeight / rowHeight));
}

/** Gutter width that fits the largest row number in `digitWidth` px digits. */
export function gutterWidthFor(rowCount: number, digitWidth: number, paddingX: number, minWidth: number): number {
  const digits = String(Math.max(1, rowCount)).length;
  return Math.max(minWidth, Math.ceil(digits * digitWidth + paddingX * 2));
}

/** Target index of a column dragged to content x: the gap nearest x, as an index into the list without the dragged column. */
export function reorderTarget(offsets: Float64Array, from: number, contentX: number): number {
  const count = offsets.length - 1;
  let gap = count;
  for (let i = 0; i < count; i += 1) {
    const mid = ((offsets[i] ?? 0) + (offsets[i + 1] ?? 0)) / 2;
    if (contentX < mid) {
      gap = i;
      break;
    }
  }
  // Gap i means "before column i" in the original order; remove the dragged column.
  return gap > from ? gap - 1 : gap;
}
