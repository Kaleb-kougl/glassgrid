import type { PlotRect } from './axes.js';
import { boundToNumber, numberToBound } from './format.js';
import { lowerBound } from './hit.js';
import type { AxisScale } from './scales.js';
import type { AxisKind, IntervalSelection } from './types.js';

/*
 * Brush state machine, pure and framework-free. A brush lives in data space
 * (numbers; epoch ms on time axes) so it survives resizes and re-layouts;
 * pointer positions are converted through the axis scales.
 *
 *   pointer down outside the brush → create (drag out a new interval;
 *                                    a click without a drag clears)
 *   pointer down inside            → move (keeps the width)
 *   pointer down on an edge handle → resize that edge (corners resize both axes)
 *   double-click / Escape          → clear
 *   arrows                         → move by one bin (or 2% of the axis);
 *                                    Shift+arrows resize the upper edge
 *   Enter / Space without a brush  → create one in the middle of the axis
 */

/** A brush interval in data units, `x0 <= x1` (and `y0 <= y1` for 2-D brushes). */
export interface Brush {
  readonly x0: number;
  readonly x1: number;
  readonly y0?: number;
  readonly y1?: number;
}

/** `x`: a 1-D brush over the full plot height; `xy`: a rectangle. */
export type BrushDims = 'x' | 'xy';

/** Snaps values to bin edges (histogram and heatmap). */
export interface Snapper {
  floor(value: number): number;
  ceil(value: number): number;
  nearest(value: number): number;
  /** The edge after (`dir` 1) or before (`dir` -1) the edge nearest `value`. */
  step(value: number, dir: 1 | -1): number;
}

export interface BrushAxes {
  readonly x: AxisScale;
  readonly y: AxisScale;
  readonly plot: PlotRect;
  readonly dims: BrushDims;
  readonly snapX?: Snapper | null;
  readonly snapY?: Snapper | null;
}

type Edge = 'x0' | 'x1' | 'y0' | 'y1';

export type BrushTarget = { readonly kind: 'inside' } | { readonly kind: 'edges'; readonly edges: readonly Edge[] } | null;

export type BrushDrag =
  | { readonly kind: 'create'; readonly originX: number; readonly originY: number; readonly px: number; readonly py: number; readonly previous: Brush | null }
  | { readonly kind: 'move'; readonly start: Brush; readonly grabX: number; readonly grabY: number }
  | { readonly kind: 'resize'; readonly start: Brush; readonly edges: readonly Edge[] };

/** Pixels around an edge that grab it (the visible handle is narrower). */
export const HANDLE_SLOP = 5;
/** Pointer travel before a press turns into a new brush. */
export const DRAG_THRESHOLD = 3;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A brush in pixel space (left/right/top/bottom), the full plot height for 1-D brushes. */
export function brushRect(brush: Brush, axes: BrushAxes): { left: number; right: number; top: number; bottom: number } {
  const { plot } = axes;
  const a = axes.x.toPx(brush.x0);
  const b = axes.x.toPx(brush.x1);
  let top = plot.top;
  let bottom = plot.top + plot.height;
  if (axes.dims === 'xy' && brush.y0 !== undefined && brush.y1 !== undefined) {
    const c = axes.y.toPx(brush.y0);
    const d = axes.y.toPx(brush.y1);
    top = Math.min(c, d);
    bottom = Math.max(c, d);
  }
  return { left: Math.min(a, b), right: Math.max(a, b), top, bottom };
}

/** What a press at (px, py) would grab. */
export function hitBrushTarget(brush: Brush | null, axes: BrushAxes, px: number, py: number): BrushTarget {
  if (!brush) return null;
  const r = brushRect(brush, axes);
  const inY = py >= r.top - HANDLE_SLOP && py <= r.bottom + HANDLE_SLOP;
  const inX = px >= r.left - HANDLE_SLOP && px <= r.right + HANDLE_SLOP;
  if (!inX || !inY) return null;
  // x edges in pixel order map to data edges by the scale's direction.
  const xForward = axes.x.toPx(brush.x1) >= axes.x.toPx(brush.x0);
  const edges: Edge[] = [];
  if (Math.abs(px - r.left) <= HANDLE_SLOP) edges.push(xForward ? 'x0' : 'x1');
  else if (Math.abs(px - r.right) <= HANDLE_SLOP) edges.push(xForward ? 'x1' : 'x0');
  if (axes.dims === 'xy' && brush.y0 !== undefined && brush.y1 !== undefined) {
    const yUp = axes.y.toPx(brush.y1) <= axes.y.toPx(brush.y0);
    if (Math.abs(py - r.top) <= HANDLE_SLOP) edges.push(yUp ? 'y1' : 'y0');
    else if (Math.abs(py - r.bottom) <= HANDLE_SLOP) edges.push(yUp ? 'y0' : 'y1');
  }
  if (edges.length > 0) return { kind: 'edges', edges };
  if (px > r.left && px < r.right && py > r.top && py < r.bottom) return { kind: 'inside' };
  return null;
}

function xDomain(axes: BrushAxes): [number, number] {
  const [a, b] = axes.x.domain;
  return [Math.min(a, b), Math.max(a, b)];
}

function yDomain(axes: BrushAxes): [number, number] {
  const [a, b] = axes.y.domain;
  return [Math.min(a, b), Math.max(a, b)];
}

function dataX(axes: BrushAxes, px: number): number {
  const [lo, hi] = xDomain(axes);
  return clamp(axes.x.fromPx(px), lo, hi);
}

function dataY(axes: BrushAxes, py: number): number {
  const [lo, hi] = yDomain(axes);
  return clamp(axes.y.fromPx(py), lo, hi);
}

/** Starts a drag at (px, py) on `brush` (or on no brush). */
export function beginDrag(brush: Brush | null, axes: BrushAxes, px: number, py: number): BrushDrag {
  const target = hitBrushTarget(brush, axes, px, py);
  if (brush && target?.kind === 'edges') return { kind: 'resize', start: brush, edges: target.edges };
  if (brush && target?.kind === 'inside') return { kind: 'move', start: brush, grabX: dataX(axes, px), grabY: dataY(axes, py) };
  return { kind: 'create', originX: dataX(axes, px), originY: dataY(axes, py), px, py, previous: brush };
}

/** Whether a create drag has travelled far enough to become a brush. */
export function dragMoved(drag: BrushDrag, px: number, py: number): boolean {
  if (drag.kind !== 'create') return true;
  return Math.abs(px - drag.px) >= DRAG_THRESHOLD || Math.abs(py - drag.py) >= DRAG_THRESHOLD;
}

/** Interval [lo, hi] snapped outwards (create) so it covers whole bins, never empty. */
function snapOut(lo: number, hi: number, snap: Snapper | null | undefined): [number, number] {
  if (!snap) return [lo, hi];
  const a = snap.floor(lo);
  let b = snap.ceil(hi);
  if (b <= a) b = snap.step(a, 1);
  return [a, b];
}

function moveInterval(lo: number, hi: number, delta: number, domain: [number, number], snap: Snapper | null | undefined): [number, number] {
  const width = hi - lo;
  let a = clamp(lo + delta, domain[0], Math.max(domain[0], domain[1] - width));
  if (snap) {
    const snapped = snap.nearest(a);
    const shift = snapped - lo;
    a = snapped;
    const b = shift === 0 ? hi : snap.nearest(hi + shift);
    return b > a ? [a, b] : [a, a + width];
  }
  return [a, a + width];
}

function resizeEdge(fixed: number, moving: number, snap: Snapper | null | undefined): [number, number] {
  let m = snap ? snap.nearest(moving) : moving;
  if (snap && m === fixed) m = snap.step(fixed, moving >= fixed ? 1 : -1);
  return fixed <= m ? [fixed, m] : [m, fixed];
}

/**
 * The brush after dragging to (px, py). A create drag that has not moved
 * past the threshold yields the brush it started on.
 */
export function dragBrush(drag: BrushDrag, axes: BrushAxes, px: number, py: number): Brush | null {
  const xd = xDomain(axes);
  const yd = yDomain(axes);
  const vx = dataX(axes, px);
  const vy = dataY(axes, py);
  const xy = axes.dims === 'xy';
  switch (drag.kind) {
    case 'create': {
      if (!dragMoved(drag, px, py)) return drag.previous;
      const [x0, x1] = snapOut(Math.min(drag.originX, vx), Math.max(drag.originX, vx), axes.snapX);
      if (!xy) return { x0, x1 };
      const [y0, y1] = snapOut(Math.min(drag.originY, vy), Math.max(drag.originY, vy), axes.snapY);
      return { x0, x1, y0, y1 };
    }
    case 'move': {
      const { start } = drag;
      const [x0, x1] = moveInterval(start.x0, start.x1, vx - drag.grabX, xd, axes.snapX);
      if (!xy || start.y0 === undefined || start.y1 === undefined) return { x0, x1 };
      const [y0, y1] = moveInterval(start.y0, start.y1, vy - drag.grabY, yd, axes.snapY);
      return { x0, x1, y0, y1 };
    }
    case 'resize': {
      let { x0, x1, y0, y1 } = drag.start;
      for (const edge of drag.edges) {
        if (edge === 'x0') [x0, x1] = resizeEdge(x1, vx, axes.snapX);
        else if (edge === 'x1') [x0, x1] = resizeEdge(x0, vx, axes.snapX);
        else if (edge === 'y0' && y1 !== undefined) [y0, y1] = resizeEdge(y1, vy, axes.snapY);
        else if (edge === 'y1' && y0 !== undefined) [y0, y1] = resizeEdge(y0, vy, axes.snapY);
      }
      return xy && y0 !== undefined && y1 !== undefined ? { x0, x1, y0, y1 } : { x0, x1 };
    }
  }
}

/**
 * The brush after a pointer release: a create drag that never moved clears
 * the brush (a click outside it); anything else is the last dragged brush.
 */
export function endDrag(drag: BrushDrag, axes: BrushAxes, px: number, py: number): Brush | null {
  if (drag.kind === 'create' && !dragMoved(drag, px, py)) return null;
  return dragBrush(drag, axes, px, py);
}

function keyStep(lo: number, hi: number, dir: 1 | -1, domain: [number, number], snap: Snapper | null | undefined): number {
  if (snap) return snap.step(dir > 0 ? hi : lo, dir) - (dir > 0 ? hi : lo);
  return ((domain[1] - domain[0]) / 50) * dir;
}

/** Default brush for keyboard creation: the middle fifth of each axis, snapped outwards. */
export function defaultBrush(axes: BrushAxes): Brush {
  const xd = xDomain(axes);
  const xs = xd[1] - xd[0];
  const [x0, x1] = snapOut(xd[0] + xs * 0.4, xd[0] + xs * 0.6, axes.snapX);
  if (axes.dims !== 'xy') return { x0, x1 };
  const yd = yDomain(axes);
  const ys = yd[1] - yd[0];
  const [y0, y1] = snapOut(yd[0] + ys * 0.4, yd[0] + ys * 0.6, axes.snapY);
  return { x0, x1, y0, y1 };
}

export interface KeyResult {
  readonly handled: boolean;
  readonly brush: Brush | null;
}

/**
 * Keyboard on a focused chart: arrows move the brush (Shift: resize its upper
 * edge), Escape clears it, Enter/Space create one when there is none.
 */
export function keyBrush(brush: Brush | null, axes: BrushAxes, key: string, shift: boolean): KeyResult {
  if (key === 'Escape') return { handled: brush !== null, brush: null };
  if (!brush) {
    if (key === 'Enter' || key === ' ') return { handled: true, brush: defaultBrush(axes) };
    return { handled: false, brush };
  }
  const xd = xDomain(axes);
  const yd = yDomain(axes);
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const vertical = key === 'ArrowUp' || key === 'ArrowDown';
  if (!horizontal && !(vertical && axes.dims === 'xy')) return { handled: false, brush };
  if (horizontal) {
    // Right moves towards larger values on a left-to-right axis.
    const forward = axes.x.toPx(xd[1]) >= axes.x.toPx(xd[0]);
    const dir: 1 | -1 = (key === 'ArrowRight') === forward ? 1 : -1;
    if (shift) {
      const [x0, x1] = resizeEdge(brush.x0, brush.x1 + keyStep(brush.x1, brush.x1, dir, xd, axes.snapX), axes.snapX);
      return { handled: true, brush: { ...brush, x0, x1: Math.min(x1, xd[1]) } };
    }
    const delta = keyStep(brush.x0, brush.x1, dir, xd, axes.snapX);
    const [x0, x1] = moveInterval(brush.x0, brush.x1, delta, xd, axes.snapX);
    return { handled: true, brush: { ...brush, x0, x1 } };
  }
  if (brush.y0 === undefined || brush.y1 === undefined) return { handled: false, brush };
  const up = axes.y.toPx(yd[1]) <= axes.y.toPx(yd[0]);
  const dir: 1 | -1 = (key === 'ArrowUp') === up ? 1 : -1;
  if (shift) {
    const [y0, y1] = resizeEdge(brush.y0, brush.y1 + keyStep(brush.y1, brush.y1, dir, yd, axes.snapY), axes.snapY);
    return { handled: true, brush: { ...brush, y0, y1: Math.min(y1, yd[1]) } };
  }
  const delta = keyStep(brush.y0, brush.y1, dir, yd, axes.snapY);
  const [y0, y1] = moveInterval(brush.y0, brush.y1, delta, yd, axes.snapY);
  return { handled: true, brush: { ...brush, y0, y1 } };
}

/** Public selection (ISO strings on time axes) from a data-space brush. */
export function brushToSelection(brush: Brush, xKind: AxisKind, yKind: AxisKind): IntervalSelection {
  const x = [numberToBound(brush.x0, xKind), numberToBound(brush.x1, xKind)] as const;
  if (brush.y0 === undefined || brush.y1 === undefined) return { x };
  return { x, y: [numberToBound(brush.y0, yKind), numberToBound(brush.y1, yKind)] as const };
}

/** Data-space brush from a public selection, or null if it does not parse. */
export function selectionToBrush(selection: IntervalSelection | null | undefined, xKind: AxisKind, yKind: AxisKind, dims: BrushDims): Brush | null {
  if (!selection) return null;
  const a = boundToNumber(selection.x[0], xKind);
  const b = boundToNumber(selection.x[1], xKind);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const x0 = Math.min(a, b);
  const x1 = Math.max(a, b);
  if (dims === 'x' || !selection.y) return { x0, x1 };
  const c = boundToNumber(selection.y[0], yKind);
  const d = boundToNumber(selection.y[1], yKind);
  if (!Number.isFinite(c) || !Number.isFinite(d)) return { x0, x1 };
  return { x0, x1, y0: Math.min(c, d), y1: Math.max(c, d) };
}

export function sameBrush(a: Brush | null | undefined, b: Brush | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1;
}

/**
 * A snapper over sorted, unique bin edges. Evenly spaced edges extend past
 * the observed ones (empty bins are not in the result); uneven ones (months)
 * snap only to the edges seen.
 */
export function edgeSnapper(edges: Float64Array): Snapper | null {
  const n = edges.length;
  if (n === 0) return null;
  const first = edges[0] ?? 0;
  const last = edges[n - 1] ?? first;
  let step = Number.NaN;
  if (n >= 2) {
    step = Infinity;
    for (let i = 1; i < n; i += 1) step = Math.min(step, (edges[i] ?? 0) - (edges[i - 1] ?? 0));
    for (let i = 1; i < n; i += 1) {
      const k = ((edges[i] ?? 0) - first) / step;
      if (Math.abs(k - Math.round(k)) > 1e-6) {
        step = Number.NaN;
        break;
      }
    }
  }
  const regular = Number.isFinite(step) && step > 0;
  /** An observed edge equal (to rounding) to `v`, so snapped bounds equal the result's own values. */
  const observed = (v: number) => {
    const k = lowerBound(n, v, (i) => edges[i] ?? 0);
    for (const i of [k - 1, k]) {
      const e = edges[i];
      if (e !== undefined && Math.abs(e - v) <= Math.abs(regular ? step : 1) * 1e-9) return e;
    }
    return v;
  };
  if (regular) {
    const at = (k: number) => observed(first + k * step);
    const index = (v: number) => (v - first) / step;
    return {
      floor: (v) => at(Math.floor(index(v) + 1e-9)),
      ceil: (v) => at(Math.ceil(index(v) - 1e-9)),
      nearest: (v) => at(Math.round(index(v))),
      step: (v, dir) => at(Math.round(index(v)) + dir),
    };
  }
  const near = (v: number) => {
    const k = lowerBound(n, v, (i) => edges[i] ?? 0);
    if (k <= 0) return 0;
    if (k >= n) return n - 1;
    return v - (edges[k - 1] ?? 0) <= (edges[k] ?? 0) - v ? k - 1 : k;
  };
  return {
    floor: (v) => {
      const k = lowerBound(n, v + 1e-9, (i) => edges[i] ?? 0);
      return edges[Math.max(0, k - 1)] ?? first;
    },
    ceil: (v) => edges[Math.min(n - 1, lowerBound(n, v - 1e-9, (i) => edges[i] ?? 0))] ?? last,
    nearest: (v) => edges[near(v)] ?? first,
    step: (v, dir) => edges[clamp(near(v) + dir, 0, n - 1)] ?? first,
  };
}
