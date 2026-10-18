import { defineConfig } from 'vitest/config';

/*
 * Store/action tests run in Node; component tests opt into jsdom with a
 * `@vitest-environment jsdom` docblock.
 */
export default defineConfig({
  // The render-perf instrumentation is compiled out, as in an ordinary build of either shell.
  define: { __GG_RENDER_PERF__: 'false' },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
