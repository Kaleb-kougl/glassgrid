import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';

/** Repository root (tools/showcase/src → ../../..). */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
/** Where the committed media goes. */
export const MEDIA_DIR = join(REPO_ROOT, 'docs', 'images', 'showcase');
/** Scratch space: raw 2x captures, video frames, the desktop CSV and userData (gitignored: `out/`). */
export const WORK_DIR = join(REPO_ROOT, 'tools', 'showcase', 'out');

/**
 * Every capture is taken at 2x and downscaled with Lanczos, so the PNGs are
 * supersampled and identical in size on every machine.
 */
export const SCALE = 2;
/** Screenshots: the default desktop window size (apps/desktop main) and the web demo's E2E viewport. */
export const SHOT = { width: 1440, height: 900 } as const;
/** The demo video: a little smaller, so text stays legible at the GIF's width. */
export const VIDEO = { width: 1280, height: 800 } as const;
/** GIF width in px (height follows the aspect ratio). */
export const GIF_WIDTH = 960;

export function log(message: string): void {
  console.info(`[showcase] ${message}`);
}

export function seconds(sinceMs: number): string {
  return `${((performance.now() - sinceMs) / 1000).toFixed(1)} s`;
}

/** Runs a command, inheriting stdio; rejects on a non-zero exit. */
export function run(command: string, args: readonly string[], options: SpawnOptions = {}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: REPO_ROOT, ...options });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${signal ?? String(code)}`));
    });
  });
}

/** Runs ffmpeg quietly (errors only); rejects on failure. */
export function ffmpeg(args: readonly string[]): Promise<void> {
  return run(process.env['FFMPEG'] ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

export async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

/**
 * The Chromium to drive: GLASSGRID_CHROMIUM, else the newest chromium-* under
 * PLAYWRIGHT_BROWSERS_PATH (default /opt/pw-browsers), as the web E2E finds
 * it. Never downloads a browser.
 */
export async function findChromium(): Promise<string> {
  const fromEnv = process.env['GLASSGRID_CHROMIUM'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const { chromium } = await import('@playwright/test');
  try {
    const own = chromium.executablePath();
    if (existsSync(own)) return own;
  } catch {
    // Not installed for this Playwright version.
  }
  const root = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '/opt/pw-browsers';
  const builds = existsSync(root) ? readdirSync(root).filter((name) => /^chromium-\d+$/.test(name)) : [];
  builds.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const name of builds) {
    for (const candidate of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
      const path = join(root, name, candidate);
      if (existsSync(path)) return path;
    }
  }
  throw new Error('No Chromium found: set GLASSGRID_CHROMIUM or PLAYWRIGHT_BROWSERS_PATH (the showcase never downloads browsers).');
}

/** Chromium refuses to run as root without --no-sandbox (containers, some CI). */
export function sandboxFlags(): string[] {
  return process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [];
}

/**
 * Waits until the page is quiet: every chart card drawn with data, every
 * visible grid cell loaded, no "Updating…" skeleton, fonts loaded, and two
 * more animation frames painted.
 */
export async function settle(page: Page, options: { charts?: number } = {}): Promise<void> {
  await page.waitForFunction(
    (minCharts) => {
      const cards = [...document.querySelectorAll<HTMLElement>('section.gg-chart-card')];
      if (cards.length < minCharts) return false;
      const drawn = cards.every((card) => card.dataset['status'] === 'ready' && /^[0-9][\d,]* rows?$/.test(card.querySelector('.gg-chart-card__rows')?.textContent ?? ''));
      const cells = [...document.querySelectorAll('[data-testid="grid-mirror"] [role="gridcell"]')];
      const loaded = cells.every((cell) => cell.textContent !== 'Loading');
      return drawn && loaded;
    },
    options.charts ?? 0,
    { polling: 100, timeout: 180_000 },
  );
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))));
  // Hover states and tooltips settle with the pointer parked outside the app.
  await page.waitForTimeout(250);
}

/** Moves the pointer to a corner, so no hover state or tooltip shows in a still. */
export async function parkPointer(page: Page): Promise<void> {
  const size = page.viewportSize();
  await page.mouse.move((size?.width ?? 2) - 1, (size?.height ?? 2) - 1);
}

/** Downscales a 2x capture to its CSS-pixel size (Lanczos) and writes an optimised PNG. */
export async function downscalePng(input: string, output: string, width: number): Promise<void> {
  await ffmpeg(['-i', input, '-vf', `scale=${width}:-1:flags=lanczos`, '-pred', 'mixed', '-compression_level', '100', output]);
}
