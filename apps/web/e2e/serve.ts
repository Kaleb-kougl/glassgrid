import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToRegexp } from 'path-to-regexp';
import { HOSTING_MANIFEST_FILE, parseBase, type HostingManifest } from '../hosting.ts';

/*
 * A static server for dist/ that behaves like the production host, so the
 * Playwright tests see what production sends (the header CSP that reaches
 * the engine worker included). It answers HEAD and Range requests with
 * Content-Length, Last-Modified and ETag, as Vercel's CDN does (DuckDB-WASM
 * reads the sample Parquet files with range requests).
 *
 *   node e2e/serve.ts [port]                            # a root build, as a standalone Vercel project
 *   GLASSGRID_BASE=/glassgrid/ node e2e/serve.ts [port] # a subfolder build, as the portfolio's Next.js site
 *
 * - At `/` it reads vercel.json and applies its `rewrites` and `headers`
 *   (the path-to-regexp subset vercel.json uses here: literal paths, `(.*)`
 *   groups and `\\.` escapes). A directory serves its index.html.
 * - Under a base it reads dist/glassgrid-hosting.json, the manifest the
 *   portfolio's next.config applies, compiles its sources as Next.js does
 *   (path-to-regexp 6, strict, case-insensitive), and behaves like Next.js
 *   serving dist/ from public<base>: files only at their own path (no
 *   directory index), `/a/` redirected to `/a` with a 308 (the default
 *   `trailingSlash: false`), then the rewrites, and 404 for everything
 *   outside the base (a URL the build forgot to put under its base fails
 *   the tests).
 */

/*
 * GLASSGRID_E2E_RELAY=1 adds a scriptable stand-in for the portfolio's live
 * relay (`GET /api/flights`, at the site root whatever the base, as in
 * production; docs/flights-proxy.md in the portfolio) for the live-flights
 * E2E (flights-live.spec.ts). The tests set what it answers with
 * `POST /__e2e/relay {"mode": ...}`:
 *
 * - `none` (the default): 404, as a host without the relay;
 * - `ok`: 200, 40 synthetic aircraft over the Bay Area at the current time,
 *   cached like the relay (`s-maxage=10`);
 * - `stale`: 200 with `stale: true` and a snapshot two minutes old;
 * - `fail`: 503 with `Retry-After: 10` and `reason: network ENOTFOUND`;
 * - `429`: 429 with `Retry-After: <retryAfter>` (default 120).
 *
 * `{"fixtures": "fail"}` makes the flight fixtures (`…/samples/flights/*.parquet`)
 * answer 503 until `{"fixtures": "ok"}` (the recording that cannot be
 * fetched ahead, L5's offline case).
 *
 * `GET /__e2e/relay` returns the mode and how many relay requests it saw.
 * Without the variable neither path exists (404).
 */
type RelayMode = 'none' | 'ok' | 'stale' | 'fail' | '429';
const relay = { enabled: process.env['GLASSGRID_E2E_RELAY'] === '1', mode: 'none' as RelayMode, retryAfter: 120, requests: 0, failFixtures: false, fixtureRequests: 0 };

function relayAircraft(nowMs: number): object[] {
  const out: object[] = [];
  for (let i = 0; i < 40; i += 1) {
    // Deterministic: each aircraft circles its own point inside the Bay Area box (37.0–38.5°N, 123.0–121.5°W), so all 40 always count.
    const gs = 140 + ((i * 13) % 330);
    const angle = (nowMs / 1000 / 600) * 2 * Math.PI + i;
    const lat = 37.3 + ((i * 0.031) % 0.9) + 0.05 * Math.sin(angle);
    const lon = -122.8 + ((i * 0.047) % 1.0) + 0.05 * Math.cos(angle);
    const track = Math.round(((((90 - (angle * 180) / Math.PI) % 360) + 360) % 360) * 10) / 10;
    out.push({
      hex: (0xa10000 + i).toString(16),
      flight: `TST${String(100 + i)}`,
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      alt_baro: i % 9 === 0 ? 'ground' : 1_000 + ((i * 937) % 38_000),
      gs,
      track,
      baro_rate: ((i % 5) - 2) * 640,
      category: 'A3',
      t: 'B738',
      r: `N${100 + i}TS`,
      seen: 0.2,
      seen_pos: 0.4,
      type: 'adsb_icao',
    });
  }
  return out;
}

function relayResponse(response: ServerResponse): void {
  relay.requests += 1;
  const now = Date.now();
  const credit = { source: 'adsb.lol', attribution: 'Aircraft data © adsb.lol contributors, ODbL 1.0 (E2E stand-in)', license: 'https://opendatacommons.org/licenses/odbl/1.0/' };
  const json = (status: number, body: object, headers: Record<string, string>) =>
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(body));
  switch (relay.mode) {
    case 'none':
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    case 'ok':
      json(200, { now, fetchedAt: now, stale: false, ...credit, ac: relayAircraft(now) }, { 'cache-control': 'public, s-maxage=10, stale-while-revalidate=20' });
      return;
    case 'stale':
      json(200, { now: now - 120_000, fetchedAt: now - 120_000, stale: true, ...credit, ac: relayAircraft(now - 120_000) }, { 'cache-control': 'public, s-maxage=5', 'x-flights-stale': '1' });
      return;
    case 'fail':
      json(503, { error: 'Live flight data is temporarily unavailable.', reason: 'network ENOTFOUND', retryAfter: 10, ...credit }, { 'cache-control': 'no-store', 'retry-after': '10' });
      return;
    case '429':
      json(429, { error: 'Too many requests' }, { 'cache-control': 'no-store', 'retry-after': String(relay.retryAfter) });
      return;
  }
}

/** The relay stand-in's control endpoint (the tests' only way to steer it). */
function relayControl(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== 'POST') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode: relay.mode, requests: relay.requests, fixtureRequests: relay.fixtureRequests }));
    return;
  }
  let text = '';
  request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
  request.on('end', () => {
    const body = JSON.parse(text || '{}') as { mode?: RelayMode; retryAfter?: number; reset?: boolean; fixtures?: 'ok' | 'fail' };
    if (body.mode) relay.mode = body.mode;
    if (typeof body.retryAfter === 'number') relay.retryAfter = body.retryAfter;
    if (body.fixtures) relay.failFixtures = body.fixtures === 'fail';
    if (body.reset) {
      relay.requests = 0;
      relay.fixtureRequests = 0;
    }
    response.writeHead(204).end();
  });
}

interface Rule {
  source: string;
  destination?: string;
  headers?: readonly { key: string; value: string }[];
}

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const port = Number(process.argv[2] ?? process.env['PORT'] ?? 4173);
const base = parseBase(process.env['GLASSGRID_BASE']);
const next = base !== '/';

function readConfig(): { rewrites?: Rule[]; headers?: Rule[] } {
  if (!next) return JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as { rewrites?: Rule[]; headers?: Rule[] };
  const file = join(dist, HOSTING_MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as HostingManifest;
  if (manifest.base !== base) throw new Error(`${file} is for base ${manifest.base}, not ${base}: rebuild with GLASSGRID_BASE=${base}`);
  return { rewrites: [...manifest.rewrites], headers: [...manifest.headers] };
}
const config = readConfig();

/** Vercel's default content types for what dist/ holds (vercel.json may override them). */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.geojson': 'application/geo+json',
  '.pbf': 'application/octet-stream',
};

function matcher(source: string): RegExp {
  let pattern = '';
  for (let i = 0; i < source.length; i += 1) {
    if (source.startsWith('(.*)', i)) {
      pattern += '(.*)';
      i += 3;
    } else if (source[i] === '\\' && i + 1 < source.length) {
      pattern += `\\${source[i + 1] ?? ''}`;
      i += 1;
    } else {
      pattern += (source[i] ?? '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}
/** As next.config's headers() and rewrites() sources are compiled (next/dist/lib/build-custom-route.js). */
const nextMatcher = (source: string) => pathToRegexp(source, [], { strict: true, sensitive: false, delimiter: '/' });
const compile = next ? nextMatcher : matcher;
const rewrites = (config.rewrites ?? []).map((rule) => ({ ...rule, regex: compile(rule.source) }));
const headerRules = (config.headers ?? []).map((rule) => ({ ...rule, regex: compile(rule.source) }));

function fileFor(pathname: string): string | null {
  let path = decodeURIComponent(pathname);
  if (next) {
    // Next.js serves public<base>… only under the base, and never a directory's index.html by itself.
    if (!path.startsWith(base)) return null;
    path = path.slice(base.length - 1);
  }
  const relative = normalize(path).replace(/^([/\\])+/, '');
  if (next && relative === '') return null;
  const candidate = join(dist, relative === '' ? 'index.html' : relative);
  if (!candidate.startsWith(dist + sep) && candidate !== dist) return null;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  if (next) return null;
  const index = join(candidate, 'index.html');
  return existsSync(index) && statSync(index).isFile() ? index : null;
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (relay.enabled && url.pathname === '/__e2e/relay') {
    relayControl(request, response);
    return;
  }
  if (relay.enabled && url.pathname === '/api/flights') {
    relayResponse(response);
    return;
  }
  if (relay.enabled && /\/samples\/flights\/[^/]+\.parquet$/.test(url.pathname)) {
    relay.fixtureRequests += 1;
    if (relay.failFixtures) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('unavailable (E2E)');
      return;
    }
  }
  if (next && url.pathname !== '/' && url.pathname.endsWith('/')) {
    // Next.js's default trailing-slash redirect, before headers and rewrites.
    response.writeHead(308, { location: `${url.pathname.replace(/\/+$/, '')}${url.search}` }).end();
    return;
  }
  // Files win over rewrites (as on Vercel); a rewrite maps the path to another file.
  let file = fileFor(url.pathname);
  if (!file) {
    const rewrite = rewrites.find((rule) => rule.regex.test(url.pathname));
    if (rewrite?.destination) file = fileFor(rewrite.destination);
  }
  const headers: Record<string, string> = {};
  for (const rule of headerRules) {
    if (rule.regex.test(url.pathname)) for (const { key, value } of rule.headers ?? []) headers[key.toLowerCase()] = value;
  }
  if (!file) {
    response.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  const info = statSync(file);
  const etag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
  Object.assign(headers, {
    'content-type': headers['content-type'] ?? TYPES[extname(file)] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'last-modified': info.mtime.toUTCString(),
    etag,
  });
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, headers).end();
    return;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
  if (range && (range[1] !== '' || range[2] !== '')) {
    const start = range[1] === '' ? Math.max(0, info.size - Number(range[2])) : Number(range[1]);
    const end = range[1] === '' || range[2] === '' ? info.size - 1 : Math.min(Number(range[2]), info.size - 1);
    if (start >= info.size || end < start) {
      response.writeHead(416, { ...headers, 'content-range': `bytes */${info.size}` }).end();
      return;
    }
    response.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': String(end - start + 1) });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, 'content-length': String(info.size) });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () =>
  console.info(next ? `[serve] dist/ at ${base} with ${HOSTING_MANIFEST_FILE} (as Next.js) on http://127.0.0.1:${port}${base}` : `[serve] dist/ with vercel.json headers on http://127.0.0.1:${port}`),
);
