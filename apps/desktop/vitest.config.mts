import { defineConfig } from 'vitest/config';

/*
 * Engine unit tests: plain Node against the real DuckDB binding (no
 * Electron). Each test file writes its fixtures into its own temp folder.
 */
export default defineConfig({
  test: {
    include: ['src/engine/**/*.test.ts'],
    environment: 'node',
    // DuckDB queries over generated CSVs take a moment on small CI runners.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
