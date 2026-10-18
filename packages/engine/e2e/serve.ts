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

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const relative = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)).replace(/^([/\\])+/, '');
  const searched = relative.startsWith(`duckdb-extensions${sep}`) ? [webPublic] : roots;
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
