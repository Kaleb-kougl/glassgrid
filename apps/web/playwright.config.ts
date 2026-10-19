import { defineConfig } from '@playwright/test';
import { findChromium } from './e2e/chromium';
import { parseBase } from './hosting.ts';

/*
 * Browser tests of the production build (`pnpm --filter @glassgrid/web e2e`
 * builds first): e2e/serve.ts serves dist/ with the headers vercel.json
 * gives production (header CSP included, which is what reaches the engine
 * worker), and Chromium opens the sample workspaces, a picked file and the
 * gallery. Firefox and Safari: the manual checklist in docs/m4-web-demo.md.
 *
 * GLASSGRID_BASE=/glassgrid/ runs the same tests against a build for that
 * subfolder (build it with the same variable: `pnpm --filter @glassgrid/web
 * e2e` does both), served as the portfolio's Next.js site would serve it
 * (e2e/serve.ts). The tests navigate relative to the base.
 */

const PORT = 4173;
const BASE = parseBase(process.env['GLASSGRID_BASE']);
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
    baseURL: `http://127.0.0.1:${PORT}${BASE}`,
    browserName: 'chromium',
    launchOptions: { executablePath: findChromium(), args: isRoot ? ['--no-sandbox'] : [] },
  },
  webServer: {
    command: `node e2e/serve.ts ${PORT}`,
    url: `http://127.0.0.1:${PORT}${BASE}index.html`,
    env: { GLASSGRID_BASE: BASE },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
