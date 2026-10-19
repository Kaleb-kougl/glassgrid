import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { downscalePng, ensureDir, findChromium, log, parkPointer, sandboxFlags, SCALE, settle, SHOT, VIDEO, WORK_DIR, MEDIA_DIR } from './common.ts';

/*
 * The web demo (apps/web production build, served with its production
 * headers by apps/web/e2e/serve.ts): the start screen, each sample
 * workspace, one dark capture, a brushed cross-filter state, and the frames
 * of the cross-filter demo video.
 */

const SAMPLES = ['taxi', 'retail', 'sensors'] as const;

/** One frame of the demo video and how long it stays on screen. */
export interface Frame {
  readonly file: string;
  readonly seconds: number;
}

const CROSSFILTER_MEASURE = 'glassgrid:crossfilter';

async function newPage(browser: Browser, size: { width: number; height: number }, colorScheme: 'light' | 'dark'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: SCALE, colorScheme, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.warn(`[showcase] page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.warn(`[showcase] console error: ${message.text()}`);
  });
  return { context, page };
}

async function still(page: Page, name: string): Promise<string> {
  const raw = join(WORK_DIR, 'raw', `${name}@2x.png`);
  await page.screenshot({ path: raw, animations: 'disabled', caret: 'hide' });
  const out = join(MEDIA_DIR, `${name}.png`);
  await downscalePng(raw, out, SHOT.width);
  log(`wrote docs/images/showcase/${name}.png`);
  return out;
}

async function openSample(page: Page, baseUrl: string, id: string): Promise<void> {
  await page.goto(`${baseUrl}/?sample=${id}`);
  await settle(page, { charts: 3 });
  await parkPointer(page);
  await settle(page, { charts: 3 });
}

function cardWithMark(page: Page, mark: string): Locator {
  return page.locator('section.gg-chart-card').filter({ has: page.locator(`.chart-view__plot[data-mark="${mark}"]`) }).first();
}

async function plotBox(page: Page, mark: string) {
  const card = cardWithMark(page, mark);
  const id = ((await card.getAttribute('data-testid')) ?? '').replace(/^chart-/, '');
  // Bars are a listbox over one canvas; the other marks name their plot canvas.
  const plot = page.getByTestId(mark === 'bar' ? `chart-${id}-bars` : `chart-${id}-chart-canvas`);
  const box = await plot.boundingBox();
  if (!box) throw new Error(`no ${mark} chart on screen`);
  return box;
}

async function crossfilterCount(page: Page): Promise<number> {
  return page.evaluate((name) => performance.getEntriesByName(name, 'measure').length, CROSSFILTER_MEASURE);
}

async function waitForCrossfilter(page: Page, previous: number): Promise<void> {
  await page.waitForFunction(({ name, before }) => performance.getEntriesByName(name, 'measure').length > before, { name: CROSSFILTER_MEASURE, before: previous }, { polling: 25, timeout: 120_000 });
}

/** Brushes the line chart (trips per day) across [from, to] of its width, as a pointer drag. */
async function brushLine(page: Page, from: number, to: number, steps: number, onStep?: (x: number, y: number) => Promise<void>): Promise<void> {
  const box = await plotBox(page, 'line');
  const y = box.y + box.height * 0.5;
  const x0 = box.x + box.width * from;
  const before = await crossfilterCount(page);
  await page.mouse.move(x0, y);
  await onStep?.(x0, y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    const x = x0 + (box.width * (to - from) * step) / steps;
    await page.mouse.move(x, y);
    await onStep?.(x, y);
  }
  await page.mouse.up();
  await waitForCrossfilter(page, before);
}

export async function captureStills(baseUrl: string): Promise<void> {
  await ensureDir(join(WORK_DIR, 'raw'));
  await ensureDir(MEDIA_DIR);
  const browser = await chromium.launch({ executablePath: await findChromium(), args: sandboxFlags() });
  try {
    // Start screen: the three samples are offered. DuckDB-WASM starts lazily (on a
    // sample link, or when a person points at Open or a sample), so nothing here waits for it.
    {
      const { context, page } = await newPage(browser, SHOT, 'light');
      await page.goto(`${baseUrl}/`);
      await page.getByText('Or try a sample').waitFor();
      await parkPointer(page);
      await settle(page);
      await still(page, 'web-start');
      await context.close();
    }
    for (const id of SAMPLES) {
      const { context, page } = await newPage(browser, SHOT, 'light');
      await openSample(page, baseUrl, id);
      await still(page, `web-${id}`);
      if (id === 'taxi') {
        // Brush April to mid-May on "Trips per day": the zones, the grid and its count follow.
        await brushLine(page, 0.52, 0.76, 8);
        await parkPointer(page);
        await settle(page, { charts: 3 });
        await still(page, 'web-taxi-brushed');
      }
      await context.close();
    }
    {
      const { context, page } = await newPage(browser, SHOT, 'dark');
      await openSample(page, baseUrl, 'taxi');
      await still(page, 'web-taxi-dark');
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// The demo video: a scripted pointer, one 2x screenshot per step.

/**
 * A drawn pointer for the video (headless screenshots have none). Built with
 * DOM APIs and CSSOM styles, which the page's CSP allows; it ignores pointer
 * events, so the app never sees it.
 */
async function installPointer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '28');
    svg.setAttribute('viewBox', '0 0 22 28');
    svg.id = 'gg-showcase-pointer';
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M2 2 L2 22 L7.5 17 L11 25.5 L14.5 24 L11 15.8 L18.5 15.8 Z');
    path.setAttribute('fill', '#111');
    path.setAttribute('stroke', '#fff');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    Object.assign(svg.style, { position: 'fixed', left: '0px', top: '0px', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-2px, -2px)', display: 'none' });
    document.body.appendChild(svg);
  });
}

async function showPointer(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ left, top }) => {
      const pointer = document.getElementById('gg-showcase-pointer');
      if (!pointer) return;
      pointer.style.display = 'block';
      pointer.style.left = `${left}px`;
      pointer.style.top = `${top}px`;
    },
    { left: x, top: y },
  );
}

const STEP = 1 / 15;

/**
 * Records the cross-filter demo on the taxi sample: brush a date range on
 * "Trips per day" (zones, the grid and its count follow), click the Airport
 * bar (the line follows), then undo both, which brings the loop back to its
 * first frame. Each step is a 2x screenshot with a fixed duration, so the
 * video's timing does not depend on how fast this machine screenshots.
 */
export async function captureVideoFrames(baseUrl: string): Promise<Frame[]> {
  const dir = await ensureDir(join(WORK_DIR, 'frames'));
  const browser = await chromium.launch({ executablePath: await findChromium(), args: sandboxFlags() });
  const frames: Frame[] = [];
  try {
    const { page } = await newPage(browser, VIDEO, 'light');
    await openSample(page, baseUrl, 'taxi');
    await installPointer(page);

    let pointer = { x: VIDEO.width * 0.42, y: VIDEO.height * 0.62 };
    const frame = async (seconds: number) => {
      const file = join(dir, `${String(frames.length).padStart(4, '0')}.png`);
      await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
      frames.push({ file, seconds });
    };
    /** Moves the drawn pointer (and the real one, with `mouse`) in `steps` frames. */
    const glide = async (x: number, y: number, steps: number, mouse = true) => {
      const from = pointer;
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        const px = from.x + (x - from.x) * ease;
        const py = from.y + (y - from.y) * ease;
        if (mouse) await page.mouse.move(px, py);
        await showPointer(page, px, py);
        await frame(STEP);
      }
      pointer = { x, y };
    };

    await showPointer(page, pointer.x, pointer.y);
    await frame(1.0);

    // 1. Brush a date range on the line chart.
    const line = await plotBox(page, 'line');
    const brushY = line.y + line.height * 0.55;
    await glide(line.x + line.width * 0.52, brushY, 8, false);
    await page.mouse.move(pointer.x, pointer.y);
    let before = await crossfilterCount(page);
    await page.mouse.down();
    await glide(line.x + line.width * 0.74, brushY, 12);
    await page.mouse.up();
    await waitForCrossfilter(page, before);
    await settle(page, { charts: 3 });
    await frame(2.0);

    // 2. Click the Airport bar: the line chart shows airport trips only.
    const bars = await plotBox(page, 'bar');
    const index = await cardWithMark(page, 'bar')
      .locator('[role="option"]')
      .evaluateAll((options) => options.findIndex((option) => option.getAttribute('data-key') === '"Airport"'));
    const count = await cardWithMark(page, 'bar').locator('[role="option"]').count();
    if (index < 0 || count === 0) throw new Error('no Airport bar in the taxi sample');
    const barY = bars.y + ((index + 0.5) * bars.height) / count;
    await glide(bars.x + bars.width * 0.3, barY, 10);
    before = await crossfilterCount(page);
    await page.mouse.click(pointer.x, pointer.y);
    await waitForCrossfilter(page, before);
    await settle(page, { charts: 3 });
    await frame(2.0);

    // 3. Undo twice, back to the first frame.
    const undo = await page.getByTestId('undo').boundingBox();
    if (!undo) throw new Error('no undo button');
    await glide(undo.x + undo.width / 2, undo.y + undo.height / 2, 10);
    for (let n = 0; n < 2; n += 1) {
      await page.mouse.click(pointer.x, pointer.y);
      await settle(page, { charts: 3 });
      await frame(n === 0 ? 0.6 : 0.4);
    }
    await glide(VIDEO.width * 0.42, VIDEO.height * 0.62, 10);
    await settle(page, { charts: 3 });
    await frame(0.6);
  } finally {
    await browser.close();
  }
  await writeFile(join(dir, 'frames.json'), `${JSON.stringify(frames, null, 2)}\n`);
  log(`recorded ${frames.length} video frames`);
  return frames;
}
