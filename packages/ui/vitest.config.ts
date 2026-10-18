import { defineConfig } from 'vitest/config';

/*
 * Component tests run on jsdom (React Testing Library); the token drift test
 * opts into Node with a `@vitest-environment node` docblock.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tokens/*.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
