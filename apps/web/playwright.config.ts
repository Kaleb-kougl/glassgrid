import { defineConfig } from '@playwright/test';
import { findChromium } from './e2e/chromium';

/*
 * Browser smoke tests of the built web app (`pnpm --filter @glassgrid/web
 * e2e` builds first): `vite preview` serves dist/ with its production CSP,
 * Chromium loads `/` (the app on the stub engine) and `/gallery`.
 */

const PORT = 4173;
const isRoot = process.platform === 'linux' && process.getuid?.() === 0;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  outputDir: './test-results',
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    launchOptions: { executablePath: findChromium(), args: isRoot ? ['--no-sandbox'] : [] },
  },
  webServer: {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
