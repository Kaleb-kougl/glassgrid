import { defineConfig } from 'vitest/config';

/*
 * - Engine tests (src/engine): plain Node against the real DuckDB binding (no
 *   Electron). Each test file writes its fixtures into its own temp folder.
 * - Renderer tests (src/renderer): store/action tests in Node; component
 *   tests opt into jsdom with a `@vitest-environment jsdom` docblock.
 * - Main-process tests (src/main): the Electron-free modules (workspace
 *   files, recovery, app state, IPC wiring) with temp folders and fake
 *   dialogs, windows and ipcMain.
 */
export default defineConfig({
  // The render-perf instrumentation is compiled out, as in an ordinary build (electron.vite.config.ts).
  define: { __GG_RENDER_PERF__: 'false' },
  test: {
    include: ['src/engine/**/*.test.ts', 'src/renderer/**/*.test.{ts,tsx}', 'src/main/**/*.test.ts'],
    environment: 'node',
    // DuckDB queries over generated CSVs take a moment on small CI runners.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
