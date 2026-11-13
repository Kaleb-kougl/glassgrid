import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from './lib/common.ts';

/*
 * The committed basemap (apps/web/public/map/, written by `basemap`) against
 * its manifest: every output's bytes and SHA-256, inputs pinned to commit
 * SHAs, the layers the map style expects, everything inside the bounds, and
 * runways for the four airports the live-flights views centre on.
 */

const DIR = path.resolve(PACKAGE_ROOT, '..', '..', 'apps', 'web', 'public', 'map');

interface Manifest {
  commits: Record<string, string>;
  inputs: { repo: string; commit: string; url: string; bytes: number; sha256: string }[];
  outputs: { file: string; bytes: number; sha256: string }[];
  counts: Record<string, number>;
  totalBytes: number;
  area: { bounds: [number, number, number, number] };
}

interface Feature {
  properties: { layer: string; [key: string]: unknown };
  geometry: { type: string; coordinates: unknown };
}

const manifest = JSON.parse(readFileSync(path.join(DIR, 'basemap.manifest.json'), 'utf8')) as Manifest;
const data = JSON.parse(readFileSync(path.join(DIR, 'basemap.geojson'), 'utf8')) as { features: Feature[] };

function positions(coordinates: unknown, out: [number, number][] = []): [number, number][] {
  if (Array.isArray(coordinates) && typeof coordinates[0] === 'number') out.push(coordinates as [number, number]);
  else if (Array.isArray(coordinates)) for (const c of coordinates) positions(c, out);
  return out;
}

describe('the committed basemap', () => {
  it('matches its manifest, byte for byte, and stays small', () => {
    for (const output of manifest.outputs) {
      const bytes = readFileSync(path.join(DIR, output.file));
      expect(bytes.byteLength, output.file).toBe(output.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), output.file).toBe(output.sha256);
    }
    expect(manifest.totalBytes).toBe(manifest.outputs.reduce((sum, o) => sum + o.bytes, 0));
    expect(manifest.totalBytes).toBeLessThan(400_000);
    expect(manifest.outputs.map((o) => o.file)).toEqual(expect.arrayContaining(['basemap.geojson', 'basemap.json', 'fonts/Noto Sans Regular/0-255.pbf', 'fonts/OFL.txt']));
  });

  it('pins every input to a commit SHA on raw.githubusercontent.com', () => {
    expect(Object.keys(manifest.commits).sort()).toEqual(['davidmegginson/ourairports-data', 'nvkelso/natural-earth-vector', 'protomaps/basemaps-assets']);
    for (const input of manifest.inputs) {
      expect(input.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(input.commit).toBe(manifest.commits[input.repo]);
      expect(input.url.startsWith(`https://raw.githubusercontent.com/${input.repo}/${input.commit}/`)).toBe(true);
      expect(input.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('holds the layers the style reads, every position inside the bounds, counts as recorded', () => {
    const counts: Record<string, number> = {};
    const [west, south, east, north] = manifest.area.bounds;
    for (const f of data.features) {
      counts[f.properties.layer] = (counts[f.properties.layer] ?? 0) + 1;
      for (const [lon, lat] of positions(f.geometry.coordinates)) {
        expect(lon >= west && lon <= east && lat >= south && lat <= north, `${f.properties.layer} ${lon},${lat}`).toBe(true);
      }
    }
    expect(counts).toEqual(manifest.counts);
    for (const layer of ['land', 'water', 'urban', 'place', 'runway', 'runway-line', 'airport']) expect(counts[layer] ?? 0, layer).toBeGreaterThan(0);
  });

  it('has the runways of SFO, OAK, SJC and San Carlos (KSQL), and their airports', () => {
    const runways = (ident: string) => data.features.filter((f) => f.properties.layer === 'runway' && f.properties['airport'] === ident).map((f) => f.properties['name']);
    expect(runways('KSFO').sort()).toEqual(['10L/28R', '10R/28L', '1L/19R', '1R/19L']);
    expect(runways('KOAK')).toHaveLength(4);
    // SJC's closed 11/29 is left out.
    expect(runways('KSJC').sort()).toEqual(['12L/30R', '12R/30L']);
    expect(runways('KSQL')).toEqual(['12/30']);
    const airports = data.features.filter((f) => f.properties.layer === 'airport').map((f) => f.properties['iata']);
    expect(airports).toEqual(expect.arrayContaining(['SFO', 'OAK', 'SJC', 'SQL']));
  });

  it('describes itself for the map component (basemap.json)', () => {
    const descriptor = JSON.parse(readFileSync(path.join(DIR, 'basemap.json'), 'utf8')) as Record<string, unknown>;
    expect(descriptor).toMatchObject({ version: 1, kind: 'geojson', data: 'basemap.geojson', glyphs: 'fonts/{fontstack}/{range}.pbf', font: 'Noto Sans Regular', bounds: manifest.area.bounds });
    expect((descriptor['credits'] as { text: string }[]).map((c) => c.text)).toEqual(['Natural Earth', 'OurAirports']);
  });
});
