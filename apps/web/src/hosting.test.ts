import { pathToRegexp } from 'path-to-regexp';
import { describe, expect, it } from 'vitest';
import vercel from '../vercel.json';
import { HEADER_RULES, hostingManifest, nextSource, parseBase, parseVersion, vercelConfig, vercelSource, type HostingManifest } from '../hosting';

/*
 * hosting.ts is the one source of the demo's headers and rewrites. These
 * checks keep vercel.json generated from it, and hold the Next.js manifest
 * (dist/glassgrid-hosting.json) to the same header set under its base.
 *
 * Next.js compiles `headers()` and `rewrites()` sources with its bundled
 * path-to-regexp 6 (next/dist/compiled/path-to-regexp; Next 16.2's copy
 * produces the same regular expressions as path-to-regexp 6.3.0 for every
 * source here) and these options (next/dist/lib/build-custom-route.js and
 * server/lib/router-utils/filesystem.js), then matches the request's
 * pathname before any rewrite.
 */
const NEXT_OPTIONS = { strict: true, sensitive: false, delimiter: '/' };

type Rule = { source: string; headers: readonly { key: string; value: string }[] };

/** vercel.json's `source` subset (literal paths, `(.*)`, `\\.`), as e2e/serve.ts reads it. */
function vercelMatcher(source: string): RegExp {
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

function headersFor(rules: readonly Rule[], path: string, compile: (source: string) => RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) {
    if (compile(rule.source).test(path)) for (const { key, value } of rule.headers) out[key.toLowerCase()] = value;
  }
  return out;
}

const nextMatcher = (source: string) => pathToRegexp(source, [], NEXT_OPTIONS);
const manifest: HostingManifest = hostingManifest({ base: '/glassgrid/', version: '0.1.0' });

/** Paths the build serves (relative to the base) and the app's routes. */
const PATHS = [
  '',
  'index.html',
  'gallery',
  'glassgrid-hosting.json',
  'assets/index-AbCd1234.js',
  'assets/engine-worker-x1y2z3.js',
  'assets/app-route-Q9.css',
  'assets/ibm-plex-sans-latin-400-normal-abc.woff2',
  'assets/duckdb-eh-9ubY-jlA.wasm',
  'assets/duckdb-mvp-77aa.wasm',
  'duckdb-extensions/README.md',
  'duckdb-extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm',
  'duckdb-extensions/v1.4.3/wasm_mvp/parquet.duckdb_extension.wasm',
  'samples/taxi.glassgrid',
  'samples/taxi-trips-2025h1.parquet',
  'samples/samples.manifest.json',
];

describe('vercel.json', () => {
  it('is generated from hosting.ts (run `pnpm --filter @glassgrid/web hosting` after changing it)', () => {
    expect(vercel).toEqual(JSON.parse(JSON.stringify(vercelConfig())));
  });

  it('keeps vercel.json’s source syntax', () => {
    expect(HEADER_RULES.map((rule) => vercelSource(rule.match))).toEqual(['/(.*)', '/assets/(.*)', '/duckdb-extensions/(.*)', '/samples/(.*)\\.parquet', '/samples/(.*)\\.glassgrid', '/(.*)\\.wasm']);
  });
});

describe('glassgrid-hosting.json (Next.js)', () => {
  it('names the build, its version and base', () => {
    expect(manifest).toMatchObject({ name: 'glassgrid-web', version: '0.1.0', base: '/glassgrid/' });
  });

  it('writes header sources in Next.js syntax, every one under the base', () => {
    expect(manifest.headers.map((rule) => rule.source)).toEqual([
      '/glassgrid/:path*',
      '/glassgrid/assets/:path*',
      '/glassgrid/duckdb-extensions/:path*',
      '/glassgrid/samples/:file(.*\\.parquet)',
      '/glassgrid/samples/:file(.*\\.glassgrid)',
      '/glassgrid/:file(.*\\.wasm)',
    ]);
    // Each compiles as Next.js compiles it (a pattern Next rejects throws here too: capturing groups, unbalanced, "*" with no prefix).
    for (const rule of manifest.headers) expect(() => nextMatcher(rule.source)).not.toThrow();
  });

  it('sends the same headers at /glassgrid/<path> as vercel.json does at /<path>, for every file the build serves', () => {
    for (const path of PATHS) {
      const atRoot = headersFor(vercel.headers, `/${path}`, vercelMatcher);
      const underBase = headersFor(manifest.headers, path === '' ? '/glassgrid' : `/glassgrid/${path}`, nextMatcher);
      expect({ path, headers: underBase }).toEqual({ path, headers: atRoot });
    }
    // The same rule list, in the same order (later rules win for the same key on both hosts).
    expect(manifest.headers.map((rule) => rule.headers)).toEqual(vercel.headers.map((rule) => rule.headers));
  });

  it('gives the page, the worker’s script and the data their headers; nothing outside the base', () => {
    const at = (path: string) => headersFor(manifest.headers, path, nextMatcher);
    for (const path of ['/glassgrid', '/glassgrid/index.html', '/glassgrid/gallery', '/glassgrid/assets/engine-worker-abc.js']) {
      expect(at(path)['content-security-policy']).toContain("script-src 'self' 'wasm-unsafe-eval'");
      expect(at(path)['cross-origin-opener-policy']).toBe('same-origin');
    }
    const immutable = 'public, max-age=31536000, immutable';
    expect(at('/glassgrid/assets/duckdb-eh-1.wasm')).toMatchObject({ 'content-type': 'application/wasm', 'cache-control': immutable });
    expect(at('/glassgrid/duckdb-extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm')).toMatchObject({ 'content-type': 'application/wasm', 'cache-control': immutable });
    expect(at('/glassgrid/samples/taxi-trips-2025h1.parquet')).toMatchObject({ 'content-type': 'application/vnd.apache.parquet', 'cache-control': immutable });
    expect(at('/glassgrid/samples/taxi.glassgrid')).toMatchObject({
      'content-type': 'application/vnd.glassgrid.workspace+json; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
    });
    expect(at('/glassgrid')['cache-control']).toBe('public, max-age=0, must-revalidate');
    // The rest of the portfolio is untouched, including look-alike paths.
    for (const path of ['/', '/about', '/glassgridx', '/glassgrid-other/a.wasm', '/assets/a.js', '/samples/taxi-trips-2025h1.parquet', '/x.wasm']) expect(at(path)).toEqual({});
    // Next.js (trailingSlash: false, the default) answers /glassgrid/ with a 308 to /glassgrid before matching
    // headers, so the page is only ever served at /glassgrid, which the general rule covers.
    expect(nextMatcher('/glassgrid/:path*').test('/glassgrid/')).toBe(false);
  });

  it('rewrites the base and the app routes to index.html (Next.js serves public/glassgrid/index.html only at its own path)', () => {
    expect(manifest.rewrites).toEqual([
      { source: '/glassgrid', destination: '/glassgrid/index.html' },
      { source: '/glassgrid/', destination: '/glassgrid/index.html' },
      { source: '/glassgrid/gallery', destination: '/glassgrid/index.html' },
      { source: '/glassgrid/gallery/', destination: '/glassgrid/index.html' },
    ]);
    for (const rewrite of manifest.rewrites) expect(nextMatcher(rewrite.source).test(rewrite.source)).toBe(true);
  });

  it('works for a root or a nested base too', () => {
    expect(hostingManifest({ base: '/', version: '1.2.3' }).headers.map((rule) => rule.source)).toEqual([
      '/:path*',
      '/assets/:path*',
      '/duckdb-extensions/:path*',
      '/samples/:file(.*\\.parquet)',
      '/samples/:file(.*\\.glassgrid)',
      '/:file(.*\\.wasm)',
    ]);
    expect(nextSource({ kind: 'folder', folder: 'assets' }, '/projects/glassgrid/')).toBe('/projects/glassgrid/assets/:path*');
    expect(nextMatcher(nextSource({ kind: 'everything' }, '/projects/glassgrid/')).test('/projects/glassgrid')).toBe(true);
  });
});

describe('build inputs', () => {
  it('accepts / or a /path/ base, and nothing else', () => {
    expect(parseBase(undefined)).toBe('/');
    expect(parseBase('')).toBe('/');
    expect(parseBase('/')).toBe('/');
    expect(parseBase('/glassgrid/')).toBe('/glassgrid/');
    expect(parseBase('/a/b-c_d.e~f/')).toBe('/a/b-c_d.e~f/');
    for (const bad of ['glassgrid', '/glassgrid', 'glassgrid/', './', '//', '/a//b/', '/../', '/a b/', '/:path/', 'https://x.test/glassgrid/', '/a?b/']) {
      expect(() => parseBase(bad), bad).toThrow(/GLASSGRID_BASE/);
    }
  });

  it('accepts X.Y.Z versions with an optional pre-release', () => {
    expect(parseVersion('0.1.0')).toBe('0.1.0');
    expect(parseVersion('1.20.3-rc.1')).toBe('1.20.3-rc.1');
    for (const bad of ['v0.1.0', '0.1', '0.1.0 ', 'latest', '']) expect(() => parseVersion(bad), bad).toThrow(/release version/);
  });
});
