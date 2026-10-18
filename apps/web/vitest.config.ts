import { defineConfig } from 'vitest/config';

/*
 * Unit tests of the web shell (platform, routes, the temporary stub engine)
 * run in Node; DOM tests opt into jsdom with a `@vitest-environment jsdom`
 * docblock. The browser smoke tests are Playwright (e2e/).
 */
export default defineConfig({
  define: { __GG_RENDER_PERF__: 'false' },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
