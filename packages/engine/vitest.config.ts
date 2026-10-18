import { defineConfig } from 'vitest/config';

/*
 * The engine suite runs against real DuckDB in plain Node, once per driver:
 *
 * - `native`: @duckdb/node-api, as in Electron's utility process.
 * - `wasm`: DuckDB-WASM's synchronous build, as in the web demo's worker
 *   (Node runtime instead of the browser's; see src/wasm/node.ts). Tests
 *   that only concern native internals or plain helpers run once, under
 *   `native`.
 *
 * Each test file writes its fixtures into its own temp folder.
 * `GLASSGRID_ENGINE_DRIVER` (read by test-support.ts) selects the driver.
 */
const DRIVER_NEUTRAL = [
  'src/wasm/**',
  'src/security.test.ts',
  'src/fingerprint.test.ts',
  'src/result-cache.test.ts',
  'src/column-types.test.ts',
  'src/bench.test.ts',
  'src/crossfilter-bench.test.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    // DuckDB queries over generated CSVs take a moment on small CI runners.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    projects: [
      {
        extends: true,
        test: { name: 'native', include: ['src/**/*.test.ts'], env: { GLASSGRID_ENGINE_DRIVER: 'native' } },
      },
      {
        extends: true,
        test: { name: 'wasm', include: ['src/**/*.test.ts'], exclude: DRIVER_NEUTRAL, env: { GLASSGRID_ENGINE_DRIVER: 'wasm' } },
      },
    ],
  },
});
