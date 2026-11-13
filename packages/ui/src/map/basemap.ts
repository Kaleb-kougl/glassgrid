/*
 * The basemap descriptor: `<assetsBase>basemap.json`, written by
 * `pnpm --filter @glassgrid/datasets basemap` next to the data it points at.
 * The style (style.ts) is built from it, so switching the basemap is a data
 * change:
 *
 * - `kind: 'geojson'` (what ships): one GeoJSON file whose features carry a
 *   `layer` property (land, water, urban, place, runway, runway-line,
 *   airport).
 * - `kind: 'vector'`: a vector tile source (a TileJSON URL, or a
 *   `pmtiles://` URL once the pmtiles protocol is registered) for land,
 *   water, urban areas and places, with each logical layer mapped to a
 *   source layer; airports and runways still come from a GeoJSON overlay
 *   in the format above. Not used yet: see docs/live-flights-l3-map.md,
 *   "Replacing the basemap".
 *
 * Paths are relative to the descriptor. Only same-origin URLs are allowed
 * (the CSP's connect-src is 'self').
 */

export type BasemapLayer = 'land' | 'water' | 'urban' | 'place';

export interface BasemapCredit {
  readonly text: string;
  readonly url?: string;
}

interface DescriptorCommon {
  readonly version: 1;
  /** [west, south, east, north]: the area the data covers (the map does not pan beyond it). */
  readonly bounds: readonly [number, number, number, number];
  /** Glyph URL template, `{fontstack}` and `{range}` filled in by MapLibre. */
  readonly glyphs: string;
  /** The font stack labels use (one font, as shipped in the glyph folder). */
  readonly font: string;
  readonly credits: readonly BasemapCredit[];
}

export interface GeoJsonBasemap extends DescriptorCommon {
  readonly kind: 'geojson';
  /** The GeoJSON file with every layer. */
  readonly data: string;
}

export interface VectorSourceLayer {
  readonly sourceLayer: string;
  /** A MapLibre filter expression applied on top of the source layer. */
  readonly filter?: unknown;
}

export interface VectorBasemap extends DescriptorCommon {
  readonly kind: 'vector';
  /** A TileJSON URL or `pmtiles://<file>` (relative paths resolve against the descriptor). */
  readonly tiles: string;
  readonly layers: Readonly<Partial<Record<BasemapLayer, VectorSourceLayer>>>;
  /** GeoJSON with the airport, runway and runway-line features. */
  readonly overlay: string;
  readonly maxzoom?: number;
}

export type BasemapDescriptor = GeoJsonBasemap | VectorBasemap;

export const DESCRIPTOR_FILE = 'basemap.json';

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Validates a parsed basemap.json; throws with what is wrong. */
export function parseDescriptor(value: unknown): BasemapDescriptor {
  if (!value || typeof value !== 'object') throw new Error('basemap.json: not an object');
  const d = value as Record<string, unknown>;
  if (d['version'] !== 1) throw new Error(`basemap.json: unsupported version ${JSON.stringify(d['version'])}`);
  const bounds = d['bounds'];
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error('basemap.json: bounds must be [west, south, east, north]');
  const [west, south, east, north] = bounds as number[];
  if (!((west as number) < (east as number) && (south as number) < (north as number))) throw new Error('basemap.json: empty bounds');
  if (!isString(d['glyphs']) || !d['glyphs'].includes('{fontstack}') || !d['glyphs'].includes('{range}')) throw new Error('basemap.json: glyphs must contain {fontstack} and {range}');
  if (!isString(d['font'])) throw new Error('basemap.json: font missing');
  const credits = d['credits'];
  if (!Array.isArray(credits) || !credits.every((c) => c && typeof c === 'object' && isString((c as Record<string, unknown>)['text']))) throw new Error('basemap.json: credits must be [{ text, url? }]');
  const common = { version: 1 as const, bounds: bounds as unknown as [number, number, number, number], glyphs: d['glyphs'], font: d['font'], credits: credits as BasemapCredit[] };
  if (d['kind'] === 'geojson') {
    if (!isString(d['data'])) throw new Error('basemap.json: data missing');
    return { ...common, kind: 'geojson', data: d['data'] };
  }
  if (d['kind'] === 'vector') {
    if (!isString(d['tiles']) || !isString(d['overlay'])) throw new Error('basemap.json: tiles and overlay are required for kind "vector"');
    const layers = d['layers'];
    if (!layers || typeof layers !== 'object') throw new Error('basemap.json: layers missing');
    return { ...common, kind: 'vector', tiles: d['tiles'], overlay: d['overlay'], layers: layers, ...(typeof d['maxzoom'] === 'number' ? { maxzoom: d['maxzoom'] } : {}) };
  }
  throw new Error(`basemap.json: unknown kind ${JSON.stringify(d['kind'])}`);
}

/**
 * `assetsBase` as an absolute URL with a trailing slash, resolved against
 * `pageUrl`. Throws for anything that is not on the page's origin.
 */
export function resolveAssetsBase(assetsBase: string, pageUrl: string): URL {
  const base = new URL(assetsBase.endsWith('/') ? assetsBase : `${assetsBase}/`, pageUrl);
  const page = new URL(pageUrl);
  if (base.origin !== page.origin) throw new Error(`assetsBase must be same-origin (got ${base.origin}, page ${page.origin})`);
  return base;
}

/** A descriptor path as an absolute same-origin URL (`pmtiles://` keeps its scheme around the resolved path). */
export function assetUrl(path: string, base: URL): string {
  if (path.startsWith('pmtiles://')) return `pmtiles://${assetUrl(path.slice('pmtiles://'.length), base)}`;
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error(`basemap asset ${path} is not same-origin`);
  // MapLibre fills in {fontstack} and {range}: keep the braces readable.
  return url.href.replaceAll('%7B', '{').replaceAll('%7D', '}');
}
