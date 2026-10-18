import { area as d3Area, line as d3Line } from 'd3-shape';
import type { TooltipRow } from '../../components/Tooltip.js';
import { crisp, drawAxes, layoutAxes } from '../axes.js';
import type { ChartFonts } from '../canvas.js';
import { formatAggregate, formatAxisValue, timeResolution } from '../format.js';
import { nearestSorted } from '../hit.js';
import type { ChartModel, DrawContext, HoverInfo } from '../model.js';
import { prepared } from '../prep.js';
import { extent, measureDomain } from '../scales.js';
import type { ChartColumns } from '../types.js';

export interface LineModelOptions {
  readonly mark: 'line' | 'area';
  readonly yLabel: string;
  /** Colour of each series (one entry without a colour field). */
  readonly colors: readonly string[];
  readonly formatValue?: (value: number) => string;
  /** Area fill opacity (each series is filled from the baseline, not stacked). */
  readonly areaOpacity?: number;
}

/** Hover reaches this far (CSS px) from the nearest point along x. */
const HOVER_REACH = 24;

/** A series with at least this many rows per CSS px of plot width draws as a column envelope. */
export const DENSE_ROWS_PER_PX = 0.5;

/**
 * Draws a dense polyline (M4 output: up to 4 rows per pixel column) as
 * the filled envelope of what each device-pixel column covers: per column,
 * the y range every segment crosses inside it, widened by half the line
 * width (more for slanted segments, so the visible thickness stays even).
 * Every column shows exactly the min…max of the data in it, which is what
 * makes M4 pixel-faithful, and one polygon fill rasterizes far faster than
 * stroking thousands of tiny round-joined segments. NULLs break the line.
 * Returns the number of polygons filled.
 */
export function fillLineEnvelope(
  ctx: CanvasRenderingContext2D,
  rows: ArrayLike<number>,
  px: (i: number) => number,
  py: (i: number) => number,
  defined: (i: number) => boolean,
  lineWidth: number,
  dpr: number,
  plotLeft: number,
  plotWidth: number,
): number {
  const left = plotLeft - lineWidth;
  const cols = Math.ceil((plotWidth + 2 * lineWidth) * dpr) + 1;
  const top = new Float64Array(cols).fill(Infinity);
  const bottom = new Float64Array(cols).fill(-Infinity);
  const half = lineWidth / 2;
  const mark = (c: number, y0: number, y1: number) => {
    if (c < 0 || c >= cols) return;
    if (y0 < (top[c] ?? Infinity)) top[c] = y0;
    if (y1 > (bottom[c] ?? -Infinity)) bottom[c] = y1;
  };
  const column = (x: number) => Math.floor((x - left) * dpr);
  for (let k = 0; k < rows.length; k += 1) {
    const i = rows[k] ?? 0;
    if (!defined(i)) continue;
    const xa = px(i);
    const ya = py(i);
    const j = k + 1 < rows.length ? (rows[k + 1] ?? 0) : -1;
    if (j < 0 || !defined(j)) {
      // End of a run (or an isolated point): its own column.
      mark(column(xa), ya - half, ya + half);
      continue;
    }
    const xb = px(j);
    const yb = py(j);
    const dx = xb - xa;
    const slope = dx > 1e-9 ? (yb - ya) / dx : 0;
    const ca = column(xa);
    const cb = column(xb);
    if (ca === cb || dx <= 1e-9) {
      // Inside one column the data's own extent is the span: never overshoot it.
      mark(ca, Math.min(ya, yb) - half, Math.max(ya, yb) + half);
      continue;
    }
    // Across columns, thicken slanted segments a little so diagonals do not look thinner than flats.
    const h = half * Math.min(Math.sqrt(1 + slope * slope), Math.SQRT2);
    for (let c = Math.max(0, ca); c <= Math.min(cols - 1, cb); c += 1) {
      const x0 = Math.max(xa, left + c / dpr);
      const x1 = Math.min(xb, left + (c + 1) / dpr);
      const y0 = ya + slope * (x0 - xa);
      const y1 = ya + slope * (x1 - xa);
      mark(c, Math.min(y0, y1) - h, Math.max(y0, y1) + h);
    }
  }
  let polygons = 0;
  ctx.beginPath();
  let c = 0;
  while (c < cols) {
    if ((top[c] ?? Infinity) === Infinity) {
      c += 1;
      continue;
    }
    const start = c;
    while (c < cols && (top[c] ?? Infinity) !== Infinity) c += 1;
    const end = c - 1;
    const xc = (k: number) => left + (k + 0.5) / dpr;
    // Upper edge left to right (from the run's left pixel edge), lower edge back.
    ctx.moveTo(left + start / dpr, top[start] ?? 0);
    for (let k = start; k <= end; k += 1) ctx.lineTo(xc(k), top[k] ?? 0);
    ctx.lineTo(left + (end + 1) / dpr, top[end] ?? 0);
    ctx.lineTo(left + (end + 1) / dpr, bottom[end] ?? 0);
    for (let k = end; k >= start; k -= 1) ctx.lineTo(xc(k), bottom[k] ?? 0);
    ctx.lineTo(left + start / dpr, bottom[start] ?? 0);
    ctx.closePath();
    polygons += 1;
  }
  ctx.fill();
  return polygons;
}

/**
 * Line / area: one polyline per series through every row in x order. M4
 * output (first, last, min and max per pixel column) is drawn as is, so the
 * line is pixel-identical to the full series; NULL measures break the line.
 */
export function buildLineModel(data: ChartColumns, width: number, height: number, fonts: ChartFonts, options: LineModelOptions): ChartModel {
  const xKind = data.xKind === 'time' ? 'time' : 'number';
  const prep = prepared(data, 'line', () => ({
    xExtent: extent(data.x) ?? ([0, 1] as [number, number]),
    yDomain: measureDomain(data.y, 5),
    resolution: xKind === 'time' ? timeResolution(data.x) : ('millisecond' as const),
  }));
  const axes = layoutAxes(width, height, { kind: xKind, domain: prep.xExtent }, { kind: 'number', domain: prep.yDomain }, fonts);
  const { x: xs, y: ys } = axes;
  const { plot } = axes.layout;
  const { x, y, order, seriesStart } = data;
  const groups = seriesStart.length - 1;
  const format = options.formatValue ?? formatAggregate;
  const { resolution } = prep;
  const baseline = ys.toPx(Math.max(ys.domain[0], Math.min(ys.domain[1], 0)));
  const colorOf = (s: number) => options.colors[s] ?? options.colors[0] ?? '#000';

  const px = (i: number) => xs.toPx(x[i] ?? 0);
  const py = (i: number) => ys.toPx(y[i] ?? 0);
  const defined = (i: number) => !Number.isNaN(y[i] ?? Number.NaN);

  const drawMarks = (ctx: CanvasRenderingContext2D, dc: DrawContext) => {
    const lineW = dc.tokens.chart.lineW;
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.left - lineW, plot.top - lineW, plot.width + 2 * lineW, plot.height + 2 * lineW);
    ctx.clip();
    for (let s = 0; s < groups; s += 1) {
      const rows = order.subarray(seriesStart[s] ?? 0, seriesStart[s + 1] ?? 0);
      if (rows.length === 0) continue;
      const color = colorOf(s);
      if (options.mark === 'area') {
        ctx.globalAlpha = options.areaOpacity ?? (groups > 1 ? 0.14 : 0.22);
        ctx.fillStyle = color;
        ctx.beginPath();
        d3Area<number>().x(px).y0(baseline).y1(py).defined(defined).context(ctx)(rows);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (rows.length >= plot.width * DENSE_ROWS_PER_PX) {
        ctx.fillStyle = color;
        fillLineEnvelope(ctx, rows, px, py, defined, lineW, dc.dpr, plot.left, plot.width);
        continue;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = lineW;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      d3Line<number>().x(px).y(py).defined(defined).context(ctx)(rows);
      ctx.stroke();
      // A point with NULL on both sides draws no segment: show it as a dot.
      ctx.fillStyle = color;
      for (let k = 0; k < rows.length; k += 1) {
        const i = rows[k] ?? 0;
        if (!defined(i)) continue;
        const prev = k > 0 && defined(rows[k - 1] ?? 0);
        const next = k < rows.length - 1 && defined(rows[k + 1] ?? 0);
        if (!prev && !next) {
          ctx.beginPath();
          ctx.arc(px(i), py(i), lineW, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  };

  const hitTest = (pointerX: number, pointerY: number): HoverInfo | null => {
    if (data.length === 0) return null;
    if (pointerX < plot.left - HOVER_REACH || pointerX > plot.left + plot.width + HOVER_REACH) return null;
    if (pointerY < plot.top - 4 || pointerY > plot.top + plot.height + 4) return null;
    const value = xs.fromPx(pointerX);
    const nearest: number[] = [];
    let anchor = -1;
    let best = Infinity;
    for (let s = 0; s < groups; s += 1) {
      const row = nearestSorted(x, order, seriesStart[s] ?? 0, seriesStart[s + 1] ?? 0, value);
      nearest.push(row);
      if (row < 0) continue;
      const d = Math.abs(px(row) - pointerX);
      const dy = defined(row) ? Math.abs(py(row) - pointerY) : Infinity;
      if (d < best - 0.5 || (Math.abs(d - best) <= 0.5 && anchor >= 0 && dy < Math.abs(py(anchor) - pointerY))) {
        best = d;
        anchor = row;
      }
    }
    if (anchor < 0 || best > HOVER_REACH) return null;
    const ax = px(anchor);
    const rows: TooltipRow[] = [];
    const points: { x: number; y: number; color: string }[] = [];
    nearest.forEach((row, s) => {
      if (row < 0 || Math.abs(px(row) - ax) > 1.5) return;
      const series = data.seriesList[s];
      const v = y[row] ?? Number.NaN;
      rows.push({ label: series ? series.label : options.yLabel, value: Number.isNaN(v) ? '–' : format(v) });
      if (!Number.isNaN(v)) points.push({ x: px(row), y: py(row), color: colorOf(s) });
    });
    const title = data.seriesList.length > 0 ? `${formatAxisValue(x[anchor] ?? 0, xKind, resolution)} · ${options.yLabel}` : formatAxisValue(x[anchor] ?? 0, xKind, resolution);
    const anchorY = points.length > 0 ? Math.min(...points.map((p) => p.y)) : plot.top + plot.height / 2;
    return {
      anchor: { x: ax, y: anchorY },
      title,
      rows,
      highlight: (ctx, dc) => {
        ctx.save();
        ctx.strokeStyle = dc.tokens.chart.tick;
        ctx.fillStyle = dc.tokens.color.cardBg;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        const rx = crisp(ax, dc.dpr);
        ctx.moveTo(rx, plot.top);
        ctx.lineTo(rx, plot.top + plot.height);
        ctx.stroke();
        ctx.setLineDash([]);
        for (const p of points) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = p.color;
          ctx.stroke();
        }
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
    snapX: null,
    snapY: null,
    drawBackground: (ctx, dc) => drawAxes(ctx, axes, dc.tokens, dc.fonts, { dpr: dc.dpr }),
    drawMarks,
    hitTest,
  };
}
