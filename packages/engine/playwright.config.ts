import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/*
 * The engine worker in a real browser (Chromium): DuckDB-WASM in a Web
 * Worker, driven through createWorkerEngine() by the page in e2e/page.
 * `pnpm --filter @glassgrid/engine e2e` builds the page and serves it with
 * e2e/serve.ts. Never downloads a browser: it uses PLAYWRIGHT_BROWSERS_PATH
 * (or GLASSGRID_CHROMIUM).
 */
function chromium(): string | undefined {
  const fromEnv = process.env['GLASSGRID_CHROMIUM'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const root = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  const builds = readdirSync(root).filter((name) => /^chromium-\d+$/.test(name));
  builds.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const name of builds) {
    for (const candidate of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
      const path = join(root, name, candidate);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

const PORT = Number(process.env['GLASSGRID_E2E_PORT'] ?? 4179);
const executablePath = chromium();
const bench = process.env['GLASSGRID_M4_BENCH_CSV'] !== undefined;

export default defineConfig({
  testDir: './e2e',
  ...(bench ? { testMatch: 'bench.spec.ts' } : { testIgnore: 'bench.spec.ts' }),
  timeout: bench ? 60 * 60_000 : 5 * 60_000,
  expect: { timeout: 60_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  outputDir: './test-results',
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: `node e2e/serve.ts ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
