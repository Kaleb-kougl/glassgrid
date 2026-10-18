import type { TooltipRow } from '../../components/Tooltip.js';
import { drawAxes, layoutAxes } from '../axes.js';
import type { ChartFonts } from '../canvas.js';
import { parseColor, type Rgb } from '../colors.js';
import { formatAxisValue, timeResolution } from '../format.js';
import { buildPointGrid, nearestPoint, type PointGrid } from '../hit.js';
import type { ChartModel, DrawContext, HoverInfo } from '../model.js';
import { prepared } from '../prep.js';
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
  /**
   * Rasterize points in JS into an ImageData (an anti-aliased disc mask
   * blended per point) instead of Canvas 2D paths. Default: when
   * `ImageData` exists. Fast and independent of the canvas backend.
   */
  readonly splat?: boolean;
}

/** Anti-aliased coverage of a disc of radius `r` (device px) on a (2·ceil(r)+3)² grid, centred. */
export function discMask(r: number): { size: number; coverage: Float32Array } {
  const half = Math.ceil(r) + 1;
  const size = half * 2 + 1;
  const coverage = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x - half, y - half);
      coverage[y * size + x] = Math.max(0, Math.min(1, r + 0.5 - d));
    }
  }
  return { size, coverage };
}

/**
 * Blends discs into an RGBA buffer (non-premultiplied, as ImageData wants)
 * with "source over": `points` are device-pixel centres, `colors` the
 * series colour per point. Returns the buffer.
 */
export function splatDiscs(
  width: number,
  height: number,
  count: number,
  xAt: (i: number) => number,
  yAt: (i: number) => number,
  colorAt: (i: number) => Rgb,
  radius: number,
  opacity: number,
  clip: { left: number; top: number; right: number; bottom: number },
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  const left = Math.max(0, clip.left);
  const top = Math.max(0, clip.top);
  const right = Math.min(width, clip.right);
  const bottom = Math.min(height, clip.bottom);
  const cw = right - left;
  const ch = bottom - top;
  if (cw <= 0 || ch <= 0) return out;
  // Premultiplied float accumulation over the clip only: "over" without divisions per covered cell.
  const acc = new Float32Array(cw * ch * 4);
  const { size, coverage } = discMask(radius);
  const half = (size - 1) / 2;
  const dxs: number[] = [];
  const dys: number[] = [];
  const alphas: number[] = [];
  for (let my = 0; my < size; my += 1) {
    for (let mx = 0; mx < size; mx += 1) {
      const a = (coverage[my * size + mx] ?? 0) * opacity;
      if (a <= 0) continue;
      dxs.push(mx - half);
      dys.push(my - half);
      alphas.push(a);
    }
  }
  const cells = alphas.length;
  const dx = Int32Array.from(dxs);
  const dy = Int32Array.from(dys);
  const al = Float32Array.from(alphas);
  const offsets = Int32Array.from(dxs, (x, k) => ((dys[k] ?? 0) * cw + x) * 4);
  for (let i = 0; i < count; i += 1) {
    const cx = Math.round(xAt(i)) - left;
    const cy = Math.round(yAt(i)) - top;
    if (!(cx >= -half && cx < cw + half && cy >= -half && cy < ch + half)) continue;
    const [r, g, b] = colorAt(i);
    const base = (cy * cw + cx) * 4;
    const inside = cx >= half && cx + half < cw && cy >= half && cy + half < ch;
    for (let k = 0; k < cells; k += 1) {
      if (!inside) {
        const px = cx + (dx[k] ?? 0);
        const py = cy + (dy[k] ?? 0);
        if (px < 0 || px >= cw || py < 0 || py >= ch) continue;
      }
      const a = al[k] ?? 0;
      const keep = 1 - a;
      const o = base + (offsets[k] ?? 0);
      acc[o] = r * a + (acc[o] ?? 0) * keep;
      acc[o + 1] = g * a + (acc[o + 1] ?? 0) * keep;
      acc[o + 2] = b * a + (acc[o + 2] ?? 0) * keep;
      acc[o + 3] = a + (acc[o + 3] ?? 0) * keep;
    }
  }
  for (let y = 0; y < ch; y += 1) {
    for (let x = 0; x < cw; x += 1) {
      const s = (y * cw + x) * 4;
      const a = acc[s + 3] ?? 0;
      if (a <= 0) continue;
      const o = ((y + top) * width + x + left) * 4;
      out[o] = (acc[s] ?? 0) / a;
      out[o + 1] = (acc[s + 1] ?? 0) / a;
      out[o + 2] = (acc[s + 2] ?? 0) / a;
      out[o + 3] = a * 255;
    }
  }
  return out;
}

/** Without ImageData (tests), Canvas 2D paths draw squares instead of circles above this many points. */
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
  const prep = prepared(data, 'scatter', () => ({
    xDomain: paddedDomain(data.x, xKind),
    yDomain: paddedDomain(data.y, yKind),
    xResolution: xKind === 'time' ? timeResolution(data.x) : ('millisecond' as const),
    yResolution: yKind === 'time' ? timeResolution(data.y) : ('millisecond' as const),
  }));
  const axes = layoutAxes(width, height, { kind: xKind, domain: prep.xDomain }, { kind: yKind, domain: prep.yDomain }, fonts);
  const { x: xs, y: ys } = axes;
  const { plot } = axes.layout;
  const radius = options.radius ?? 2.5;
  const opacity = options.opacity ?? 0.8;
  const groups = Math.max(1, data.seriesList.length);
  const colorOf = (s: number) => options.colors[s] ?? options.colors[0] ?? '#000';
  const { xResolution, yResolution } = prep;
  const fx = options.formatX ?? ((v: number) => formatAxisValue(v, xKind, xResolution));
  const fy = options.formatY ?? ((v: number) => formatAxisValue(v, yKind, yResolution));

  let grid: PointGrid | null = null;
  const pointGrid = () => {
    grid ??= buildPointGrid(data.length, (i) => xs.toPx(data.x[i] ?? Number.NaN), (i) => ys.toPx(data.y[i] ?? Number.NaN), plot);
    return grid;
  };

  const useSplat = options.splat ?? typeof ImageData !== 'undefined';

  const drawMarks = (ctx: CanvasRenderingContext2D, dc: DrawContext) => {
    if (useSplat) {
      // The layer holds only the points, so the splat can replace its pixels outright.
      const { dpr } = dc;
      const w = Math.round(axes.layout.width * dpr);
      const h = Math.round(axes.layout.height * dpr);
      const rgb = options.colors.map(parseColor);
      const fallback = rgb[0] ?? ([0, 0, 0] as Rgb);
      const order = data.order;
      const pixels = splatDiscs(
        w,
        h,
        data.length,
        (k) => xs.toPx(data.x[order[k] ?? 0] ?? Number.NaN) * dpr,
        (k) => ys.toPx(data.y[order[k] ?? 0] ?? Number.NaN) * dpr,
        (k) => rgb[data.series ? (data.series[order[k] ?? 0] ?? 0) : 0] ?? fallback,
        radius * dpr,
        opacity,
        { left: Math.floor(plot.left * dpr), top: Math.floor(plot.top * dpr), right: Math.ceil((plot.left + plot.width) * dpr), bottom: Math.ceil((plot.top + plot.height) * dpr) },
      );
      ctx.putImageData(new ImageData(pixels, w, h), 0, 0);
      return;
    }
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
