import { defineConfig } from 'vitest/config';

/*
 * - Engine tests (src/engine): plain Node against the real DuckDB binding (no
 *   Electron). Each test file writes its fixtures into its own temp folder.
 * - Renderer tests (src/renderer): store/action tests in Node; component
 *   tests opt into jsdom with a `@vitest-environment jsdom` docblock.
 */
export default defineConfig({
  test: {
    include: ['src/engine/**/*.test.ts', 'src/renderer/**/*.test.{ts,tsx}'],
    environment: 'node',
    // DuckDB queries over generated CSVs take a moment on small CI runners.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
