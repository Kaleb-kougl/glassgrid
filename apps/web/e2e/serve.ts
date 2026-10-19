import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

/*
 * A static server for dist/ that behaves like the production host: it reads
 * vercel.json and applies its `rewrites` and `headers` (CSP, caching,
 * content types) to every response, and answers HEAD and Range requests
 * with Content-Length, Last-Modified and ETag as Vercel's CDN does
 * (DuckDB-WASM reads the sample Parquet files with range requests). The
 * Playwright tests run against it, so the header CSP that reaches the
 * engine worker is the one production sends.
 *
 *   node e2e/serve.ts [port]
 *
 * `source` patterns use the path-to-regexp subset vercel.json uses here:
 * literal paths, `(.*)` groups and `\\.` escapes.
 */

interface Rule {
  source: string;
  destination?: string;
  headers?: { key: string; value: string }[];
}

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const config = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as { rewrites?: Rule[]; headers?: Rule[] };
const port = Number(process.argv[2] ?? process.env['PORT'] ?? 4173);

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
const rewrites = (config.rewrites ?? []).map((rule) => ({ ...rule, regex: matcher(rule.source) }));
const headerRules = (config.headers ?? []).map((rule) => ({ ...rule, regex: matcher(rule.source) }));

function fileFor(pathname: string): string | null {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const candidate = join(dist, relative === '' ? 'index.html' : relative);
  if (!candidate.startsWith(dist + sep) && candidate !== dist) return null;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  const index = join(candidate, 'index.html');
  return existsSync(index) && statSync(index).isFile() ? index : null;
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
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
}).listen(port, '127.0.0.1', () => console.info(`[serve] dist/ with vercel.json headers on http://127.0.0.1:${port}`));
