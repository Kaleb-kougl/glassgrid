import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

/**
 * The Chromium the smoke tests drive: GLASSGRID_CHROMIUM, else Playwright's
 * own build, else the newest chromium-* under PLAYWRIGHT_BROWSERS_PATH (the
 * same lookup as packages/ui/bench/chromium.ts). Never downloads one.
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
  throw new Error('No Chromium found: set GLASSGRID_CHROMIUM or PLAYWRIGHT_BROWSERS_PATH (the smoke tests never download browsers).');
}
