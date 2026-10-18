/*
 * Hit-test indexes, one per mark, built once per result (or per layout for
 * pixel-space indexes) so hovering is a lookup, not a scan:
 *
 * - line / area: binary search on x within each series' sorted rows;
 * - histogram / heatmap: binary search over the sorted bin edges;
 * - scatter: a uniform grid of pixel cells (counting sort), searched in the
 *   cells around the pointer.
 */

/** First index in `sorted[lo, hi)` whose value is ≥ `value` (via `key`). */
export function lowerBound(n: number, value: number, key: (i: number) => number, lo = 0, hi = n): number {
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = (a + b) >>> 1;
    if (key(mid) < value) a = mid + 1;
    else b = mid;
  }
  return a;
}

/**
 * Row (from `order[start, end)`, sorted by `xs`) whose x is nearest to
 * `value`, or -1 for an empty range. Ties prefer the earlier row.
 */
export function nearestSorted(xs: ArrayLike<number>, order: ArrayLike<number>, start: number, end: number, value: number): number {
  if (end <= start) return -1;
  const key = (k: number) => xs[order[k] ?? 0] ?? Number.NaN;
  const k = lowerBound(end, value, key, start, end);
  if (k <= start) return order[start] ?? -1;
  if (k >= end) return order[end - 1] ?? -1;
  const before = order[k - 1] ?? 0;
  const after = order[k] ?? 0;
  return value - (xs[before] ?? 0) <= (xs[after] ?? 0) - value ? before : after;
}

/** Sorted, de-duplicated bins `[start, end)` and the rows in each. */
export interface BinIndex {
  readonly starts: Float64Array;
  readonly ends: Float64Array;
  /** Rows of bin b: `rows[rowStart[b], rowStart[b + 1])`, in result-row order of `order`. */
  readonly rowStart: Uint32Array;
  readonly rows: Uint32Array;
}

/**
 * Groups rows into bins by their start value (`x`), sorted ascending. Rows
 * of one bin (one per series) keep the order they have in `order`.
 */
export function buildBinIndex(starts: ArrayLike<number>, ends: ArrayLike<number> | null, order: ArrayLike<number>): BinIndex {
  const n = order.length;
  const sorted = Uint32Array.from(order);
  const rank = new Uint32Array(starts.length);
  for (let k = 0; k < n; k += 1) rank[order[k] ?? 0] = k;
  sorted.sort((a, b) => (starts[a] ?? 0) - (starts[b] ?? 0) || (rank[a] ?? 0) - (rank[b] ?? 0));
  const binStarts: number[] = [];
  const binEnds: number[] = [];
  const rowStart: number[] = [];
  for (let k = 0; k < n; k += 1) {
    const row = sorted[k] ?? 0;
    const s = starts[row] ?? Number.NaN;
    if (binStarts.length === 0 || binStarts[binStarts.length - 1] !== s) {
      binStarts.push(s);
      binEnds.push(ends ? (ends[row] ?? s) : s);
      rowStart.push(k);
    } else if (ends) {
      const e = ends[row] ?? s;
      if (e > (binEnds[binEnds.length - 1] ?? -Infinity)) binEnds[binEnds.length - 1] = e;
    }
  }
  rowStart.push(n);
  return { starts: Float64Array.from(binStarts), ends: Float64Array.from(binEnds), rowStart: Uint32Array.from(rowStart), rows: sorted };
}

/** Index of the bin with `start <= value < end`, or -1 (gaps between returned bins are empty bins). */
export function binAt(index: BinIndex, value: number): number {
  const { starts, ends } = index;
  const k = lowerBound(starts.length, value, (i) => starts[i] ?? Number.NaN) ;
  // k is the first bin starting at or after value: the containing bin is k (exact start) or k - 1.
  if (k < starts.length && starts[k] === value) return k;
  const b = k - 1;
  if (b >= 0 && value < (ends[b] ?? -Infinity)) return b;
  return -1;
}

/** Sorted unique values of `a` (and `b`) that are finite. */
export function uniqueSorted(a: ArrayLike<number>, b?: ArrayLike<number> | null): Float64Array {
  const set = new Set<number>();
  for (let i = 0; i < a.length; i += 1) {
    const v = a[i] ?? Number.NaN;
    if (Number.isFinite(v)) set.add(v);
  }
  if (b) {
    for (let i = 0; i < b.length; i += 1) {
      const v = b[i] ?? Number.NaN;
      if (Number.isFinite(v)) set.add(v);
    }
  }
  return Float64Array.from(set).sort();
}

/** A 2-D bin grid: unique x and y bin starts and the row in each cell (-1 for empty cells). */
export interface GridIndex {
  readonly xStarts: Float64Array;
  readonly xEnds: Float64Array;
  readonly yStarts: Float64Array;
  readonly yEnds: Float64Array;
  /** Row of cell (i, j) at `cells[j * xStarts.length + i]`, or -1. */
  readonly cells: Int32Array;
}

function binsOf(starts: ArrayLike<number>, ends: ArrayLike<number>): { s: Float64Array; e: Float64Array } {
  const map = new Map<number, number>();
  for (let i = 0; i < starts.length; i += 1) {
    const s = starts[i] ?? Number.NaN;
    if (!Number.isFinite(s)) continue;
    const e = ends[i] ?? s;
    map.set(s, Math.max(map.get(s) ?? -Infinity, e));
  }
  const s = Float64Array.from(map.keys()).sort();
  const e = Float64Array.from(s, (v) => map.get(v) ?? v);
  return { s, e };
}

export function buildGridIndex(x: ArrayLike<number>, xEnd: ArrayLike<number>, y: ArrayLike<number>, yEnd: ArrayLike<number>): GridIndex {
  const xb = binsOf(x, xEnd);
  const yb = binsOf(y, yEnd);
  const nx = xb.s.length;
  const cells = new Int32Array(nx * yb.s.length).fill(-1);
  const xPos = new Map<number, number>();
  xb.s.forEach((v, i) => xPos.set(v, i));
  const yPos = new Map<number, number>();
  yb.s.forEach((v, j) => yPos.set(v, j));
  for (let r = 0; r < x.length; r += 1) {
    const i = xPos.get(x[r] ?? Number.NaN);
    const j = yPos.get(y[r] ?? Number.NaN);
    if (i !== undefined && j !== undefined) cells[j * nx + i] = r;
  }
  return { xStarts: xb.s, xEnds: xb.e, yStarts: yb.s, yEnds: yb.e, cells };
}

function binOf(starts: Float64Array, ends: Float64Array, value: number): number {
  const k = lowerBound(starts.length, value, (i) => starts[i] ?? Number.NaN);
  if (k < starts.length && starts[k] === value) return k;
  const b = k - 1;
  return b >= 0 && value < (ends[b] ?? -Infinity) ? b : -1;
}

/** Row of the heatmap cell containing (xValue, yValue), or -1. */
export function gridCellAt(index: GridIndex, xValue: number, yValue: number): number {
  const i = binOf(index.xStarts, index.xEnds, xValue);
  const j = binOf(index.yStarts, index.yEnds, yValue);
  if (i < 0 || j < 0) return -1;
  return index.cells[j * index.xStarts.length + i] ?? -1;
}

/** Uniform grid over pixel space: points bucketed by cell (counting sort). */
export interface PointGrid {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly left: number;
  readonly top: number;
  /** Points of cell c: `points[cellStart[c], cellStart[c + 1])`. */
  readonly cellStart: Uint32Array;
  readonly points: Uint32Array;
  readonly px: Float32Array;
  readonly py: Float32Array;
}

/**
 * Buckets `n` points at pixel positions (`toX(i)`, `toY(i)`) into `cell`-px
 * cells over the rectangle. Points outside it (or NaN) are left out.
 */
export function buildPointGrid(
  n: number,
  toX: (i: number) => number,
  toY: (i: number) => number,
  rect: { left: number; top: number; width: number; height: number },
  cell = 8,
): PointGrid {
  const cols = Math.max(1, Math.ceil(rect.width / cell) + 1);
  const rows = Math.max(1, Math.ceil(rect.height / cell) + 1);
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const cellOf = new Int32Array(n);
  const counts = new Uint32Array(cols * rows + 1);
  for (let i = 0; i < n; i += 1) {
    const x = toX(i);
    const y = toY(i);
    px[i] = x;
    py[i] = y;
    const cx = Math.floor((x - rect.left) / cell);
    const cy = Math.floor((y - rect.top) / cell);
    if (!(cx >= 0 && cx < cols && cy >= 0 && cy < rows)) {
      cellOf[i] = -1;
      continue;
    }
    const c = cy * cols + cx;
    cellOf[i] = c;
    counts[c + 1] = (counts[c + 1] ?? 0) + 1;
  }
  for (let c = 1; c < counts.length; c += 1) counts[c] = (counts[c] ?? 0) + (counts[c - 1] ?? 0);
  const cellStart = counts.slice();
  const cursor = counts.slice(0, cols * rows);
  const points = new Uint32Array(counts[cols * rows] ?? 0);
  for (let i = 0; i < n; i += 1) {
    const c = cellOf[i] ?? -1;
    if (c < 0) continue;
    points[cursor[c] ?? 0] = i;
    cursor[c] = (cursor[c] ?? 0) + 1;
  }
  return { cell, cols, rows, left: rect.left, top: rect.top, cellStart, points, px, py };
}

/** The point nearest to (x, y) within `radius` px, or -1. Ties prefer the later point (drawn on top). */
export function nearestPoint(grid: PointGrid, x: number, y: number, radius: number): number {
  const c0 = Math.max(0, Math.floor((x - radius - grid.left) / grid.cell));
  const c1 = Math.min(grid.cols - 1, Math.floor((x + radius - grid.left) / grid.cell));
  const r0 = Math.max(0, Math.floor((y - radius - grid.top) / grid.cell));
  const r1 = Math.min(grid.rows - 1, Math.floor((y + radius - grid.top) / grid.cell));
  let best = -1;
  let bestD = radius * radius;
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      const cell = r * grid.cols + c;
      const end = grid.cellStart[cell + 1] ?? 0;
      for (let k = grid.cellStart[cell] ?? 0; k < end; k += 1) {
        const i = grid.points[k] ?? 0;
        const dx = (grid.px[i] ?? 0) - x;
        const dy = (grid.py[i] ?? 0) - y;
        const d = dx * dx + dy * dy;
        if (d < bestD || (d === bestD && i > best)) {
          bestD = d;
          best = i;
        }
      }
    }
  }
  return best;
}
