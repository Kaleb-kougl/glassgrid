/**
 * @vitest-environment node
 */
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { tokensFor } from '../tokens';
import { assetUrl, parseDescriptor, resolveAssetsBase, type BasemapDescriptor } from './basemap';
import { buildStyle, creditHtml, themePaint } from './style';
// The descriptor the basemap tool commits (tools/datasets `basemap`).
import committed from '../../../../apps/web/public/map/basemap.json';

const PAGE = 'https://example.test/glassgrid/?map';
const base = resolveAssetsBase('/glassgrid/map/', PAGE);
const geojson: BasemapDescriptor = parseDescriptor(committed);

/** Every URL a style references: sources, glyphs, sprite. */
function urls(style: ReturnType<typeof buildStyle>): string[] {
  const out = [style.glyphs ?? ''];
  for (const source of Object.values(style.sources)) {
    if ('data' in source && typeof source.data === 'string') out.push(source.data);
    if ('url' in source && typeof source.url === 'string') out.push(source.url);
  }
  return out.filter(Boolean);
}

describe('the basemap descriptor', () => {
  it('the committed one parses: GeoJSON data, glyphs and both credits', () => {
    expect(geojson.kind).toBe('geojson');
    expect(geojson.credits.map((c) => c.text)).toEqual(['Natural Earth', 'OurAirports']);
    expect(geojson.bounds[0]).toBeLessThan(-123);
    expect(geojson.bounds[2]).toBeGreaterThan(-121.5);
  });

  it('rejects malformed descriptors with a reason', () => {
    const good = { ...committed } as Record<string, unknown>;
    expect(() => parseDescriptor({ ...good, version: 2 })).toThrow(/version/);
    expect(() => parseDescriptor({ ...good, bounds: [0, 0, 0, 0] })).toThrow(/bounds/);
    expect(() => parseDescriptor({ ...good, glyphs: 'fonts/a.pbf' })).toThrow(/glyphs/);
    expect(() => parseDescriptor({ ...good, kind: 'raster' })).toThrow(/kind/);
    expect(() => parseDescriptor({ ...good, kind: 'vector' })).toThrow(/tiles/);
    expect(() => parseDescriptor(null)).toThrow();
  });

  it('only resolves same-origin locations', () => {
    expect(resolveAssetsBase('/map', PAGE).href).toBe('https://example.test/map/');
    expect(resolveAssetsBase('map/', PAGE).href).toBe('https://example.test/glassgrid/map/');
    expect(() => resolveAssetsBase('https://tiles.example.com/map/', PAGE)).toThrow(/same-origin/);
    expect(() => assetUrl('https://elsewhere.test/a.geojson', base)).toThrow(/same-origin/);
    expect(assetUrl('fonts/{fontstack}/{range}.pbf', base)).toBe('https://example.test/glassgrid/map/fonts/{fontstack}/{range}.pbf');
    expect(assetUrl('pmtiles://bay.pmtiles', base)).toBe('pmtiles://https://example.test/glassgrid/map/bay.pmtiles');
  });
});

describe('buildStyle', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`is a valid MapLibre style (${theme}) whose every URL is same-origin under the assets base`, () => {
      const style = buildStyle(geojson, base, theme);
      expect(validateStyleMin(style)).toEqual([]);
      for (const url of urls(style)) expect(url.startsWith('https://example.test/glassgrid/map/'), url).toBe(true);
      expect(style.sprite).toBeUndefined();
      const ids = style.layers.map((layer) => layer.id);
      expect(ids).toEqual(['gg-background', 'gg-land', 'gg-urban', 'gg-water', 'gg-runway-line', 'gg-runway', 'gg-airport', 'gg-place-label', 'gg-airport-label']);
      // Colours are the theme's map tokens.
      const background = style.layers[0];
      expect(background && 'paint' in background ? background.paint : null).toEqual({ 'background-color': tokensFor(theme).map.water });
    });
  }

  it('themePaint covers exactly the style layers that use theme colours', () => {
    const style = buildStyle(geojson, base, 'light');
    const ids = new Set(style.layers.map((layer) => layer.id));
    for (const id of Object.keys(themePaint('dark'))) expect(ids.has(id), id).toBe(true);
  });

  it('a vector (PMTiles) descriptor maps logical layers to source layers and keeps airports in a GeoJSON overlay', () => {
    const vector = parseDescriptor({
      version: 1,
      kind: 'vector',
      tiles: 'pmtiles://bay-area.pmtiles',
      overlay: 'basemap.geojson',
      layers: { land: { sourceLayer: 'earth' }, water: { sourceLayer: 'water' }, place: { sourceLayer: 'places', filter: ['==', ['get', 'kind'], 'locality'] } },
      bounds: geojson.bounds,
      glyphs: 'fonts/{fontstack}/{range}.pbf',
      font: 'Noto Sans Regular',
      credits: [...geojson.credits, { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' }],
    });
    const style = buildStyle(vector, base, 'dark');
    expect(validateStyleMin(style)).toEqual([]);
    const land = style.layers.find((layer) => layer.id === 'gg-land');
    expect(land && 'source-layer' in land ? land['source-layer'] : null).toBe('earth');
    expect(style.layers.some((layer) => layer.id === 'gg-urban')).toBe(false);
    const runway = style.layers.find((layer) => layer.id === 'gg-runway');
    expect(runway && 'source' in runway ? runway.source : null).toBe('gg-overlay');
    expect(JSON.stringify(style.sources)).toContain('OpenStreetMap');
  });
});

describe('creditHtml', () => {
  it('escapes text and links only https URLs', () => {
    expect(creditHtml('Data © <b>x</b> & "y"')).toBe('Data © &#60;b&#62;x&#60;/b&#62; &#38; &#34;y&#34;');
    expect(creditHtml({ text: 'OurAirports', url: 'https://ourairports.com/data/' })).toBe('<a href="https://ourairports.com/data/" target="_blank" rel="noopener">OurAirports</a>');
    expect(creditHtml({ text: 'Evil', url: 'javascript:alert(1)' })).toBe('Evil');
  });
});
