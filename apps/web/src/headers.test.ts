import { describe, expect, it } from 'vitest';
import vercel from '../vercel.json';
import { WEB_CSP, WEB_CSP_HEADER } from '../csp';

/*
 * vercel.json is the production host's configuration: these checks keep its
 * Content-Security-Policy header identical to csp.ts (the <meta> copy in
 * index.html comes from there too) and hold the rest of the hosting
 * contract the demo depends on. The E2E suite serves dist/ with the same
 * file (e2e/serve.ts), so what it tests is what production sends.
 */

type HeaderRule = { source: string; headers: { key: string; value: string }[] };
const rules = vercel.headers as HeaderRule[];

/** vercel.json's `source` syntax as used here (literal paths, `(.*)`, `\\.`), as e2e/serve.ts reads it. */
function matcher(source: string): RegExp {
  let pattern = '';
  for (let i = 0; i < source.length; i += 1) {
    if (source.startsWith('(.*)', i)) {
      pattern += '(.*)';
      i += 3;
    } else if (source[i] === '\\') {
      pattern += `\\${source[i + 1] ?? ''}`;
      i += 1;
    } else {
      pattern += (source[i] ?? '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

function headersFor(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) {
    if (matcher(rule.source).test(path)) for (const { key, value } of rule.headers) out[key.toLowerCase()] = value;
  }
  return out;
}

describe('hosting headers (vercel.json)', () => {
  it('sends csp.ts’s policy as a header on every path, the engine worker’s script included', () => {
    for (const path of ['/', '/index.html', '/gallery', '/assets/engine-worker-abc123.js', '/samples/taxi.glassgrid']) {
      expect(headersFor(path)['content-security-policy']).toBe(WEB_CSP_HEADER);
    }
  });

  it('allows WebAssembly compilation but no JavaScript eval, and only this origin', () => {
    const directives = new Map(WEB_CSP_HEADER.split('; ').map((directive) => [directive.split(' ')[0], directive.split(' ').slice(1)]));
    expect(directives.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(WEB_CSP_HEADER).not.toMatch(/'unsafe-eval'|'unsafe-inline'|\*|https?:/);
    expect(directives.get('connect-src')).toEqual(["'self'"]);
    expect(directives.get('worker-src')).toEqual(["'self'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    // A <meta> policy may not carry frame-ancestors (the browser logs an error); otherwise the same.
    expect(WEB_CSP).not.toContain('frame-ancestors');
    expect(`${WEB_CSP}; frame-ancestors 'none'`).toBe(WEB_CSP_HEADER);
  });

  it('serves WebAssembly as application/wasm and caches hashed assets, the extension and the data for a year', () => {
    expect(headersFor('/assets/duckdb-eh-9ubY-jlA.wasm')['content-type']).toBe('application/wasm');
    expect(headersFor('/duckdb-extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm')['content-type']).toBe('application/wasm');
    const immutable = 'public, max-age=31536000, immutable';
    expect(headersFor('/assets/app-route-x.js')['cache-control']).toBe(immutable);
    expect(headersFor('/duckdb-extensions/v1.4.3/wasm_mvp/parquet.duckdb_extension.wasm')['cache-control']).toBe(immutable);
    expect(headersFor('/samples/taxi-trips-2025h1.parquet')['cache-control']).toBe(immutable);
    // Pages and the workspace files revalidate (their names never change).
    expect(headersFor('/')['cache-control']).toBe('public, max-age=0, must-revalidate');
    expect(headersFor('/samples/taxi.glassgrid')['cache-control']).toBe('public, max-age=0, must-revalidate');
  });

  it('rewrites /gallery to the app shell; builds the web app into dist/', () => {
    expect(vercel.rewrites).toEqual([
      { source: '/gallery', destination: '/index.html' },
      { source: '/gallery/', destination: '/index.html' },
    ]);
    expect(vercel.outputDirectory).toBe('dist');
    expect(vercel.buildCommand).toBe('pnpm --filter @glassgrid/web build');
  });
});
