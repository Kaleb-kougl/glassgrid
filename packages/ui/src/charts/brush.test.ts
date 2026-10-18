import { describe, expect, it } from 'vitest';
import {
  beginDrag,
  brushToSelection,
  defaultBrush,
  dragBrush,
  edgeSnapper,
  endDrag,
  hitBrushTarget,
  keyBrush,
  selectionToBrush,
  type BrushAxes,
} from './brush.js';
import { makeScale } from './scales.js';

// Plot: x 0–100 over px 0–200, y 0–10 over px 100 (bottom) – 0 (top).
const plot = { left: 0, top: 0, width: 200, height: 100 };
const x = makeScale('number', [0, 100], [0, 200]);
const y = makeScale('number', [0, 10], [100, 0]);
const axes1: BrushAxes = { x, y, plot, dims: 'x' };
const axes2: BrushAxes = { x, y, plot, dims: 'xy' };

describe('1-D brush', () => {
  it('creates by dragging, in either direction', () => {
    const drag = beginDrag(null, axes1, 40, 50);
    expect(drag.kind).toBe('create');
    expect(dragBrush(drag, axes1, 41, 50)).toBeNull(); // under the 3 px threshold
    expect(dragBrush(drag, axes1, 100, 70)).toEqual({ x0: 20, x1: 50 });
    expect(dragBrush(drag, axes1, 10, 70)).toEqual({ x0: 5, x1: 20 });
    expect(endDrag(drag, axes1, 100, 70)).toEqual({ x0: 20, x1: 50 });
  });

  it('clamps to the axis domain', () => {
    const drag = beginDrag(null, axes1, 150, 50);
    expect(dragBrush(drag, axes1, 400, 50)).toEqual({ x0: 75, x1: 100 });
  });

  it('moves from inside, keeping the width and staying in the domain', () => {
    const brush = { x0: 20, x1: 50 };
    expect(hitBrushTarget(brush, axes1, 70, 50)).toEqual({ kind: 'inside' });
    const drag = beginDrag(brush, axes1, 70, 50);
    expect(drag.kind).toBe('move');
    expect(dragBrush(drag, axes1, 90, 50)).toEqual({ x0: 30, x1: 60 });
    expect(dragBrush(drag, axes1, 500, 50)).toEqual({ x0: 70, x1: 100 });
    expect(dragBrush(drag, axes1, -500, 50)).toEqual({ x0: 0, x1: 30 });
  });

  it('resizes from a handle and swaps edges when crossing', () => {
    const brush = { x0: 20, x1: 50 };
    expect(hitBrushTarget(brush, axes1, 101, 50)).toEqual({ kind: 'edges', edges: ['x1'] });
    expect(hitBrushTarget(brush, axes1, 38, 10)).toEqual({ kind: 'edges', edges: ['x0'] });
    const drag = beginDrag(brush, axes1, 100, 50);
    expect(drag.kind).toBe('resize');
    expect(dragBrush(drag, axes1, 160, 50)).toEqual({ x0: 20, x1: 80 });
    expect(dragBrush(drag, axes1, 20, 50)).toEqual({ x0: 10, x1: 20 });
  });

  it('clears on a click outside the brush, keeps it on a click inside', () => {
    const brush = { x0: 20, x1: 50 };
    const outside = beginDrag(brush, axes1, 180, 50);
    expect(dragBrush(outside, axes1, 181, 50)).toEqual(brush); // still showing the old one
    expect(endDrag(outside, axes1, 181, 50)).toBeNull();
    const inside = beginDrag(brush, axes1, 70, 50);
    expect(endDrag(inside, axes1, 70, 50)).toEqual(brush);
  });

  it('moves with arrows, resizes with Shift, clears with Escape, creates with Enter', () => {
    const brush = { x0: 20, x1: 50 };
    expect(keyBrush(brush, axes1, 'ArrowRight', false)).toEqual({ handled: true, brush: { x0: 22, x1: 52 } });
    expect(keyBrush(brush, axes1, 'ArrowLeft', false)).toEqual({ handled: true, brush: { x0: 18, x1: 48 } });
    expect(keyBrush(brush, axes1, 'ArrowRight', true)).toEqual({ handled: true, brush: { x0: 20, x1: 52 } });
    expect(keyBrush(brush, axes1, 'Escape', false)).toEqual({ handled: true, brush: null });
    expect(keyBrush(null, axes1, 'Escape', false).handled).toBe(false);
    expect(keyBrush(brush, axes1, 'ArrowUp', false).handled).toBe(false); // 1-D: up/down free for the page
    expect(keyBrush(null, axes1, 'Enter', false)).toEqual({ handled: true, brush: { x0: 40, x1: 60 } });
  });
});

describe('2-D brush', () => {
  it('creates, moves and resizes corners in data space', () => {
    const drag = beginDrag(null, axes2, 20, 80);
    expect(dragBrush(drag, axes2, 60, 40)).toEqual({ x0: 10, x1: 30, y0: 2, y1: 6 });
    const brush = { x0: 10, x1: 30, y0: 2, y1: 6 };
    // Top-right corner: x1 and y1 (y grows upwards).
    expect(hitBrushTarget(brush, axes2, 60, 40)).toEqual({ kind: 'edges', edges: ['x1', 'y1'] });
    const resize = beginDrag(brush, axes2, 60, 40);
    expect(dragBrush(resize, axes2, 80, 20)).toEqual({ x0: 10, x1: 40, y0: 2, y1: 8 });
    const move = beginDrag(brush, axes2, 40, 60);
    expect(dragBrush(move, axes2, 50, 50)).toEqual({ x0: 15, x1: 35, y0: 3, y1: 7 });
    expect(keyBrush(brush, axes2, 'ArrowUp', false)).toEqual({ handled: true, brush: { x0: 10, x1: 30, y0: 2.2, y1: 6.2 } });
    expect(defaultBrush(axes2)).toEqual({ x0: 40, x1: 60, y0: 4, y1: 6 });
  });
});

describe('snapping to bins', () => {
  // Histogram bins of width 0.5 from 0 (empty bins between 2 and 3 not returned).
  const edges = Float64Array.from([0, 0.5, 1, 1.5, 2, 3, 3.5]);
  const snap = edgeSnapper(edges);
  const hx = makeScale('number', [0, 3.5], [0, 350]);
  const axes: BrushAxes = { x: hx, y, plot: { left: 0, top: 0, width: 350, height: 100 }, dims: 'x', snapX: snap };

  it('extends a regular grid past the observed edges', () => {
    expect(snap?.floor(2.7)).toBe(2.5);
    expect(snap?.ceil(2.7)).toBe(3);
    expect(snap?.nearest(1.3)).toBe(1.5);
    expect(snap?.step(1, 1)).toBe(1.5);
    expect(snap?.step(1, -1)).toBe(0.5);
  });

  it('returns the result’s own edge values (no float drift)', () => {
    const tenths = edgeSnapper(Float64Array.from([0, 0.1, 0.2, 0.30000000000000004, 0.4]));
    expect(tenths?.nearest(0.29)).toBe(0.30000000000000004);
    expect(tenths?.ceil(0.25)).toBe(0.30000000000000004);
  });

  it('snaps a created brush outwards to whole bins, never empty', () => {
    const drag = beginDrag(null, axes, 120, 50);
    expect(dragBrush(drag, axes, 180, 50)).toEqual({ x0: 1, x1: 2 });
    const tiny = beginDrag(null, axes, 121, 50);
    expect(dragBrush(tiny, axes, 125, 50)).toEqual({ x0: 1, x1: 1.5 });
  });

  it('moves and resizes by whole bins', () => {
    const brush = { x0: 1, x1: 2 };
    const move = beginDrag(brush, axes, 150, 50);
    expect(dragBrush(move, axes, 172, 50)).toEqual({ x0: 1, x1: 2 });
    expect(dragBrush(move, axes, 178, 50)).toEqual({ x0: 1.5, x1: 2.5 });
    const resize = beginDrag(brush, axes, 200, 50);
    expect(dragBrush(resize, axes, 262, 50)).toEqual({ x0: 1, x1: 2.5 });
    // Dragged onto the fixed edge: still one bin wide.
    expect(dragBrush(resize, axes, 101, 50)).toEqual({ x0: 1, x1: 1.5 });
    expect(keyBrush(brush, axes, 'ArrowRight', false).brush).toEqual({ x0: 1.5, x1: 2.5 });
    expect(keyBrush(brush, axes, 'ArrowLeft', true).brush).toEqual({ x0: 1, x1: 1.5 });
  });

  it('snaps uneven edges (months) to the edges seen', () => {
    const months = Float64Array.from([Date.UTC(2023, 0, 1), Date.UTC(2023, 1, 1), Date.UTC(2023, 2, 1), Date.UTC(2023, 3, 1)]);
    const m = edgeSnapper(months);
    expect(m?.floor(Date.UTC(2023, 1, 15))).toBe(Date.UTC(2023, 1, 1));
    expect(m?.ceil(Date.UTC(2023, 1, 15))).toBe(Date.UTC(2023, 2, 1));
    expect(m?.nearest(Date.UTC(2023, 1, 20))).toBe(Date.UTC(2023, 2, 1));
    expect(m?.step(Date.UTC(2023, 1, 1), 1)).toBe(Date.UTC(2023, 2, 1));
    expect(m?.ceil(Date.UTC(2024, 0, 1))).toBe(Date.UTC(2023, 3, 1));
    expect(edgeSnapper(new Float64Array(0))).toBeNull();
  });
});

describe('data-space selections', () => {
  it('emits numbers on numeric axes and ISO timestamps on time axes', () => {
    expect(brushToSelection({ x0: 2, x1: 6 }, 'number', 'number')).toEqual({ x: [2, 6] });
    expect(brushToSelection({ x0: Date.UTC(2023, 0, 9), x1: Date.UTC(2023, 0, 15, 12) }, 'time', 'number')).toEqual({
      x: ['2023-01-09', '2023-01-15 12:00:00'],
    });
    expect(brushToSelection({ x0: 0, x1: 1, y0: Date.UTC(2023, 0, 1), y1: Date.UTC(2023, 0, 2) }, 'number', 'time')).toEqual({
      x: [0, 1],
      y: ['2023-01-01', '2023-01-02'],
    });
  });

  it('reads selections back (ordered, ISO or epoch ms), ignoring y on 1-D charts', () => {
    expect(selectionToBrush({ x: ['2023-01-15 12:00:00', '2023-01-09'] }, 'time', 'number', 'x')).toEqual({
      x0: Date.UTC(2023, 0, 9),
      x1: Date.UTC(2023, 0, 15, 12),
    });
    expect(selectionToBrush({ x: [6, 2], y: [1, 0] }, 'number', 'number', 'x')).toEqual({ x0: 2, x1: 6 });
    expect(selectionToBrush({ x: [6, 2], y: [1, 0] }, 'number', 'number', 'xy')).toEqual({ x0: 2, x1: 6, y0: 0, y1: 1 });
    expect(selectionToBrush({ x: ['garbage', 1] }, 'time', 'number', 'x')).toBeNull();
    expect(selectionToBrush(null, 'number', 'number', 'x')).toBeNull();
  });
});
