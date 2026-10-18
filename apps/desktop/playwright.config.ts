import { defineConfig } from '@playwright/test';
import { e2eRowCount } from './e2e/config';

const rows = e2eRowCount();
/** The render benchmark (e2e/render-perf.spec.ts) is slow and needs its own build: only `pnpm e2e:render` runs it. */
const renderBenchmark = process.env['GLASSGRID_E2E_RENDER'] === '1';

export default defineConfig({
  testDir: './e2e',
  ...(renderBenchmark ? { testMatch: 'render-perf.spec.ts' } : { testIgnore: 'render-perf.spec.ts' }),
  // CSV generation plus a cold and a warm count; 10M rows needs headroom.
  timeout: rows > 2_000_000 ? 20 * 60_000 : 5 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  outputDir: './test-results',
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
});
