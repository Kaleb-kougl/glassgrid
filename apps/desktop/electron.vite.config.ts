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
    build: {
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') },
      },
    },
  },
});
