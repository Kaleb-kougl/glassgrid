import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/*
 * The browser test and bench page for the engine worker (e2e/page). Built
 * into e2e/.out and served by e2e/serve.ts, which also serves the sample
 * datasets with HTTP range support (as a static host such as Vercel does).
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'page'),
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, '.out'),
    emptyOutDir: true,
    // DuckDB-WASM's builds stay separate files (~36 MB each).
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
  },
  worker: { format: 'es' },
});
