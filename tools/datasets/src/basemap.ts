/**
 * The live-flights map's self-hosted basemap: land, water, urban areas and
 * city labels from Natural Earth 10m, airports and runways from
 * OurAirports, and SDF glyphs for one font from protomaps/basemaps-assets,
 * all clipped to the Bay Area and written into apps/web/public/map/.
 *
 *   pnpm --filter @glassgrid/datasets basemap                 # the pinned commits below
 *   pnpm --filter @glassgrid/datasets basemap -- --latest     # resolve each repository's HEAD (git ls-remote) first
 *   pnpm --filter @glassgrid/datasets basemap -- --out DIR
 *
 * Every input is a raw file at a pinned commit on raw.githubusercontent.com
 * (cached in out/cache/basemap/). The manifest records each commit, URL,
 * size and SHA-256, and each output's size and SHA-256. A rerun at the same
 * commits writes the same bytes: features are in source order, coordinates
 * rounded to 5 decimals (about 1 m) and JSON written with a fixed layout.
 * Nothing depends on the clock (the manifest has no timestamp), so the
 * manifest is byte-stable too.
 *
 * Behind a proxy set NODE_USE_ENV_PROXY=1 (Node's fetch then honours
 * HTTPS_PROXY). `--latest` needs `git` and github.com.
 *
 * A real OpenStreetMap basemap (better shorelines, roads) is a PMTiles
 * extract instead; see docs/live-flights-l3-map.md, "Replacing the basemap".
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { BAY_AREA_BBOX } from '@glassgrid/core';
import {
  clipPolygons,
  csvNumber,
  csvRecords,
  expandBox,
  featureCollectionJson,
  glyphRanges,
  inBox,
  polygonsOf,
  roundTo,
  runwayPolygon,
  type LonLatBox,
  type Position,
} from './lib/basemap.ts';
import { cliArgs, ensureDir, formatBytes, log, PACKAGE_ROOT, runCli } from './lib/common.ts';
import { fetchCached } from './lib/download.ts';

/** Bump when the files this recipe writes would change for the same inputs. */
const RECIPE = 'basemap-bay-area/1';
const DEFAULT_OUT = path.resolve(PACKAGE_ROOT, '..', '..', 'apps', 'web', 'public', 'map');
const CACHE_DIR = path.join(PACKAGE_ROOT, 'out', 'cache', 'basemap');

/** The pinned commits (resolved with `git ls-remote <repo> HEAD` on 2026-11-10). */
export const PINNED_COMMITS = {
  'nvkelso/natural-earth-vector': 'ca96624a56bd078437bca8184e78163e5039ad19',
  'davidmegginson/ourairports-data': '480cb340247e7dfd6c22e31d309895ef003e3d80',
  'protomaps/basemaps-assets': '028c18f713baecad011301ff7a69acc39bcc2ae7',
} as const;
type Repo = keyof typeof PINNED_COMMITS;

/** The data area: the flights box plus a margin, so the edges of the view are not blank. */
const MARGIN_DEG = 0.25;
const BOX: LonLatBox = expandBox(BAY_AREA_BBOX, MARGIN_DEG);
const DECIMALS = 5;
/** Douglas–Peucker tolerance: about 20 m, well below Natural Earth 10m's own detail (~300 m). */
const TOLERANCE_DEG = 0.0002;
/** Drop slivers under about 100 m × 100 m (twice the area in deg²). */
const MIN_AREA2 = 2 * 1e-6;
const AIRPORT_TYPES = new Set(['large_airport', 'medium_airport']);
const FONT = 'Noto Sans Regular';
const DATA_FILE = 'basemap.geojson';
const DESCRIPTOR_FILE = 'basemap.json';
const MANIFEST_FILE = 'basemap.manifest.json';
/** Warn above this: the basemap is fetched by every visitor who opens the map. */
const SIZE_BUDGET = 400_000;

const NE_FILES = {
  land: 'geojson/ne_10m_land.geojson',
  minorIslands: 'geojson/ne_10m_minor_islands.geojson',
  lakes: 'geojson/ne_10m_lakes.geojson',
  lakesNorthAmerica: 'geojson/ne_10m_lakes_north_america.geojson',
  urban: 'geojson/ne_10m_urban_areas.geojson',
  places: 'geojson/ne_10m_populated_places_simple.geojson',
} as const;
const OA_FILES = { airports: 'airports.csv', runways: 'runways.csv' } as const;

export const CREDITS = [
  { text: 'Natural Earth', url: 'https://www.naturalearthdata.com/', licence: 'Public domain' },
  { text: 'OurAirports', url: 'https://ourairports.com/data/', licence: 'Public domain' },
] as const;

function rawUrl(repo: Repo, commit: string, file: string): string {
  return `https://raw.githubusercontent.com/${repo}/${commit}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

async function resolveHead(repo: string): Promise<string> {
  const { stdout } = await promisify(execFile)('git', ['ls-remote', `https://github.com/${repo}`, 'HEAD'], { timeout: 60_000 });
  const sha = /^([0-9a-f]{40})\s+HEAD$/m.exec(stdout)?.[1];
  if (!sha) throw new Error(`git ls-remote ${repo}: no HEAD in ${JSON.stringify(stdout)}`);
  return sha;
}

interface Input {
  repo: Repo;
  commit: string;
  file: string;
  url: string;
  bytes: number;
  sha256: string;
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

interface GeoJsonFeature {
  type: 'Feature';
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
}

async function readCollection(file: string): Promise<GeoJsonFeature[]> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { features?: GeoJsonFeature[] };
  return parsed.features ?? [];
}

/** One output feature: `layer` first, so the style filters on it (`["==", ["get", "layer"], "land"]`). */
function feature(layer: string, properties: Record<string, unknown>, geometry: { type: string; coordinates: unknown }) {
  return { type: 'Feature', properties: { layer, ...properties }, geometry };
}

function polygonFeatures(layer: string, source: readonly GeoJsonFeature[], props: (p: Record<string, unknown>) => Record<string, unknown> = () => ({})) {
  const out: ReturnType<typeof feature>[] = [];
  for (const f of source) {
    const polygons = clipPolygons(polygonsOf(f.geometry), { box: BOX, tolerance: TOLERANCE_DEG, decimals: DECIMALS, minArea2: MIN_AREA2 });
    if (polygons.length === 0) continue;
    const geometry = polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
    out.push(feature(layer, props(f.properties ?? {}), geometry));
  }
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: cliArgs(),
    options: { out: { type: 'string' }, latest: { type: 'boolean', default: false } },
  });
  const out = path.resolve(values.out ?? DEFAULT_OUT);
  const commits: Record<Repo, string> = { ...PINNED_COMMITS };
  if (values.latest) {
    for (const repo of Object.keys(commits) as Repo[]) {
      commits[repo] = await resolveHead(repo);
      log(`${repo} HEAD = ${commits[repo]}${commits[repo] === PINNED_COMMITS[repo] ? ' (pinned)' : ' (newer than the pin: update PINNED_COMMITS to keep it)'}`);
    }
  }

  const previous = await readFile(path.join(out, MANIFEST_FILE), 'utf8')
    .then((text) => JSON.parse(text) as { inputs?: Input[] })
    .catch(() => null);
  const inputs: Input[] = [];
  const fetchInput = async (repo: Repo, file: string) => {
    const commit = commits[repo];
    const url = rawUrl(repo, commit, file);
    const cached = await fetchCached(url, CACHE_DIR);
    // A file at a commit never changes: a different hash means a broken cache or a tampered mirror.
    const before = previous?.inputs?.find((entry) => entry.url === url);
    if (before && before.sha256 !== cached.sha256) throw new Error(`${url}: SHA-256 ${cached.sha256} differs from the manifest's ${before.sha256}`);
    inputs.push({ repo, commit, file, url, bytes: cached.bytes, sha256: cached.sha256 });
    return cached.path;
  };

  // --- Natural Earth -------------------------------------------------------------
  const ne = 'nvkelso/natural-earth-vector';
  const land = [...(await readCollection(await fetchInput(ne, NE_FILES.land))), ...(await readCollection(await fetchInput(ne, NE_FILES.minorIslands)))];
  const lakes = [...(await readCollection(await fetchInput(ne, NE_FILES.lakes))), ...(await readCollection(await fetchInput(ne, NE_FILES.lakesNorthAmerica)))];
  const urban = await readCollection(await fetchInput(ne, NE_FILES.urban));
  const placesSource = await readCollection(await fetchInput(ne, NE_FILES.places));

  const features: ReturnType<typeof feature>[] = [];
  features.push(...polygonFeatures('land', land));
  features.push(...polygonFeatures('water', lakes, (p) => (typeof p['name'] === 'string' ? { name: p['name'] } : {})));
  features.push(...polygonFeatures('urban', urban));

  const places = placesSource
    .filter((f) => f.geometry?.type === 'Point')
    .map((f) => ({ props: f.properties ?? {}, at: f.geometry?.coordinates as Position }))
    .filter(({ at }) => inBox(at[0], at[1], BOX))
    // Biggest first, so MapLibre's collision keeps the important labels.
    .sort((a, b) => Number(b.props['pop_max']) - Number(a.props['pop_max']) || String(a.props['name']).localeCompare(String(b.props['name'])));
  for (const { props, at } of places) {
    features.push(feature('place', { name: String(props['name']), rank: Number(props['scalerank']), minZoom: Number(props['min_zoom']) }, { type: 'Point', coordinates: [roundTo(at[0], DECIMALS), roundTo(at[1], DECIMALS)] }));
  }

  // --- OurAirports ---------------------------------------------------------------
  const oa = 'davidmegginson/ourairports-data';
  const airports = csvRecords(await readFile(await fetchInput(oa, OA_FILES.airports), 'utf8'))
    .filter((a) => AIRPORT_TYPES.has(a['type'] ?? ''))
    .map((a) => ({ record: a, lon: csvNumber(a['longitude_deg']), lat: csvNumber(a['latitude_deg']) }))
    .filter((a): a is { record: Record<string, string>; lon: number; lat: number } => a.lon !== null && a.lat !== null && inBox(a.lon, a.lat, BOX))
    .sort((a, b) => (a.record['type'] === b.record['type'] ? (a.record['ident'] ?? '').localeCompare(b.record['ident'] ?? '') : a.record['type'] === 'large_airport' ? -1 : 1));
  const airportIdents = new Set(airports.map((a) => a.record['ident']));
  const runwayRecords = csvRecords(await readFile(await fetchInput(oa, OA_FILES.runways), 'utf8'))
    .filter((r) => airportIdents.has(r['airport_ident']) && r['closed'] !== '1')
    .sort((a, b) => (a['airport_ident'] ?? '').localeCompare(b['airport_ident'] ?? '') || (a['le_ident'] ?? '').localeCompare(b['le_ident'] ?? '', undefined, { numeric: true }));
  const runwaysWithout: string[] = [];
  const runwayFeatures: ReturnType<typeof feature>[] = [];
  const centrelines: ReturnType<typeof feature>[] = [];
  for (const r of runwayRecords) {
    const le = [csvNumber(r['le_longitude_deg']), csvNumber(r['le_latitude_deg'])];
    const he = [csvNumber(r['he_longitude_deg']), csvNumber(r['he_latitude_deg'])];
    const width = csvNumber(r['width_ft']) ?? 100;
    const name = `${r['le_ident'] ?? ''}/${r['he_ident'] ?? ''}`;
    if (le.some((v) => v === null) || he.some((v) => v === null)) {
      runwaysWithout.push(`${r['airport_ident'] ?? ''} ${name}`);
      continue;
    }
    const a = le as Position;
    const b = he as Position;
    const props = { airport: r['airport_ident'], name, lengthFt: csvNumber(r['length_ft']), widthFt: width, surface: r['surface'] };
    const ring = runwayPolygon(a, b, width, DECIMALS);
    if (ring.length === 0) {
      runwaysWithout.push(`${r['airport_ident'] ?? ''} ${name}`);
      continue;
    }
    runwayFeatures.push(feature('runway', props, { type: 'Polygon', coordinates: [ring] }));
    centrelines.push(
      feature('runway-line', props, {
        type: 'LineString',
        coordinates: [
          [roundTo(a[0], DECIMALS), roundTo(a[1], DECIMALS)],
          [roundTo(b[0], DECIMALS), roundTo(b[1], DECIMALS)],
        ],
      }),
    );
  }
  features.push(...runwayFeatures, ...centrelines);
  for (const { record, lon, lat } of airports) {
    features.push(
      feature(
        'airport',
        { ident: record['ident'], iata: record['iata_code'] || null, name: record['name'], kind: record['type'] === 'large_airport' ? 'large' : 'medium' },
        { type: 'Point', coordinates: [roundTo(lon, DECIMALS), roundTo(lat, DECIMALS)] },
      ),
    );
  }

  // --- Glyphs ----------------------------------------------------------------------
  const labels = [
    ...places.map((p) => String(p.props['name'])),
    ...airports.flatMap((a) => [a.record['name'] ?? '', a.record['iata_code'] ?? '', a.record['ident'] ?? '']),
  ];
  const ranges = glyphRanges(labels);
  const fontDir = path.join(out, 'fonts', FONT);
  await rm(path.join(out, 'fonts'), { recursive: true, force: true });
  await ensureDir(fontDir);
  const pa = 'protomaps/basemaps-assets';
  const written: { file: string; bytes: number; sha256: string }[] = [];
  const write = async (relative: string, data: string | Uint8Array) => {
    await ensureDir(path.dirname(path.join(out, relative)));
    await writeFile(path.join(out, relative), data);
    written.push({ file: relative, bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength, sha256: sha256(data) });
  };
  for (const range of ranges) {
    const bytes = await readFile(await fetchInput(pa, `fonts/${FONT}/${range}.pbf`));
    await write(`fonts/${FONT}/${range}.pbf`, bytes);
  }
  await write('fonts/OFL.txt', await readFile(await fetchInput(pa, 'fonts/OFL.txt')));

  // --- Outputs ---------------------------------------------------------------------
  const data = featureCollectionJson(features);
  await write(DATA_FILE, data);
  const bounds: [number, number, number, number] = [BOX.west, BOX.south, BOX.east, BOX.north];
  /** What the map component loads (packages/ui/src/map/basemap.ts, `BasemapDescriptor`). */
  const descriptor = {
    version: 1,
    kind: 'geojson',
    data: DATA_FILE,
    bounds,
    glyphs: 'fonts/{fontstack}/{range}.pbf',
    font: FONT,
    credits: CREDITS.map(({ text, url }) => ({ text, url })),
  };
  await write(DESCRIPTOR_FILE, `${JSON.stringify(descriptor, null, 2)}\n`);

  const counts: Record<string, number> = {};
  for (const f of features) counts[f.properties.layer] = (counts[f.properties.layer] ?? 0) + 1;
  const total = written.reduce((sum, file) => sum + file.bytes, 0);
  const manifest = {
    recipe: RECIPE,
    area: { name: 'San Francisco Bay Area', flightsBbox: BAY_AREA_BBOX, marginDeg: MARGIN_DEG, bounds },
    processing: {
      clip: 'Sutherland–Hodgman to the bounds',
      simplify: `Douglas–Peucker, tolerance ${TOLERANCE_DEG}°`,
      decimals: DECIMALS,
      minArea2: MIN_AREA2,
      airports: [...AIRPORT_TYPES],
      runways: 'open runways of those airports, rectangles from both ends and width_ft (100 ft when missing), plus centrelines',
    },
    licences: {
      'nvkelso/natural-earth-vector': 'Public domain (https://www.naturalearthdata.com/about/terms-of-use/)',
      'davidmegginson/ourairports-data': 'Public domain (https://ourairports.com/data/)',
      'protomaps/basemaps-assets': `fonts: SIL Open Font License 1.1 (fonts/OFL.txt); ${FONT} glyphs generated by protomaps with maplibre/font-maker`,
    },
    credits: CREDITS,
    commits,
    inputs,
    counts,
    runwaysWithoutEnds: runwaysWithout,
    glyphRanges: ranges,
    outputs: written.sort((a, b) => a.file.localeCompare(b.file)),
    totalBytes: total,
  };
  await writeFile(path.join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

  log(`features: ${Object.entries(counts).map(([layer, n]) => `${layer} ${n}`).join(', ')}`);
  for (const file of written) log(`  ${file.file.padEnd(40)} ${formatBytes(file.bytes).padStart(9)}  ${file.sha256.slice(0, 12)}`);
  log(`total ${formatBytes(total)} (${total} bytes) in ${path.relative(process.cwd(), out) || '.'}`);
  if (runwaysWithout.length > 0) log(`runways without both ends (left out): ${runwaysWithout.join(', ')}`);
  if (total > SIZE_BUDGET) log(`warning: ${formatBytes(total)} is over the ${formatBytes(SIZE_BUDGET)} budget`);
}

runCli(main);
