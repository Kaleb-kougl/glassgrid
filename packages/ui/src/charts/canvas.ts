import type { ResolvedTokens } from '../tokens.js';

/*
 * Canvas plumbing shared by every mark: device-pixel sizing, offscreen
 * layers, fonts from the type tokens and text measurement.
 */

let measuring: CanvasRenderingContext2D | null | undefined;

/** A detached 2D context for text measurement (null where canvas is unavailable, e.g. jsdom). */
export function measuringContext(): CanvasRenderingContext2D | null {
  if (measuring === undefined) {
    try {
      measuring = document.createElement('canvas').getContext('2d');
    } catch {
      measuring = null;
    }
  }
  return measuring;
}

/** Forget the cached measuring context (tests swap canvas implementations). */
export function resetMeasuringContext(): void {
  measuring = undefined;
}

/** Width of `text` in `font`, estimated at 0.6 em per character without a canvas. */
export function measureText(text: string, font: string, size: number): number {
  const ctx = measuringContext();
  if (!ctx) return text.length * size * 0.6;
  ctx.font = font;
  return ctx.measureText(text).width;
}

export function withFallback(font: string, mono = false): string {
  return `${font}, ${mono ? 'ui-monospace, monospace' : 'system-ui, sans-serif'}`;
}

/** Fonts the chart layer draws with, from the type tokens. */
export interface ChartFonts {
  readonly tick: string;
  readonly tickSize: number;
  readonly label: string;
  readonly labelBold: string;
  readonly labelSize: number;
  readonly value: string;
  readonly valueBold: string;
  readonly valueSize: number;
}

export function chartFonts(tokens: ResolvedTokens): ChartFonts {
  const tick = tokens.type['chart-tick'];
  const label = tokens.type['chart-label'];
  const value = tokens.type['chart-value'];
  return {
    tick: withFallback(tick.font),
    tickSize: tick.size,
    label: withFallback(label.font),
    labelBold: withFallback(`600 ${label.size}px "IBM Plex Sans"`),
    labelSize: label.size,
    value: withFallback(`400 ${value.size}px "IBM Plex Sans"`),
    valueBold: withFallback(`600 ${value.size}px "IBM Plex Sans"`),
    valueSize: value.size,
  };
}

export function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

export function devicePixelRatioNow(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
}

/**
 * Sizes `canvas` to `width`×`height` CSS px at `dpr` (backing store rounded
 * to whole device pixels) and returns its context scaled to CSS px, or null
 * when there is no 2D context.
 */
export function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr: number, style = true): CanvasRenderingContext2D | null {
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  if (style) {
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** An offscreen layer: a detached canvas at device resolution, drawn in CSS px. */
export interface Layer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
}

export function createLayer(width: number, height: number, dpr: number, reuse?: Layer | null): Layer | null {
  const canvas = reuse?.canvas ?? document.createElement('canvas');
  const ctx = sizeCanvas(canvas, width, height, dpr, false);
  if (!ctx) return null;
  ctx.clearRect(0, 0, width, height);
  return { canvas, ctx };
}

/** Rounded-corner rectangle path (right end only, like the design's bars). */
export function barPath(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x, y + height);
  ctx.closePath();
}
