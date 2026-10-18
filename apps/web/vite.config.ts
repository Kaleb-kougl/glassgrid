import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * The production Content Security Policy, as a <meta> in the built
 * index.html (the dev server's injected <style> elements and React Refresh
 * need inline code, so `vite dev` runs without it). Same policy as the
 * desktop renderer plus `'wasm-unsafe-eval'` for DuckDB-WASM. Hosting should
 * also send it as a header, with what a <meta> cannot carry
 * (`frame-ancestors`): see docs/m4-app-package.md, "Web build: CSP and headers".
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspForBuild(): Plugin {
  return {
    name: 'glassgrid:csp-meta',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: WEB_CSP }, injectTo: 'head-prepend' }],
  };
}

/**
 * `GLASSGRID_RENDER_PERF=1` compiles in the shared app's render-perf
 * instrumentation (as in the desktop build): React's profiling build, no
 * minification. Off by default: `__GG_RENDER_PERF__` is `false` and every
 * instrumented branch is dropped.
 */
const renderPerf = process.env['GLASSGRID_RENDER_PERF'] === '1';

export default defineConfig({
  plugins: [react(), cspForBuild()],
  define: { __GG_RENDER_PERF__: JSON.stringify(renderPerf) },
  ...(renderPerf ? { resolve: { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] } } : {}),
  build: {
    ...(renderPerf ? { minify: false } : {}),
    // The bundle-size check (scripts/size.ts) walks the manifest from index.html.
    manifest: true,
    // The shared chunk (React, Arrow, zod, core, ui) is ~630 kB raw / ~190 kB gzip; the budget that
    // matters is first-load gzip, checked by `pnpm size`.
    chunkSizeWarningLimit: 800,
    // `font-src 'self'`: fonts ship as files, never as data: URIs.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
  preview: { port: 4173, strictPort: true },
});
