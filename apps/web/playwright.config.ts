import { defineConfig } from '@playwright/test';
import { findChromium } from './e2e/chromium';

/*
 * Browser tests of the production build (`pnpm --filter @glassgrid/web e2e`
 * builds first): e2e/serve.ts serves dist/ with the headers vercel.json
 * gives production (header CSP included, which is what reaches the engine
 * worker), and Chromium opens the sample workspaces, a picked file and the
 * gallery. Firefox and Safari: the manual checklist in docs/m4-web-demo.md.
 */

const PORT = 4173;
const isRoot = process.platform === 'linux' && process.getuid?.() === 0;

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 60_000 },
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
    command: `node e2e/serve.ts ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
