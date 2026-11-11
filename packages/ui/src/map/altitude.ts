import { parseColor, type Rgb } from '../charts/colors.js';
import { tokensFor, type ThemeName } from '../tokens.js';

/*
 * Altitude bands for the map's aircraft and trails. Colours come from the
 * design tokens (`chart.altitude`, `--gg-chart-alt-1…6`): a plasma-like
 * ramp whose lightness changes monotonically with altitude, so the order
 * still reads under protanopia, deuteranopia and tritanopia (adjacent
 * bands' CIEDE2000 distances are in tokens/checks.json, `altitude`).
 * Aircraft on the ground are a ring in `chart.altGround` instead of a
 * plane: never colour alone.
 */

export interface AltitudeBand {
  /** Index into `chart.altitude`. */
  readonly index: number;
  /** Lower bound in feet (inclusive); the first band starts below zero. */
  readonly minFt: number;
  readonly label: string;
}

export const ALTITUDE_BANDS: readonly AltitudeBand[] = [
  { index: 0, minFt: -Infinity, label: 'Below 1,000 ft' },
  { index: 1, minFt: 1_000, label: '1,000–4,999 ft' },
  { index: 2, minFt: 5_000, label: '5,000–9,999 ft' },
  { index: 3, minFt: 10_000, label: '10,000–19,999 ft' },
  { index: 4, minFt: 20_000, label: '20,000–29,999 ft' },
  { index: 5, minFt: 30_000, label: '30,000 ft and above' },
];

/** What a glyph shows: an altitude band, on the ground, or airborne without an altitude. */
export type AltitudeClass = number | 'ground' | 'unknown';

/** Barometric altitude, else geometric (the feeds report one or the other). */
export function altitudeFt(a: { altBaroFt: number | null; altGeomFt?: number | null }): number | null {
  if (a.altBaroFt !== null && Number.isFinite(a.altBaroFt)) return a.altBaroFt;
  if (a.altGeomFt !== undefined && a.altGeomFt !== null && Number.isFinite(a.altGeomFt)) return a.altGeomFt;
  return null;
}

export function altitudeClass(altFt: number | null, onGround: boolean): AltitudeClass {
  if (onGround) return 'ground';
  if (altFt === null || !Number.isFinite(altFt)) return 'unknown';
  let band = 0;
  for (const b of ALTITUDE_BANDS) if (altFt >= b.minFt) band = b.index;
  return band;
}

export interface AltitudePalette {
  readonly bands: readonly Rgb[];
  readonly ground: Rgb;
  readonly unknown: Rgb;
  readonly outline: Rgb;
  readonly selection: Rgb;
}

const palettes = new Map<ThemeName, AltitudePalette>();

export function altitudePalette(theme: ThemeName): AltitudePalette {
  let palette = palettes.get(theme);
  if (!palette) {
    const t = tokensFor(theme);
    palette = {
      bands: t.chart.altitude.map(parseColor),
      ground: parseColor(t.chart.altGround),
      unknown: parseColor(t.chart.altUnknown),
      outline: parseColor(t.chart.aircraftOutline),
      selection: parseColor(t.chart.selectionStroke),
    };
    palettes.set(theme, palette);
  }
  return palette;
}

export function classColor(palette: AltitudePalette, cls: AltitudeClass): Rgb {
  if (cls === 'ground') return palette.ground;
  if (cls === 'unknown') return palette.unknown;
  return palette.bands[cls] ?? palette.unknown;
}

export interface LegendEntry {
  readonly key: string;
  readonly label: string;
  /** `#rrggbb` from the tokens. */
  readonly color: string;
  /** How the map draws it: a plane glyph, or a ring for ground traffic. */
  readonly shape: 'plane' | 'ring';
  /** The CSS custom property with the same colour (tokens.css). */
  readonly cssVar: string;
}

/** The map's legend, high altitude first, then ground traffic and unknown altitude. */
export function altitudeLegend(theme: ThemeName): LegendEntry[] {
  const t = tokensFor(theme);
  const bands = ALTITUDE_BANDS.map((band) => ({
    key: `band-${band.index + 1}`,
    label: band.label,
    color: t.chart.altitude[band.index] ?? t.chart.altUnknown,
    shape: 'plane' as const,
    cssVar: `--gg-chart-alt-${band.index + 1}`,
  })).reverse();
  return [
    ...bands,
    { key: 'ground', label: 'On the ground', color: t.chart.altGround, shape: 'ring', cssVar: '--gg-chart-alt-ground' },
    { key: 'unknown', label: 'Altitude unknown', color: t.chart.altUnknown, shape: 'plane', cssVar: '--gg-chart-alt-unknown' },
  ];
}
