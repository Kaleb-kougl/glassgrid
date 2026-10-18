import type { ResolvedTokens } from '../tokens.js';
import { measureText, type ChartFonts } from './canvas.js';
import { makeScale, tickCount, type AxisScale } from './scales.js';
import type { AxisKind } from './types.js';

/** The plot area inside a chart canvas, CSS px. */
export interface PlotRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ChartLayout {
  readonly width: number;
  readonly height: number;
  readonly plot: PlotRect;
}

export interface AxisTicks {
  readonly values: readonly number[];
  readonly labels: readonly string[];
}

export const PLOT_TOP = 8;
export const PLOT_RIGHT = 12;
const TICK_GAP = 6;
const MIN_LEFT = 24;

export function ticksFor(scale: AxisScale, count: number): AxisTicks {
  const values = scale.ticks(count);
  const format = scale.tickFormat(count);
  return { values, labels: values.map(format) };
}

/** Axis definition from which a layout and its scales are built. */
export interface AxisSpec {
  readonly kind: Exclude<AxisKind, 'category'>;
  readonly domain: readonly [number, number];
}

export interface Axes {
  readonly layout: ChartLayout;
  readonly x: AxisScale;
  readonly y: AxisScale;
  readonly xTicks: AxisTicks;
  readonly yTicks: AxisTicks;
}

/**
 * Lays out a chart of `width`×`height` with a left margin wide enough for
 * the y tick labels and a bottom margin for one line of x tick labels, and
 * builds both scales over the plot rectangle (y grows upwards).
 */
export function layoutAxes(width: number, height: number, xSpec: AxisSpec, ySpec: AxisSpec, fonts: ChartFonts): Axes {
  const bottom = Math.ceil(fonts.tickSize + TICK_GAP + 6);
  const plotHeight = Math.max(10, height - PLOT_TOP - bottom);
  const yProbe = makeScale(ySpec.kind, ySpec.domain, [PLOT_TOP + plotHeight, PLOT_TOP]);
  const yCount = tickCount(plotHeight, 28);
  const yTicks = ticksFor(yProbe, yCount);
  let labelWidth = 0;
  for (const label of yTicks.labels) labelWidth = Math.max(labelWidth, measureText(label, fonts.tick, fonts.tickSize));
  const left = Math.max(MIN_LEFT, Math.ceil(labelWidth + TICK_GAP + 2));
  const plotWidth = Math.max(10, width - left - PLOT_RIGHT);
  const plot = { left, top: PLOT_TOP, width: plotWidth, height: plotHeight };
  const x = makeScale(xSpec.kind, xSpec.domain, [left, left + plotWidth]);
  const xCount = tickCount(plotWidth, xSpec.kind === 'time' ? 90 : 70);
  const y = makeScale(ySpec.kind, ySpec.domain, [PLOT_TOP + plotHeight, PLOT_TOP]);
  return { layout: { width, height, plot }, x, y, xTicks: ticksFor(x, xCount), yTicks };
}

/** Centre of a 1-device-pixel line nearest to `v` (crisp hairlines at any DPR). */
export function crisp(v: number, dpr: number): number {
  return (Math.round(v * dpr - 0.5) + 0.5) / dpr;
}

export interface DrawAxesOptions {
  /** Vertical gridlines at the x ticks too (heatmap, scatter). */
  readonly xGrid?: boolean;
  readonly dpr: number;
}

/**
 * Gridlines, the x baseline and tick labels. X labels that would overlap
 * the previous one (or leave the canvas) are skipped.
 */
export function drawAxes(ctx: CanvasRenderingContext2D, axes: Axes, tokens: ResolvedTokens, fonts: ChartFonts, options: DrawAxesOptions): void {
  const { plot } = axes.layout;
  const { dpr } = options;
  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;
  const hairline = 1 / dpr;

  ctx.fillStyle = tokens.chart.gridline;
  for (const value of axes.yTicks.values) {
    const y = axes.y.toPx(value);
    if (y < plot.top - 0.5 || y > bottom + 0.5) continue;
    ctx.fillRect(plot.left, crisp(y, dpr) - hairline / 2, plot.width, hairline);
  }
  if (options.xGrid) {
    for (const value of axes.xTicks.values) {
      const x = axes.x.toPx(value);
      if (x < plot.left - 0.5 || x > right + 0.5) continue;
      ctx.fillRect(crisp(x, dpr) - hairline / 2, plot.top, hairline, plot.height);
    }
  }

  // Baseline along the bottom of the plot.
  ctx.fillStyle = tokens.chart.axis;
  ctx.fillRect(plot.left, crisp(bottom, dpr) - hairline / 2, plot.width, hairline);

  ctx.font = fonts.tick;
  ctx.fillStyle = tokens.chart.tick;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  axes.yTicks.values.forEach((value, i) => {
    const y = axes.y.toPx(value);
    if (y < plot.top - 0.5 || y > bottom + 0.5) return;
    ctx.fillText(axes.yTicks.labels[i] ?? '', plot.left - TICK_GAP, y);
  });

  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  let lastRight = -Infinity;
  axes.xTicks.values.forEach((value, i) => {
    const x = axes.x.toPx(value);
    if (x < plot.left - 0.5 || x > right + 0.5) return;
    const label = axes.xTicks.labels[i] ?? '';
    const w = ctx.measureText(label).width;
    let cx = x;
    // Keep the label on the canvas: nudge the first and last inwards.
    if (cx - w / 2 < 0) cx = w / 2;
    if (cx + w / 2 > axes.layout.width) cx = axes.layout.width - w / 2;
    if (cx - w / 2 < lastRight + TICK_GAP) return;
    ctx.fillText(label, cx, bottom + TICK_GAP - 1);
    lastRight = cx + w / 2;
  });
}
