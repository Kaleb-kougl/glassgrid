import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

/**
 * The Chromium the benchmarks drive: GLASSGRID_CHROMIUM, else Playwright's
 * own build, else the newest chromium-* under PLAYWRIGHT_BROWSERS_PATH.
 * Never downloads one.
 */
export function findChromium(): string {
  const fromEnv = process.env['GLASSGRID_CHROMIUM'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const own = chromium.executablePath();
    if (existsSync(own)) return own;
  } catch {
    // Not installed for this Playwright version.
  }
  const root = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '/opt/pw-browsers';
  if (existsSync(join(root, 'chromium'))) return join(root, 'chromium');
  const builds = existsSync(root) ? readdirSync(root).filter((name) => /^chromium-\d+$/.test(name)) : [];
  builds.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const name of builds) {
    for (const candidate of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
      const path = join(root, name, candidate);
      if (existsSync(path)) return path;
    }
  }
  throw new Error('No Chromium found: set GLASSGRID_CHROMIUM or PLAYWRIGHT_BROWSERS_PATH (this script never downloads browsers).');
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}
