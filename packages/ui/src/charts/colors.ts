import type { ResolvedTokens } from '../tokens.js';
import type { ChartSeries } from './types.js';

/*
 * Colour assignment. Series take the categorical palette in rank order
 * (8 colours; the compiler keeps at most 8 named series) and "Other" takes
 * the neutral `chart.other`. Heatmaps map counts onto the sequential ramp.
 */

export type Rgb = readonly [number, number, number];

/** `#rrggbb` / `#rgb` / `rgb(a)(…)` → [r, g, b] 0–255 (black for anything else). */
export function parseColor(color: string): Rgb {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex?.[1]) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [0, 0, 0];
}

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');

export function toHex([r, g, b]: Rgb): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** Colour of each series (indexed like `seriesList`). */
export function seriesColors(seriesList: readonly ChartSeries[], tokens: ResolvedTokens, colorKeys?: readonly string[]): string[] {
  const palette = tokens.chart.categorical;
  const fallback = tokens.chart.mark;
  if (seriesList.length === 0) return [fallback];
  // Keys pinned by the caller (e.g. kept across cross-filter updates) keep their slot.
  const taken = new Set<number>();
  const pinned = new Map<string, number>();
  colorKeys?.forEach((key, slot) => {
    if (slot < palette.length) {
      pinned.set(key, slot);
      taken.add(slot);
    }
  });
  let next = 0;
  return seriesList.map((series) => {
    if (series.isOther) return tokens.chart.other;
    const slot = pinned.get(series.key);
    if (slot !== undefined) return palette[slot] ?? fallback;
    while (taken.has(next) && next < palette.length) next += 1;
    if (next >= palette.length) return tokens.chart.other;
    taken.add(next);
    return palette[next] ?? fallback;
  });
}

/** The colour at `t` (0–1) along a piecewise-linear ramp of stops. */
export function rampAt(stops: readonly string[], t: number): Rgb {
  const parsed = stops.map(parseColor);
  if (parsed.length === 0) return [0, 0, 0];
  if (parsed.length === 1) return parsed[0] ?? [0, 0, 0];
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const pos = clamped * (parsed.length - 1);
  const i = Math.min(parsed.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = parsed[i] ?? [0, 0, 0];
  const b = parsed[i + 1] ?? a;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** `steps` colours sampled evenly along the ramp (a lookup table for drawing many cells). */
export function rampLut(stops: readonly string[], steps = 64): string[] {
  const out: string[] = [];
  for (let i = 0; i < steps; i += 1) out.push(toHex(rampAt(stops, steps === 1 ? 1 : i / (steps - 1))));
  return out;
}

/** How a count maps onto the ramp. `sqrt` (default) keeps sparse cells visible next to dense ones. */
export type RampTransform = 'linear' | 'sqrt' | 'log';

/** Position (0–1) of `value` on a ramp spanning `[0, max]`. Values ≤ 0 map to 0. */
export function rampPosition(value: number, max: number, transform: RampTransform): number {
  if (!(value > 0) || !(max > 0)) return 0;
  switch (transform) {
    case 'linear':
      return Math.min(1, value / max);
    case 'log':
      return Math.min(1, Math.log1p(value) / Math.log1p(max));
    default:
      return Math.min(1, Math.sqrt(value / max));
  }
}

/** The inverse of `rampPosition` (for legend ticks). */
export function rampValue(position: number, max: number, transform: RampTransform): number {
  const p = Math.max(0, Math.min(1, position));
  switch (transform) {
    case 'linear':
      return p * max;
    case 'log':
      return Math.expm1(p * Math.log1p(max));
    default:
      return p * p * max;
  }
}
