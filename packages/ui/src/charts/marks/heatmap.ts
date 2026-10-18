import { drawAxes, layoutAxes } from '../axes.js';
import { edgeSnapper } from '../brush.js';
import type { ChartFonts } from '../canvas.js';
import { parseColor, rampLut, rampPosition, type RampTransform } from '../colors.js';
import { formatAggregate, formatRange, timeResolution } from '../format.js';
import { buildGridIndex, gridCellAt, uniqueSorted } from '../hit.js';
import type { ChartModel, DrawContext, HoverInfo } from '../model.js';
import { prepared } from '../prep.js';
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
  /**
   * Draw a regular bin grid as one nearest-neighbour-scaled bitmap (one
   * pixel per cell) instead of one rectangle per cell. Default: when the
   * grid is regular and `ImageData` exists.
   */
  readonly bitmap?: boolean;
}

/** Bins of a regular grid: origin, step and count, or null when the edges are uneven (months) or too many. */
export function regularGrid(edges: Float64Array, maxBins = 4096): { origin: number; step: number; count: number } | null {
  const n = edges.length;
  if (n < 2) return null;
  const origin = edges[0] ?? 0;
  let step = Infinity;
  for (let i = 1; i < n; i += 1) step = Math.min(step, (edges[i] ?? 0) - (edges[i - 1] ?? 0));
  if (!(step > 0)) return null;
  for (let i = 1; i < n; i += 1) {
    const k = ((edges[i] ?? 0) - origin) / step;
    if (Math.abs(k - Math.round(k)) > 1e-6) return null;
  }
  const count = Math.round(((edges[n - 1] ?? 0) - origin) / step);
  return count > 0 && count <= maxBins ? { origin, step, count } : null;
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
  const transform = options.transform ?? 'sqrt';
  const prep = prepared(data, 'heatmap', () => {
    const xEdges = uniqueSorted(data.x, xEnd);
    const yEdges = uniqueSorted(data.y, yEnd);
    return {
      xExtent: extent(data.x, xEnd) ?? ([0, 1] as [number, number]),
      yExtent: extent(data.y, yEnd) ?? ([0, 1] as [number, number]),
      grid: buildGridIndex(data.x, xEnd, data.y, yEnd),
      max: maxCount(counts),
      xEdges,
      yEdges,
      gx: regularGrid(xEdges),
      gy: regularGrid(yEdges),
      xResolution: xKind === 'time' ? timeResolution(xEdges) : 'millisecond',
      yResolution: yKind === 'time' ? timeResolution(yEdges) : 'millisecond',
    };
  });
  const { grid, max, xEdges, yEdges, gx, gy, xResolution, yResolution } = prep;
  const axes = layoutAxes(width, height, { kind: xKind, domain: prep.xExtent }, { kind: yKind, domain: prep.yExtent }, fonts);
  const { x: xs, y: ys } = axes;
  const { plot } = axes.layout;
  const lut = rampLut(options.ramp, HEATMAP_STEPS);
  const format = options.formatValue ?? formatAggregate;

  // Rows bucketed by ramp step (counting sort), once per result and transform.
  const { bucketOf, bucketStart, byBucket } = prepared(data, `heatmap-buckets:${transform}`, () => {
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
    return { bucketOf, bucketStart, byBucket };
  });

  const cellRect = (i: number) => {
    const a = xs.toPx(data.x[i] ?? 0);
    const b = xs.toPx(xEnd[i] ?? 0);
    const c = ys.toPx(data.y[i] ?? 0);
    const d = ys.toPx(yEnd[i] ?? 0);
    return { left: Math.min(a, b), top: Math.min(c, d), width: Math.abs(b - a), height: Math.abs(d - c) };
  };

  const useBitmap = (options.bitmap ?? typeof ImageData !== 'undefined') && gx !== null && gy !== null;

  /** One pixel per cell, scaled up without smoothing: a single drawImage for the whole grid. */
  const drawBitmap = (ctx: CanvasRenderingContext2D, grid: { x: NonNullable<typeof gx>; y: NonNullable<typeof gy> }) => {
    const { x: bx, y: by } = grid;
    // The cell bitmap depends on the result, transform and ramp only: built once, reused across resizes.
    const cells = prepared(data, `heatmap-bitmap:${transform}:${lut.join(',')}`, () => {
      const pixels = new Uint8ClampedArray(bx.count * by.count * 4);
      const rgb = lut.map(parseColor);
      for (let i = 0; i < data.length; i += 1) {
        const cx = Math.round(((data.x[i] ?? 0) - bx.origin) / bx.step);
        const cy = Math.round(((data.y[i] ?? 0) - by.origin) / by.step);
        if (cx < 0 || cx >= bx.count || cy < 0 || cy >= by.count) continue;
        const o = ((by.count - 1 - cy) * bx.count + cx) * 4;
        const [r, g, b] = rgb[bucketOf[i] ?? 0] ?? [0, 0, 0];
        pixels[o] = r;
        pixels[o + 1] = g;
        pixels[o + 2] = b;
        pixels[o + 3] = 255;
      }
      const canvas = document.createElement('canvas');
      canvas.width = bx.count;
      canvas.height = by.count;
      canvas.getContext('2d')?.putImageData(new ImageData(pixels, bx.count, by.count), 0, 0);
      return canvas;
    });
    const x0 = xs.toPx(bx.origin);
    const x1 = xs.toPx(bx.origin + bx.count * bx.step);
    const y0 = ys.toPx(by.origin + by.count * by.step);
    const y1 = ys.toPx(by.origin);
    const smoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cells, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.imageSmoothingEnabled = smoothing;
  };

  const drawMarks = (ctx: CanvasRenderingContext2D) => {
    if (useBitmap) {
      drawBitmap(ctx, { x: gx, y: gy });
      return;
    }
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
