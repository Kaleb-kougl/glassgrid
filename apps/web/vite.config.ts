import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { WEB_CSP } from './csp';
import { HOSTING_MANIFEST_FILE, hostingManifest, parseBase, parseVersion } from './hosting';

/*
 * The web shell's build. The production Content Security Policy is sent as
 * a header by the host (vercel.json, generated from ./csp.ts and checked by
 * csp.test.ts) and also carried as a <meta> in the built index.html, so a
 * host without our headers still enforces it on the page. The dev server
 * runs without it (its injected <style> elements and React Refresh need
 * inline code). See docs/m4-web-demo.md, "Headers and CSP".
 */
export { WEB_CSP };

function cspForBuild(): Plugin {
  return {
    name: 'glassgrid:csp-meta',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: WEB_CSP }, injectTo: 'head-prepend' }],
  };
}

/**
 * Writes dist/glassgrid-hosting.json: the headers and rewrites a Next.js
 * site needs to serve this build under its base (hosting.ts, the same rules
 * as vercel.json). The release workflow ships it inside the tarball.
 */
function hostingManifestForBuild(base: string, version: string): Plugin {
  return {
    name: 'glassgrid:hosting-manifest',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: HOSTING_MANIFEST_FILE, source: `${JSON.stringify(hostingManifest({ base, version }), null, 2)}\n` });
    },
  };
}

/**
 * `GLASSGRID_BASE`: the path the build is served under, `/` (default) or a
 * subfolder such as `/glassgrid/` (both slashes required). Every URL the
 * app builds goes through `import.meta.env.BASE_URL` (src/base.ts).
 * `GLASSGRID_VERSION`: the release version for the hosting manifest
 * (default: this package's version).
 */
const base = parseBase(process.env['GLASSGRID_BASE']);
const version = parseVersion(process.env['GLASSGRID_VERSION'] || (JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')) as { version: string }).version);

/**
 * `GLASSGRID_RENDER_PERF=1` compiles in the shared app's render-perf
 * instrumentation (as in the desktop build): React's profiling build, no
 * minification. Off by default: `__GG_RENDER_PERF__` is `false` and every
 * instrumented branch is dropped.
 */
const renderPerf = process.env['GLASSGRID_RENDER_PERF'] === '1';

export default defineConfig({
  base,
  plugins: [react(), cspForBuild(), hostingManifestForBuild(base, version)],
  define: { __GG_RENDER_PERF__: JSON.stringify(renderPerf) },
  resolve: {
    // DuckDB-WASM imports apache-arrow ^17 for helpers the engine never calls; one copy (21, the app's) is enough.
    dedupe: ['apache-arrow'],
    ...(renderPerf ? { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] } : {}),
  },
  // The engine worker (packages/engine/src/worker/engine-worker.ts) is an ES module worker.
  worker: { format: 'es' },
  build: {
    ...(renderPerf ? { minify: false } : {}),
    // The bundle-size check (scripts/size.ts) walks the manifest from index.html.
    manifest: true,
    // The shared chunk (React, Arrow, zod, core, ui) is ~630 kB raw / ~190 kB gzip; the budget that
    // matters is first-load gzip, checked by `pnpm size`. The worker's chunk (DuckDB-WASM's JS glue) is ~1.6 MB.
    chunkSizeWarningLimit: 2048,
    // `font-src 'self'`: fonts ship as files, never as data: URIs; DuckDB-WASM's .wasm builds stay files
    // (streaming compilation; ~34 MB each, never inlined).
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf|wasm)$/.test(file) ? false : undefined),
  },
  preview: { port: 4173, strictPort: true },
});
