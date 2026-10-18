import { drawAxes, layoutAxes } from '../axes.js';
import { edgeSnapper } from '../brush.js';
import type { ChartFonts } from '../canvas.js';
import { rampLut, rampPosition, type RampTransform } from '../colors.js';
import { formatAggregate, formatRange, timeResolution } from '../format.js';
import { buildGridIndex, gridCellAt, uniqueSorted } from '../hit.js';
import type { ChartModel, DrawContext, HoverInfo } from '../model.js';
import { extent } from '../scales.js';
import type { ChartColumns } from '../types.js';

export interface HeatmapModelOptions {
  readonly xLabel: string;
  readonly yLabel: string;
  /** Name of the cell measure (default `count(*)`). */
  readonly countLabel?: string;
  /** Sequential ramp stops (tokens.chart.sequential). */
  readonly ramp: readonly string[];
  readonly transform?: RampTransform;
  readonly formatValue?: (value: number) => string;
  /** Snap brushes to bin edges (default true). */
  readonly snap?: boolean;
}

/** Ramp lookup-table size: cells are filled in at most this many batches. */
export const HEATMAP_STEPS = 48;

/** Largest finite count (0 when none). */
export function maxCount(counts: ArrayLike<number> | null): number {
  let max = 0;
  if (!counts) return max;
  for (let i = 0; i < counts.length; i += 1) {
    const v = counts[i] ?? 0;
    if (v > max) max = v;
  }
  return max;
}

/**
 * Heatmap: one cell per returned (x bin, y bin) from `x`…`x_end` and
 * `y`…`y_end`, coloured by `count` on the sequential ramp. Cells are drawn
 * in colour batches (one fill per ramp step), not one fill per cell.
 */
export function buildHeatmapModel(data: ChartColumns, width: number, height: number, fonts: ChartFonts, options: HeatmapModelOptions): ChartModel {
  const xKind = data.xKind === 'time' ? 'time' : 'number';
  const yKind = data.yKind === 'time' ? 'time' : 'number';
  const xEnd = data.xEnd ?? data.x;
  const yEnd = data.yEnd ?? data.y;
  const counts = data.count ?? new Float64Array(data.length);
  const axes = layoutAxes(width, height, { kind: xKind, domain: extent(data.x, xEnd) ?? [0, 1] }, { kind: yKind, domain: extent(data.y, yEnd) ?? [0, 1] }, fonts);
  const { x: xs, y: ys } = axes;
  const { plot } = axes.layout;
  const grid = buildGridIndex(data.x, xEnd, data.y, yEnd);
  const max = maxCount(counts);
  const transform = options.transform ?? 'sqrt';
  const lut = rampLut(options.ramp, HEATMAP_STEPS);
  const format = options.formatValue ?? formatAggregate;
  const xEdges = uniqueSorted(data.x, xEnd);
  const yEdges = uniqueSorted(data.y, yEnd);
  const xResolution = xKind === 'time' ? timeResolution(xEdges) : 'millisecond';
  const yResolution = yKind === 'time' ? timeResolution(yEdges) : 'millisecond';

  // Rows bucketed by ramp step (counting sort), computed once.
  const bucketOf = new Uint8Array(data.length);
  const bucketStart = new Uint32Array(HEATMAP_STEPS + 1);
  for (let i = 0; i < data.length; i += 1) {
    const b = Math.min(HEATMAP_STEPS - 1, Math.round(rampPosition(counts[i] ?? 0, max, transform) * (HEATMAP_STEPS - 1)));
    bucketOf[i] = b;
    bucketStart[b + 1] = (bucketStart[b + 1] ?? 0) + 1;
  }
  for (let b = 1; b <= HEATMAP_STEPS; b += 1) bucketStart[b] = (bucketStart[b] ?? 0) + (bucketStart[b - 1] ?? 0);
  const byBucket = new Uint32Array(data.length);
  const cursor = bucketStart.slice(0, HEATMAP_STEPS);
  for (let i = 0; i < data.length; i += 1) {
    const b = bucketOf[i] ?? 0;
    byBucket[cursor[b] ?? 0] = i;
    cursor[b] = (cursor[b] ?? 0) + 1;
  }

  const cellRect = (i: number) => {
    const a = xs.toPx(data.x[i] ?? 0);
    const b = xs.toPx(xEnd[i] ?? 0);
    const c = ys.toPx(data.y[i] ?? 0);
    const d = ys.toPx(yEnd[i] ?? 0);
    return { left: Math.min(a, b), top: Math.min(c, d), width: Math.abs(b - a), height: Math.abs(d - c) };
  };

  const drawMarks = (ctx: CanvasRenderingContext2D) => {
    for (let b = 0; b < HEATMAP_STEPS; b += 1) {
      const start = bucketStart[b] ?? 0;
      const end = bucketStart[b + 1] ?? 0;
      if (end <= start) continue;
      ctx.fillStyle = lut[b] ?? '#000';
      ctx.beginPath();
      for (let k = start; k < end; k += 1) {
        const r = cellRect(byBucket[k] ?? 0);
        // Overlap by a hair so anti-aliased edges do not show seams between cells.
        ctx.rect(r.left, r.top, r.width + 0.25, r.height + 0.25);
      }
      ctx.fill();
    }
  };

  const hitTest = (px: number, py: number): HoverInfo | null => {
    if (px < plot.left || px > plot.left + plot.width || py < plot.top || py > plot.top + plot.height) return null;
    const row = gridCellAt(grid, xs.fromPx(px), ys.fromPx(py));
    if (row < 0) return null;
    const r = cellRect(row);
    return {
      anchor: { x: r.left + r.width / 2, y: r.top },
      title: `${options.xLabel} ${formatRange(data.x[row] ?? 0, xEnd[row] ?? 0, xKind, xResolution)}`,
      rows: [
        { label: options.yLabel, value: formatRange(data.y[row] ?? 0, yEnd[row] ?? 0, yKind, yResolution) },
        { label: options.countLabel ?? 'count(*)', value: format(counts[row] ?? 0) },
      ],
      highlight: (ctx: CanvasRenderingContext2D, dc: DrawContext) => {
        ctx.save();
        ctx.strokeStyle = dc.tokens.chart.selectionStroke;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(r.left - 0.75, r.top - 0.75, r.width + 1.5, r.height + 1.5);
        ctx.restore();
      },
    };
  };

  return {
    axes,
    xKind,
    yKind,
    xResolution,
    yResolution,
    brushDims: 'xy',
    snapX: options.snap === false ? null : edgeSnapper(xEdges),
    snapY: options.snap === false ? null : edgeSnapper(yEdges),
    drawBackground: (ctx, dc) => drawAxes(ctx, axes, dc.tokens, dc.fonts, { dpr: dc.dpr }),
    drawMarks,
    hitTest,
  };
}
