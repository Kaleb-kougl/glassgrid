import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * The renderer ships a strict CSP (see src/renderer/index.html). Vite's dev
 * server injects CSS through <style> elements, which `style-src 'self'`
 * blocks, so the policy is relaxed for `electron-vite dev` only. Production
 * builds keep the policy exactly as written.
 */
function relaxCspForDevServer(): Plugin {
  return {
    name: 'glassgrid:relax-csp-for-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");
    },
  };
}

/**
 * `GLASSGRID_RENDER_PERF=1` at build time compiles in the renderer's
 * performance instrumentation (src/renderer/src/render-perf.ts: phase marks,
 * React Profiler regions, a commit inspector) for `pnpm e2e:render`. It also
 * swaps in React's profiling build (Profiler timings work in production
 * only there) and leaves the bundle unminified so CPU profiles and
 * component names are readable. Off by default: `__GG_RENDER_PERF__` is
 * `false`, every instrumented branch is dead code and the bundle is the
 * shipping one.
 */
const renderPerf = process.env['GLASSGRID_RENDER_PERF'] === '1';

export default defineConfig({
  main: {
    build: {
      // Only `dependencies` (i.e. @duckdb/node-api) stay external; workspace
      // packages, zod and apache-arrow are devDependencies and get bundled.
      externalizeDeps: true,
      rolldownOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // Entry for the Electron utility process that hosts DuckDB.
          engine: resolve(import.meta.dirname, 'src/engine/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads cannot `require` arbitrary modules: bundle everything.
      externalizeDeps: false,
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react(), relaxCspForDevServer()],
    define: { __GG_RENDER_PERF__: JSON.stringify(renderPerf) },
    ...(renderPerf ? { resolve: { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] } } : {}),
    build: {
      ...(renderPerf ? { minify: false } : {}),
      // The CSP is `font-src 'self'`: fonts must ship as files, never as data: URIs.
      assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') },
      },
    },
  },
});
