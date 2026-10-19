import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
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
