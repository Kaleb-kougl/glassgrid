import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

/*
 * A static server for the engine's browser test page: e2e/.out (the Vite
 * build), e2e/.samples (generated datasets) and /duckdb-extensions/ (the
 * signed Parquet extension the web demo serves, from apps/web/public), with HEAD, Range requests
 * and Last-Modified, as DuckDB-WASM's HTTP file system and the browser
 * fingerprint need. `GLASSGRID_COI=1` adds the cross-origin isolation
 * headers (COOP/COEP) to check what changes with them.
 *
 * For the live-flights case it also serves the committed flight fixtures
 * (/samples/flights/, from apps/web/public) and a stand-in for the
 * portfolio's `GET /api/flights`: two aircraft around a fixed position, in
 * the endpoint's contract (docs/live-flights-l2.md), with its
 * Cache-Control header.
 *
 *   node e2e/serve.ts [port]
 */
const port = Number(process.argv[2] ?? process.env['PORT'] ?? 4179);
const roots = [resolve(import.meta.dirname, '.out'), resolve(import.meta.dirname, '.samples')];
/** The web demo's public folder, for /duckdb-extensions/ only. */
const webPublic = resolve(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'public');
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.csv': 'text/csv; charset=utf-8',
  '.parquet': 'application/vnd.apache.parquet',
  '.json': 'application/json',
};
const isolated = process.env['GLASSGRID_COI'] === '1';

/** The endpoint's body: `now` in ms, `seen_pos` in s (a fix 0.8 s and 2.4 s old). */
function flightsBody(): string {
  const now = Date.now();
  return JSON.stringify({
    now,
    fetchedAt: now,
    stale: false,
    source: 'adsb.lol',
    attribution: 'Data © adsb.lol contributors, licensed under the Open Database License (ODbL) 1.0',
    license: 'ODbL-1.0',
    ac: [
      { hex: 'a1b2c3', flight: 'UAL123  ', lat: 37.61892, lon: -122.37512, alt_baro: 2_975, gs: 151.2, track: 280.3, seen_pos: 0.8, category: 'A3', type: 'adsb_icao' },
      { hex: 'abc123', flight: 'SWA2', lat: 37.7213, lon: -122.2208, alt_baro: 'ground', seen_pos: 2.4, type: 'adsb_icao' },
    ],
  });
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/flights') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=20' }).end(flightsBody());
    return;
  }
  const relative = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)).replace(/^([/\\])+/, '');
  const searched = relative.startsWith(`duckdb-extensions${sep}`) || relative.startsWith(`samples${sep}flights${sep}`) ? [webPublic] : roots;
  const file = searched.flatMap((root) => {
    const candidate = join(root, relative);
    return candidate.startsWith(root + sep) && existsSync(candidate) && statSync(candidate).isFile() ? [candidate] : [];
  })[0];
  if (!file) {
    response.writeHead(404).end('not found');
    return;
  }
  const info = statSync(file);
  const headers: Record<string, string> = {
    'Content-Type': types[extname(file)] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Last-Modified': info.mtime.toUTCString(),
    'Cache-Control': 'no-cache',
    ...(isolated ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } : {}),
  };
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start >= info.size || end < start) {
      response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
      return;
    }
    response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': String(end - start + 1) });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': String(info.size) });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => console.info(`[serve] http://127.0.0.1:${port}`));
