import type { ExpressionSpecification, FilterSpecification, LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl';
import { tokensFor, type ThemeName } from '../tokens.js';
import { assetUrl, type BasemapCredit, type BasemapDescriptor, type BasemapLayer } from './basemap.js';

/*
 * The MapLibre style, built from the basemap descriptor and the theme's
 * design tokens (`map.*`). Every URL in it is an absolute same-origin URL
 * under the assets base (tested in style.test.ts). Theme changes update
 * paint properties in place (`themePaint`), so the sources are not reloaded.
 */

export const BASEMAP_SOURCE = 'gg-basemap';
export const OVERLAY_SOURCE = 'gg-overlay';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** One attribution entry as the attribution control's HTML: escaped text, linked when there is a URL. */
export function creditHtml(credit: BasemapCredit | string): string {
  if (typeof credit === 'string') return escapeHtml(credit);
  const text = escapeHtml(credit.text);
  return credit.url && /^https:\/\//.test(credit.url) ? `<a href="${escapeHtml(credit.url)}" target="_blank" rel="noopener">${text}</a>` : text;
}

const byLayer = (layer: string): FilterSpecification => ['==', ['get', 'layer'], layer];

/** Where a logical layer's features come from. */
interface Origin {
  readonly source: string;
  readonly sourceLayer?: string;
  readonly filter?: FilterSpecification;
}

function origins(descriptor: BasemapDescriptor): Record<BasemapLayer | 'runway' | 'runway-line' | 'airport', Origin | null> {
  const overlay = descriptor.kind === 'geojson' ? BASEMAP_SOURCE : OVERLAY_SOURCE;
  const overlayLayers = {
    runway: { source: overlay, filter: byLayer('runway') },
    'runway-line': { source: overlay, filter: byLayer('runway-line') },
    airport: { source: overlay, filter: byLayer('airport') },
  };
  if (descriptor.kind === 'geojson') {
    return {
      land: { source: BASEMAP_SOURCE, filter: byLayer('land') },
      water: { source: BASEMAP_SOURCE, filter: byLayer('water') },
      urban: { source: BASEMAP_SOURCE, filter: byLayer('urban') },
      place: { source: BASEMAP_SOURCE, filter: byLayer('place') },
      ...overlayLayers,
    };
  }
  const vector = (layer: BasemapLayer): Origin | null => {
    const mapping = descriptor.layers[layer];
    if (!mapping) return null;
    return { source: BASEMAP_SOURCE, sourceLayer: mapping.sourceLayer, ...(mapping.filter !== undefined ? { filter: mapping.filter as FilterSpecification } : {}) };
  };
  return { land: vector('land'), water: vector('water'), urban: vector('urban'), place: vector('place'), ...overlayLayers };
}

function sources(descriptor: BasemapDescriptor, base: URL): Record<string, SourceSpecification> {
  const attribution = descriptor.credits.map(creditHtml).join(' · ');
  if (descriptor.kind === 'geojson') {
    return { [BASEMAP_SOURCE]: { type: 'geojson', data: assetUrl(descriptor.data, base), attribution, maxzoom: 14, tolerance: 0.25 } };
  }
  const tiles = assetUrl(descriptor.tiles, base);
  return {
    [BASEMAP_SOURCE]: { type: 'vector', url: tiles, attribution, ...(descriptor.maxzoom !== undefined ? { maxzoom: descriptor.maxzoom } : {}) },
    [OVERLAY_SOURCE]: { type: 'geojson', data: assetUrl(descriptor.overlay, base), maxzoom: 14 },
  };
}

/** The paint values that follow the theme, per layer id. */
export function themePaint(theme: ThemeName): Record<string, Record<string, string>> {
  const t = tokensFor(theme);
  const m = t.map;
  return {
    'gg-background': { 'background-color': m.water },
    'gg-land': { 'fill-color': m.land },
    'gg-urban': { 'fill-color': m.urban },
    'gg-water': { 'fill-color': m.water },
    'gg-runway-line': { 'line-color': m.runway },
    'gg-runway': { 'fill-color': m.runway },
    'gg-airport': { 'circle-color': m.runway, 'circle-stroke-color': m.labelHalo },
    'gg-place-label': { 'text-color': m.label, 'text-halo-color': m.labelHalo },
    'gg-airport-label': { 'text-color': m.label, 'text-halo-color': m.labelHalo },
  };
}

/** The style for `descriptor` (served under `base`) in `theme`. The aircraft layer is added on top at runtime. */
export function buildStyle(descriptor: BasemapDescriptor, base: URL, theme: ThemeName): StyleSpecification {
  const paint = themePaint(theme);
  const from = origins(descriptor);
  const layers: LayerSpecification[] = [{ id: 'gg-background', type: 'background', paint: { ...paint['gg-background'] } }];
  const at = (origin: Origin) => ({
    source: origin.source,
    ...(origin.sourceLayer !== undefined ? { 'source-layer': origin.sourceLayer } : {}),
    ...(origin.filter !== undefined ? { filter: origin.filter } : {}),
  });
  if (from.land) layers.push({ id: 'gg-land', type: 'fill', ...at(from.land), paint: { ...paint['gg-land'], 'fill-antialias': true } });
  if (from.urban) layers.push({ id: 'gg-urban', type: 'fill', ...at(from.urban), paint: { ...paint['gg-urban'] } });
  if (from.water) layers.push({ id: 'gg-water', type: 'fill', ...at(from.water), paint: { ...paint['gg-water'] } });
  const runwayWidth: ExpressionSpecification = ['interpolate', ['exponential', 2], ['zoom'], 8, 0.75, 12, 3, 13, 5];
  if (from['runway-line']) layers.push({ id: 'gg-runway-line', type: 'line', ...at(from['runway-line']), maxzoom: 13, layout: { 'line-cap': 'butt' }, paint: { ...paint['gg-runway-line'], 'line-width': runwayWidth } });
  if (from.runway) layers.push({ id: 'gg-runway', type: 'fill', ...at(from.runway), minzoom: 12, paint: { ...paint['gg-runway'] } });
  if (from.airport) {
    layers.push({
      id: 'gg-airport',
      type: 'circle',
      ...at(from.airport),
      maxzoom: 10,
      paint: { ...paint['gg-airport'], 'circle-radius': ['match', ['get', 'kind'], 'large', 3.5, 2.5], 'circle-stroke-width': 1 },
    });
  }
  const font = [descriptor.font];
  if (from.place) {
    layers.push({
      id: 'gg-place-label',
      type: 'symbol',
      ...at(from.place),
      layout: {
        'text-field': ['get', 'name'],
        'text-font': font,
        'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 12, 13],
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 10],
        'text-max-width': 8,
      },
      paint: { ...paint['gg-place-label'], 'text-halo-width': 1.25 },
    });
  }
  if (from.airport) {
    const code: ExpressionSpecification = ['coalesce', ['get', 'iata'], ['get', 'ident']];
    layers.push({
      id: 'gg-airport-label',
      type: 'symbol',
      ...at(from.airport),
      layout: {
        'text-field': ['step', ['zoom'], code, 11, ['format', code, {}, '\n', {}, ['get', 'name'], { 'font-scale': 0.85 }]],
        'text-font': font,
        'text-size': ['match', ['get', 'kind'], 'large', 12, 11],
        'text-anchor': 'top',
        'text-offset': [0, 0.6],
        'text-max-width': 10,
        'symbol-sort-key': ['match', ['get', 'kind'], 'large', 0, 1],
      },
      paint: { ...paint['gg-airport-label'], 'text-halo-width': 1.25 },
    });
  }
  return {
    version: 8,
    name: `Glassgrid live flights (${theme})`,
    glyphs: assetUrl(descriptor.glyphs, base),
    sources: sources(descriptor, base),
    layers,
  };
}
