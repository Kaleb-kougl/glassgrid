import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

/*
 * First-load JS budget of the web build (docs/technical-design.md,
 * "Performance budgets": < 400 KB gzip, excluding DuckDB-WASM).
 *
 * `pnpm --filter @glassgrid/web size` builds, then this script walks Vite's
 * manifest: a route's first load is the entry chunk, the route's own chunk
 * (main.tsx imports one per route) and every chunk they import statically.
 * Chunks only reached through a dynamic import() (the other route, lazy
 * pieces) do not count, nor do DuckDB-WASM assets (any file whose name
 * mentions duckdb: the .wasm binaries and their workers). Sizes are gzip
 * level 9 of the emitted files; kB = 1,000 bytes, as Vite prints them.
 * Exits 1 when `/` is over budget.
 *
 * The engine worker (DuckDB-WASM's JS glue, the engine core) and the .wasm
 * builds are not in the page's import graph at all: the worker fetches them
 * after the page has loaded. They are listed for information, not counted.
 */

const BUDGET_BYTES = 400_000;
/** Each route's chunk(s), as main.tsx imports them. */
const ROUTES: Record<string, readonly string[]> = {
  '/': ['src/app-route.tsx'],
  '/gallery': ['src/gallery/route.tsx'],
};
const BUDGETED_ROUTE = '/';

interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
}

const dist = resolve(import.meta.dirname, '..', 'dist');
const manifest = JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8')) as Record<string, ManifestChunk>;
const entryKey = Object.keys(manifest).find((key) => manifest[key]?.isEntry === true);
if (entryKey === undefined) throw new Error('No entry chunk in dist/.vite/manifest.json: run `vite build` first.');

const isDuckdb = (file: string) => /duckdb/i.test(file);

/** Chunk keys reachable from `roots` through static imports. */
function staticClosure(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Manifest has no chunk ${key}`);
    seen.add(key);
    for (const next of chunk.imports ?? []) visit(next);
  };
  roots.forEach(visit);
  return [...seen];
}

const gzipCache = new Map<string, { raw: number; gzip: number }>();
function sizeOf(file: string): { raw: number; gzip: number } {
  let size = gzipCache.get(file);
  if (!size) {
    const bytes = readFileSync(join(dist, file));
    size = { raw: bytes.byteLength, gzip: gzipSync(bytes, { level: 9 }).byteLength };
    gzipCache.set(file, size);
  }
  return size;
}

const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;

const report: Record<string, { js: { file: string; raw: number; gzip: number }[]; jsGzip: number; cssGzip: number }> = {};
for (const [route, roots] of Object.entries(ROUTES)) {
  const keys = staticClosure([entryKey, ...roots]);
  const js = keys
    .map((key) => (manifest[key] as ManifestChunk).file)
    .filter((file) => file.endsWith('.js') && !isDuckdb(file))
    .map((file) => ({ file, ...sizeOf(file) }))
    .sort((a, b) => b.gzip - a.gzip);
  const css = [...new Set(keys.flatMap((key) => manifest[key]?.css ?? []))];
  report[route] = {
    js,
    jsGzip: js.reduce((sum, chunk) => sum + chunk.gzip, 0),
    cssGzip: css.reduce((sum, file) => sum + sizeOf(file).gzip, 0),
  };
}

for (const [route, { js, jsGzip, cssGzip }] of Object.entries(report)) {
  console.info(`\n${route}: first-load JS ${kB(jsGzip)} gzip (${kB(js.reduce((sum, chunk) => sum + chunk.raw, 0))} raw), CSS ${kB(cssGzip)} gzip`);
  for (const chunk of js) console.info(`  ${chunk.file.padEnd(40)} ${kB(chunk.raw).padStart(10)}  ${kB(chunk.gzip).padStart(9)} gzip`);
}

// The live-flights map: MapLibre and the map component load as one lazy chunk (`loadMapView()` in
// @glassgrid/ui/map), plus its CSS and MapLibre's worker (a same-origin module script). Not first-load.
const counted = new Set(Object.values(report).flatMap(({ js }) => js.map((chunk) => chunk.file)));
const mapKey = Object.keys(manifest).find((key) => manifest[key]?.isDynamicEntry === true && /packages\/ui\/src\/map\/MapView\.tsx$/.test(key));
const mapFiles = new Set<string>();
if (mapKey !== undefined) {
  // Its own chunk and the shared ones only it pulls in: not the entry, not another route (the test page
  // that imports it shares a module with it), not what `/` loads anyway.
  const keys = staticClosure([mapKey]).filter((key) => key === mapKey || (manifest[key]?.isEntry !== true && manifest[key]?.isDynamicEntry !== true));
  const js = keys.map((key) => (manifest[key] as ManifestChunk).file).filter((file) => file.endsWith('.js') && !counted.has(file));
  const css = [...new Set(keys.flatMap((key) => manifest[key]?.css ?? []))];
  const assets = manifest[mapKey]?.assets ?? [];
  const rows = [...js, ...css, ...assets].map((file) => ({ file, ...sizeOf(file) }));
  rows.forEach((row) => mapFiles.add(row.file));
  console.info("\nMap, lazy (loadMapView(): MapLibre and the map component, their CSS, MapLibre's worker; not first-load):");
  for (const row of rows) console.info(`  ${row.file.padEnd(40)} ${kB(row.raw).padStart(10)}  ${kB(row.gzip).padStart(9)} gzip`);
  const jsGzip = rows.filter((row) => js.includes(row.file)).reduce((sum, row) => sum + row.gzip, 0);
  console.info(`  map chunk JS: ${kB(jsGzip)} gzip`);
}

// Loaded by the engine worker, not by the page (`new Worker(...)` and the worker's own imports).
const workerSide = readdirSync(join(dist, 'assets'))
  .map((name) => `assets/${name}`)
  .filter((file) => !mapFiles.has(file))
  .filter((file) => file.endsWith('.wasm') || (file.endsWith('.js') && !counted.has(file) && !Object.values(manifest).some((chunk) => chunk.file === file)))
  .map((file) => ({ file, ...sizeOf(file) }))
  .sort((a, b) => b.raw - a.raw);
if (workerSide.length > 0) {
  console.info('\nEngine worker side (fetched by the worker once the engine starts: on a sample link, or on the first intent to open data; not first-load):');
  for (const asset of workerSide) console.info(`  ${asset.file.padEnd(40)} ${kB(asset.raw).padStart(10)}  ${kB(asset.gzip).padStart(9)} gzip`);
}

const budgeted = report[BUDGETED_ROUTE]?.jsGzip ?? 0;
const verdict = budgeted <= BUDGET_BYTES ? 'within' : 'OVER';
console.info(`\nBudget (${BUDGETED_ROUTE}, JS, excluding DuckDB-WASM): ${kB(budgeted)} of ${kB(BUDGET_BYTES)} gzip, ${verdict} budget.`);
if (budgeted > BUDGET_BYTES) process.exitCode = 1;
