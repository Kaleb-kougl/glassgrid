import type { TooltipRow } from '../../components/Tooltip.js';
import { drawAxes, layoutAxes } from '../axes.js';
import type { ChartFonts } from '../canvas.js';
import { formatAxisValue, timeResolution } from '../format.js';
import { buildPointGrid, nearestPoint, type PointGrid } from '../hit.js';
import type { ChartModel, DrawContext, HoverInfo } from '../model.js';
import { extent, niceDomain } from '../scales.js';
import type { AxisKind, ChartColumns } from '../types.js';

export interface ScatterModelOptions {
  readonly xLabel: string;
  readonly yLabel: string;
  readonly colors: readonly string[];
  /** Point radius in CSS px (default 2.5). */
  readonly radius?: number;
  /** Point opacity (default 0.8): overlapping points read as denser. */
  readonly opacity?: number;
  readonly formatX?: (value: number) => string;
  readonly formatY?: (value: number) => string;
}

/** Above this many points Canvas 2D draws squares instead of circles (fallback when WebGL is unavailable). */
export const CANVAS_CIRCLE_LIMIT = 10_000;

function paddedDomain(values: Float64Array, kind: Exclude<AxisKind, 'category'>): [number, number] {
  const e = extent(values) ?? [0, 1];
  const span = e[1] - e[0] || Math.abs(e[0]) || 1;
  const padded: [number, number] = [e[0] - span * 0.03, e[1] + span * 0.03];
  return kind === 'time' ? padded : niceDomain('number', padded, 5);
}

/** Scatter: one point per row; colour by series. */
export function buildScatterModel(data: ChartColumns, width: number, height: number, fonts: ChartFonts, options: ScatterModelOptions): ChartModel & { readonly pointRadius: number } {
  const xKind = data.xKind === 'time' ? 'time' : 'number';
  const yKind = data.yKind === 'time' ? 'time' : 'number';
  const axes = layoutAxes(width, height, { kind: xKind, domain: paddedDomain(data.x, xKind) }, { kind: yKind, domain: paddedDomain(data.y, yKind) }, fonts);
  const { x: xs, y: ys } = axes;
  const { plot } = axes.layout;
  const radius = options.radius ?? 2.5;
  const opacity = options.opacity ?? 0.8;
  const groups = Math.max(1, data.seriesList.length);
  const colorOf = (s: number) => options.colors[s] ?? options.colors[0] ?? '#000';
  const xResolution = xKind === 'time' ? timeResolution(data.x) : 'millisecond';
  const yResolution = yKind === 'time' ? timeResolution(data.y) : 'millisecond';
  const fx = options.formatX ?? ((v: number) => formatAxisValue(v, xKind, xResolution));
  const fy = options.formatY ?? ((v: number) => formatAxisValue(v, yKind, yResolution));

  let grid: PointGrid | null = null;
  const pointGrid = () => {
    grid ??= buildPointGrid(data.length, (i) => xs.toPx(data.x[i] ?? Number.NaN), (i) => ys.toPx(data.y[i] ?? Number.NaN), plot);
    return grid;
  };

  const drawMarks = (ctx: CanvasRenderingContext2D) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.left, plot.top, plot.width, plot.height);
    ctx.clip();
    ctx.globalAlpha = opacity;
    const circles = data.length <= CANVAS_CIRCLE_LIMIT;
    for (let s = 0; s < groups; s += 1) {
      const rows = data.order.subarray(data.seriesStart[s] ?? 0, data.seriesStart[s + 1] ?? 0);
      ctx.fillStyle = colorOf(s);
      if (circles) {
        ctx.beginPath();
        for (let k = 0; k < rows.length; k += 1) {
          const i = rows[k] ?? 0;
          const x = xs.toPx(data.x[i] ?? Number.NaN);
          const y = ys.toPx(data.y[i] ?? Number.NaN);
          if (Number.isNaN(x) || Number.isNaN(y)) continue;
          ctx.moveTo(x + radius, y);
          ctx.arc(x, y, radius, 0, Math.PI * 2);
        }
        ctx.fill();
      } else {
        const size = radius * 1.6;
        for (let k = 0; k < rows.length; k += 1) {
          const i = rows[k] ?? 0;
          const x = xs.toPx(data.x[i] ?? Number.NaN);
          const y = ys.toPx(data.y[i] ?? Number.NaN);
          if (!Number.isNaN(x) && !Number.isNaN(y)) ctx.fillRect(x - size / 2, y - size / 2, size, size);
        }
      }
    }
    ctx.restore();
  };

  const hitTest = (px: number, py: number): HoverInfo | null => {
    if (px < plot.left - radius || px > plot.left + plot.width + radius || py < plot.top - radius || py > plot.top + plot.height + radius) return null;
    const i = nearestPoint(pointGrid(), px, py, Math.max(6, radius + 3));
    if (i < 0) return null;
    const cx = xs.toPx(data.x[i] ?? 0);
    const cy = ys.toPx(data.y[i] ?? 0);
    const series = data.series ? data.seriesList[data.series[i] ?? 0] : undefined;
    const color = colorOf(data.series ? (data.series[i] ?? 0) : 0);
    const rows: TooltipRow[] = [
      { label: options.xLabel, value: fx(data.x[i] ?? Number.NaN) },
      { label: options.yLabel, value: fy(data.y[i] ?? Number.NaN) },
    ];
    return {
      anchor: { x: cx, y: cy },
      title: series ? series.label : `${options.yLabel} by ${options.xLabel}`,
      rows,
      highlight: (ctx: CanvasRenderingContext2D, dc: DrawContext) => {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radius + 2.5, 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = dc.tokens.chart.selectionStroke;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
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
    snapX: null,
    snapY: null,
    pointRadius: radius,
    drawBackground: (ctx, dc) => drawAxes(ctx, axes, dc.tokens, dc.fonts, { dpr: dc.dpr, xGrid: true }),
    drawMarks,
    hitTest,
  };
}
