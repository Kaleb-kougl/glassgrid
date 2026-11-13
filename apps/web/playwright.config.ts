import { defineConfig, type Project } from '@playwright/test';
import { findChromium } from './e2e/chromium';
import { parseBase } from './hosting.ts';
import { parseBrowsers } from './playwright-browsers.ts';

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
 *
 * Browsers (L5): Chromium by default, the build this repository's CI and
 * dev VM have. GLASSGRID_E2E_BROWSERS=chromium,firefox,webkit (any subset)
 * runs the same specs in Playwright's Firefox and WebKit too, which must be
 * installed first (`pnpm --filter @glassgrid/web exec playwright install
 * firefox webkit`; on Linux add `--with-deps`). CI's `web-browsers` job does
 * that. Only Chromium is looked up outside Playwright's own cache
 * (`findChromium`); the specs use no Chromium-only API, and the two
 * Chromium-only benchmarks skip themselves elsewhere.
 *
 * The server also stands in for the portfolio's live relay
 * (GLASSGRID_E2E_RELAY=1, e2e/serve.ts), answering 404 until a test scripts
 * it, as a host without the relay would.
 */

// GLASSGRID_E2E_PORT: another port when 4173 is taken (two checkouts running their E2E at once).
const PORT = Number(process.env['GLASSGRID_E2E_PORT'] ?? 4173) || 4173;
const BASE = parseBase(process.env['GLASSGRID_BASE']);
const isRoot = process.platform === 'linux' && process.getuid?.() === 0;
// An empty or unknown value throws here (playwright-browsers.ts): never zero projects that "pass".
const BROWSERS = parseBrowsers(process.env['GLASSGRID_E2E_BROWSERS']);
// Firefox and WebKit keep a trace of each failure (CI uploads test-results/). Firefox: WebGL on a runner without a GPU
// needs Mesa's software driver (CI installs it), must not be blocked on it, and needs a display to make its GL context
// on: headless it has none ("Exhausted GL driver options" even with Mesa), so CI sets GLASSGRID_E2E_FIREFOX_HEADED=1
// and runs under xvfb-run. Chromium has SwiftShader.
const FIREFOX_HEADED = process.env['GLASSGRID_E2E_FIREFOX_HEADED'] === '1';
const projects: Project[] = BROWSERS.map((browserName) =>
  browserName === 'chromium'
    ? { name: 'chromium', use: { browserName, launchOptions: { executablePath: findChromium(), args: isRoot ? ['--no-sandbox'] : [] } } }
    : browserName === 'firefox'
      ? { name: 'firefox', use: { browserName, trace: 'retain-on-failure', headless: !FIREFOX_HEADED, launchOptions: { firefoxUserPrefs: { 'webgl.force-enabled': true, 'webgl.disabled': false } } } }
      : { name: browserName, use: { browserName, trace: 'retain-on-failure' } },
);

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
  },
  projects,
  webServer: {
    command: `node e2e/serve.ts ${PORT}`,
    url: `http://127.0.0.1:${PORT}${BASE}index.html`,
    env: { GLASSGRID_BASE: BASE, GLASSGRID_E2E_RELAY: '1' },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
