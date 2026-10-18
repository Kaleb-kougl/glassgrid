import type { TooltipRow } from '../../components/Tooltip.js';
import { drawAxes, layoutAxes } from '../axes.js';
import { edgeSnapper } from '../brush.js';
import type { ChartFonts } from '../canvas.js';
import { formatAggregate, formatRange, timeResolution } from '../format.js';
import { binAt, buildBinIndex, uniqueSorted, type BinIndex } from '../hit.js';
import type { ChartModel, DrawContext, HoverInfo } from '../model.js';
import { prepared } from '../prep.js';
import { measureDomain } from '../scales.js';
import type { ChartColumns } from '../types.js';

export interface HistogramModelOptions {
  readonly yLabel: string;
  readonly colors: readonly string[];
  readonly formatValue?: (value: number) => string;
  /** Snap brushes to bin edges (default true). */
  readonly snap?: boolean;
}

/** Gap between adjacent bins, CSS px (dropped when bins get narrower than 3 px). */
const BIN_GAP = 1;

/** Per-row stack extents: each bin stacks its series in series order. */
export function stackBins(data: ChartColumns, bins: BinIndex): { lo: Float64Array; hi: Float64Array; totals: Float64Array } {
  const lo = new Float64Array(data.length);
  const hi = new Float64Array(data.length);
  const totals = new Float64Array(bins.starts.length);
  for (let b = 0; b < bins.starts.length; b += 1) {
    let acc = 0;
    let neg = 0;
    for (let k = bins.rowStart[b] ?? 0; k < (bins.rowStart[b + 1] ?? 0); k += 1) {
      const row = bins.rows[k] ?? 0;
      const v = data.y[row] ?? Number.NaN;
      if (!Number.isFinite(v)) {
        lo[row] = Number.NaN;
        hi[row] = Number.NaN;
        continue;
      }
      if (v >= 0) {
        lo[row] = acc;
        acc += v;
        hi[row] = acc;
      } else {
        hi[row] = neg;
        neg += v;
        lo[row] = neg;
      }
    }
    totals[b] = acc + neg;
  }
  return { lo, hi, totals };
}

/**
 * Histogram: one bar per returned bin from `x` to `x_end` (empty bins are
 * not returned and leave a gap), series stacked within a bin.
 */
export function buildHistogramModel(data: ChartColumns, width: number, height: number, fonts: ChartFonts, options: HistogramModelOptions): ChartModel {
  const xKind = data.xKind === 'time' ? 'time' : 'number';
  const xEnd = data.xEnd ?? data.x;
  const { bins, lo, hi, edges, resolution } = prepared(data, 'histogram', () => {
    const index = buildBinIndex(data.x, xEnd, data.order);
    const sortedEdges = uniqueSorted(data.x, xEnd);
    return {
      bins: index,
      ...stackBins(data, index),
      edges: sortedEdges,
      resolution: xKind === 'time' ? timeResolution(sortedEdges) : ('millisecond' as const),
    };
  });
  const n = bins.starts.length;
  const xDomain: [number, number] = n > 0 ? [bins.starts[0] ?? 0, bins.ends[n - 1] ?? 1] : [0, 1];
  const axes = layoutAxes(width, height, { kind: xKind, domain: xDomain }, { kind: 'number', domain: measureDomain(hi, 5, lo) }, fonts);
  const { x: xs, y: ys } = axes;
  const { plot } = axes.layout;
  const format = options.formatValue ?? formatAggregate;
  const groups = Math.max(1, data.seriesList.length);
  const colorOf = (s: number) => options.colors[s] ?? options.colors[0] ?? '#000';

  const binRect = (b: number) => {
    const a = xs.toPx(bins.starts[b] ?? 0);
    const e = xs.toPx(bins.ends[b] ?? 0);
    const left = Math.min(a, e);
    const w = Math.abs(e - a);
    const gap = w > 3 ? BIN_GAP : 0;
    return { left, width: Math.max(0.5, w - gap) };
  };

  const drawMarks = (ctx: CanvasRenderingContext2D) => {
    // One path per series: every segment of that colour, filled once.
    for (let s = 0; s < groups; s += 1) {
      ctx.fillStyle = colorOf(s);
      ctx.beginPath();
      let any = false;
      for (let b = 0; b < n; b += 1) {
        const { left, width: w } = binRect(b);
        for (let k = bins.rowStart[b] ?? 0; k < (bins.rowStart[b + 1] ?? 0); k += 1) {
          const row = bins.rows[k] ?? 0;
          if ((data.series ? (data.series[row] ?? 0) : 0) !== s) continue;
          const l = lo[row] ?? Number.NaN;
          const h = hi[row] ?? Number.NaN;
          if (!Number.isFinite(l) || !Number.isFinite(h) || h === l) continue;
          const top = ys.toPx(h);
          const bottom = ys.toPx(l);
          ctx.rect(left, Math.min(top, bottom), w, Math.abs(bottom - top));
          any = true;
        }
      }
      if (any) ctx.fill();
    }
  };

  const hitTest = (px: number, py: number): HoverInfo | null => {
    if (px < plot.left || px > plot.left + plot.width || py < plot.top - 4 || py > plot.top + plot.height + 4) return null;
    const b = binAt(bins, xs.fromPx(px));
    if (b < 0) return null;
    const rows: TooltipRow[] = [];
    let total = 0;
    let top = Infinity;
    for (let k = bins.rowStart[b] ?? 0; k < (bins.rowStart[b + 1] ?? 0); k += 1) {
      const row = bins.rows[k] ?? 0;
      const v = data.y[row] ?? Number.NaN;
      if (Number.isFinite(v)) total += v;
      const h = hi[row] ?? Number.NaN;
      if (Number.isFinite(h)) top = Math.min(top, ys.toPx(h));
      const series = data.series ? data.seriesList[data.series[row] ?? 0] : undefined;
      rows.push({ label: series ? series.label : options.yLabel, value: Number.isNaN(v) ? '–' : format(v) });
    }
    if (data.seriesList.length > 1) rows.push({ label: `total ${options.yLabel}`, value: format(total) });
    const rect = binRect(b);
    return {
      anchor: { x: rect.left + rect.width / 2, y: Number.isFinite(top) ? top : plot.top + plot.height / 2 },
      title: formatRange(bins.starts[b] ?? 0, bins.ends[b] ?? 0, xKind, resolution),
      rows,
      highlight: (ctx: CanvasRenderingContext2D, dc: DrawContext) => {
        const t = Number.isFinite(top) ? top : plot.top + plot.height;
        ctx.save();
        ctx.strokeStyle = dc.tokens.color.textSecondary;
        ctx.lineWidth = 1;
        ctx.strokeRect(rect.left - 0.5, t - 0.5, rect.width + 1, plot.top + plot.height - t + 0.5);
        ctx.restore();
      },
    };
  };

  return {
    axes,
    xKind,
    yKind: 'number',
    xResolution: resolution,
    yResolution: 'millisecond',
    brushDims: 'x',
    snapX: options.snap === false ? null : edgeSnapper(edges),
    snapY: null,
    drawBackground: (ctx, dc) => drawAxes(ctx, axes, dc.tokens, dc.fonts, { dpr: dc.dpr }),
    drawMarks,
    hitTest,
  };
}
