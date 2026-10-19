import { WEB_CSP_HEADER } from './csp.ts';

/*
 * The web demo's hosting contract, in one place: the response headers and
 * the SPA rewrites every host must apply. Two outputs come from it:
 *
 * - apps/web/vercel.json, for a standalone deploy at a domain root (and the
 *   root E2E, which serves dist/ with it). `pnpm --filter @glassgrid/web
 *   hosting` rewrites it; src/hosting.test.ts fails when it is out of date.
 * - dist/glassgrid-hosting.json, written by `vite build` (vite.config.ts),
 *   for a Next.js site that serves the build as a static subfolder (the
 *   portfolio, at /glassgrid/). Its `headers` and `rewrites` are Next.js
 *   `headers()` / `rewrites()` entries with the base path in every source.
 *
 * Rules run from general to specific: when several match a path, the later
 * one wins for the same header (Vercel and Next.js both behave this way).
 * Everything here is pure data, so the page bundle's tests can import it.
 */

export interface HostingHeader {
  readonly key: string;
  readonly value: string;
}

/** What a rule applies to, relative to the base path. */
export type HostingMatch =
  /** Every path under the base, the base itself included. */
  | { readonly kind: 'everything' }
  /** Every path under `<base><folder>/`. */
  | { readonly kind: 'folder'; readonly folder: string }
  /** Files ending in `.<extension>`, anywhere under the base or under `<base><folder>/`. */
  | { readonly kind: 'extension'; readonly extension: string; readonly folder?: string };

export interface HostingRule {
  readonly match: HostingMatch;
  readonly headers: readonly HostingHeader[];
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Every response header the demo depends on. See docs/m4-web-demo.md, "Headers and CSP". */
export const HEADER_RULES: readonly HostingRule[] = [
  {
    match: { kind: 'everything' },
    headers: [
      { key: 'Content-Security-Policy', value: WEB_CSP_HEADER },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
      { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
    ],
  },
  // Content-hashed file names.
  { match: { kind: 'folder', folder: 'assets' }, headers: [{ key: 'Cache-Control', value: IMMUTABLE }] },
  // A versioned path (duckdb-extensions/v1.4.3/…).
  { match: { kind: 'folder', folder: 'duckdb-extensions' }, headers: [{ key: 'Cache-Control', value: IMMUTABLE }] },
  // A sample's bytes never change under the same name.
  {
    match: { kind: 'extension', folder: 'samples', extension: 'parquet' },
    headers: [
      { key: 'Cache-Control', value: IMMUTABLE },
      { key: 'Content-Type', value: 'application/vnd.apache.parquet' },
    ],
  },
  {
    match: { kind: 'extension', folder: 'samples', extension: 'glassgrid' },
    headers: [{ key: 'Content-Type', value: 'application/vnd.glassgrid.workspace+json; charset=utf-8' }],
  },
  { match: { kind: 'extension', extension: 'wasm' }, headers: [{ key: 'Content-Type', value: 'application/wasm' }] },
];

/** App routes other than the base itself that must serve index.html (main.tsx reads the path). */
export const SPA_ROUTES: readonly string[] = ['gallery'];

/** The default base path: the domain root. */
export const ROOT_BASE = '/';

/**
 * A base path as Vite's `base` takes it: `/`, or `/segment/…/` with both
 * slashes and only URL-safe characters (letters, digits, `-`, `_`, `.`, `~`).
 * Empty or missing means `/`. Throws on anything else.
 */
export function parseBase(value: string | undefined): string {
  if (value === undefined || value === '') return ROOT_BASE;
  if (!value.startsWith('/') || !value.endsWith('/')) throw new Error(`GLASSGRID_BASE must start and end with "/" (got "${value}")`);
  if (value === ROOT_BASE) return value;
  const segments = value.slice(1, -1).split('/');
  for (const segment of segments) {
    if (!/^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/.test(segment) || segment === '.' || segment === '..') {
      throw new Error(`GLASSGRID_BASE has an invalid segment "${segment}" (got "${value}"; use letters, digits, "-", "_", ".", "~")`);
    }
  }
  return value;
}

/** A release version: `X.Y.Z` with an optional pre-release (`0.1.0`, `0.2.0-rc.1`). Throws on anything else. */
export function parseVersion(value: string): string {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value)) throw new Error(`Not a release version: "${value}" (expected X.Y.Z or X.Y.Z-pre)`);
  return value;
}

// --- vercel.json ---------------------------------------------------------------

/** A rule's `source` in vercel.json's syntax, at the domain root. */
export function vercelSource(match: HostingMatch): string {
  switch (match.kind) {
    case 'everything':
      return '/(.*)';
    case 'folder':
      return `/${match.folder}/(.*)`;
    case 'extension':
      return `/${match.folder === undefined ? '' : `${match.folder}/`}(.*)\\.${match.extension}`;
  }
}

/** The whole of apps/web/vercel.json (a standalone Vercel project with Root Directory apps/web). */
export function vercelConfig() {
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: null,
    installCommand: 'pnpm install --frozen-lockfile --filter @glassgrid/web...',
    buildCommand: 'pnpm --filter @glassgrid/web build',
    outputDirectory: 'dist',
    rewrites: SPA_ROUTES.flatMap((route) => [
      { source: `/${route}`, destination: '/index.html' },
      { source: `/${route}/`, destination: '/index.html' },
    ]),
    headers: HEADER_RULES.map((rule) => ({ source: vercelSource(rule.match), headers: rule.headers.map(({ key, value }) => ({ key, value })) })),
  };
}

// --- glassgrid-hosting.json (Next.js) ------------------------------------------

/** The file name of the hosting manifest in dist/. */
export const HOSTING_MANIFEST_FILE = 'glassgrid-hosting.json';

export interface HostingManifest {
  readonly name: 'glassgrid-web';
  readonly version: string;
  /** Where the build must be served (the `base` it was built with): every URL in it starts with this. */
  readonly base: string;
  /** Next.js `headers()` entries, general to specific (later entries win for the same key). */
  readonly headers: readonly { source: string; headers: readonly HostingHeader[] }[];
  /** Next.js `rewrites()` entries: the app's routes to index.html. */
  readonly rewrites: readonly { source: string; destination: string }[];
}

/**
 * A rule's `source` in Next.js syntax (path-to-regexp 6, compiled by Next
 * with `strict: true, sensitive: false, delimiter: '/'`), under `base`:
 *
 * - everything: `/glassgrid/:path*` (matches `/glassgrid` itself too);
 * - a folder: `/glassgrid/assets/:path*`;
 * - an extension: `/glassgrid/:file(.*\\.wasm)`. `/glassgrid/:path*.wasm`
 *   would not compile to what it reads as, so the extension sits inside the
 *   parameter's own pattern.
 */
export function nextSource(match: HostingMatch, base: string): string {
  const prefix = parseBase(base);
  switch (match.kind) {
    case 'everything':
      return `${prefix.slice(0, -1)}/:path*`;
    case 'folder':
      return `${prefix}${match.folder}/:path*`;
    case 'extension':
      return `${prefix}${match.folder === undefined ? '' : `${match.folder}/`}:file(.*\\.${match.extension})`;
  }
}

/**
 * Next.js rewrites to index.html for the base (with and without its
 * trailing slash) and each app route. Next.js serves
 * `public/glassgrid/index.html` at `/glassgrid/index.html` only. With the
 * default `trailingSlash: false` it also redirects `/glassgrid/` to
 * `/glassgrid` before rewrites run; the rule for `/glassgrid/` covers a site
 * that sets `trailingSlash: true`.
 */
export function nextRewrites(base: string): { source: string; destination: string }[] {
  const prefix = parseBase(base);
  const destination = `${prefix}index.html`;
  const sources = [
    ...(prefix === ROOT_BASE ? [] : [prefix.slice(0, -1), prefix]),
    ...SPA_ROUTES.flatMap((route) => [`${prefix}${route}`, `${prefix}${route}/`]),
  ];
  return sources.map((source) => ({ source, destination }));
}

export function hostingManifest(options: { base: string; version: string }): HostingManifest {
  const base = parseBase(options.base);
  return {
    name: 'glassgrid-web',
    version: parseVersion(options.version),
    base,
    headers: HEADER_RULES.map((rule) => ({ source: nextSource(rule.match, base), headers: rule.headers.map(({ key, value }) => ({ key, value })) })),
    rewrites: nextRewrites(base),
  };
}
