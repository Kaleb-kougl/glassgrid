import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Locator, type Page } from '@playwright/test';
import { downscalePng, ensureDir, findChromium, log, MEDIA_DIR, parkPointer, sandboxFlags, settle, WORK_DIR } from './common.ts';
import { installPointer, newPage, showPointer, type Frame } from './web.ts';

/*
 * The live-flights demo (docs/live-flights.md) on the recorded traffic,
 * `?sample=flights` (the busiest half hour of 2026-11-09, loaded whole):
 *
 * - stills `flights-map.png` and `flights-map-dark.png`: the map card (time
 *   scrubber, map, list bar) and all three charts (altitude, category,
 *   vertical rate), held at 23:45:59 UTC;
 * - the frames of `flights-demo` (GIF, MP4, WebM): brush the altitude
 *   histogram (the map drops the aircraft outside the range), pan the map
 *   (the charts and the grid follow its view), then drag the time slider
 *   back (the aircraft move back along their trails).
 *
 * Framing: the map and the charts are what this shows, so the charts panel
 * is widened (its width is the `--gg-chart-canvas-w` token, set through
 * CSSOM, which the page's CSP allows) and each capture is clipped to it,
 * with a sliver of the grid at its left for context. The map's attribution
 * control stays expanded at that width, so the adsb.lol ODbL credit is in
 * every frame.
 *
 * The map is MapLibre on WebGL: on a machine without a GPU (SwiftShader)
 * each frame takes a while to draw, which slows the capture, not the video:
 * every frame has a fixed duration.
 */

/** The stills: tall enough for the map card and the three charts below it. */
const STILL = { width: 1440, height: 1600 } as const;
/** The video: the map card and the altitude chart. */
const VIDEO_PAGE = { width: 1280, height: 1000 } as const;
/** The charts panel's width in both (the app's default is 480 px). */
const PANEL_W = 780;
/** How much of the grid shows at the clip's left edge. */
const GRID_SLIVER = 90;

const CROSSFILTER_MEASURE = 'glassgrid:crossfilter';
const TIME_SEEK_MEASURE = 'glassgrid:time-seek';

async function measures(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => performance.getEntriesByName(n, 'measure').length, name);
}

async function nextMeasure(page: Page, name: string, before: number): Promise<void> {
  await page.waitForFunction(({ n, previous }) => performance.getEntriesByName(n, 'measure').length > previous, { n: name, previous: before }, { polling: 25, timeout: 120_000 });
}

/** The map drawn and quiet: ready, with aircraft, eases done (they last 1 s), two more frames. */
async function settleMap(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const view = document.querySelector<HTMLElement>('[data-testid="map-view"]');
      return view?.dataset['state'] === 'ready' && Number(view.dataset['aircraft'] ?? 0) > 0;
    },
    undefined,
    { polling: 100, timeout: 120_000 },
  );
  await page.waitForTimeout(1_200);
  await settle(page, { charts: 3 });
}

/** `?sample=flights` with the charts panel widened, paused at 23:45:59 UTC (End, then six steps of two minutes back): busy and still. */
async function openFlights(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/?sample=flights`);
  await page.evaluate((width) => document.documentElement.style.setProperty('--gg-chart-canvas-w', `${width}px`), PANEL_W);
  await page.getByTestId('time-bar').and(page.locator('[data-mode="playing"]')).waitFor({ timeout: 120_000 });
  await page.getByTestId('time-play').click();
  const slider = page.getByRole('slider', { name: 'Time shown on the map' });
  await slider.focus();
  await page.keyboard.press('End');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('PageDown');
  await page.waitForFunction(() => /^23:45:59 UTC/.test(document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext') ?? ''), undefined, { timeout: 60_000 });
  // Keyboard focus would ring the slider in every frame: park it on the page (and the pointer outside).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await parkPointer(page);
  await settleMap(page);
}

/** The charts panel and a sliver of the grid, in CSS px. */
async function panelClip(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const panel = await page.locator('.charts').boundingBox();
  if (!panel) throw new Error('no charts panel');
  const size = page.viewportSize() ?? { width: 0, height: 0 };
  const x = Math.max(0, Math.round(panel.x - GRID_SLIVER));
  return { x, y: 0, width: size.width - x, height: size.height };
}

async function clippedStill(page: Page, name: string): Promise<void> {
  const clip = await panelClip(page);
  const raw = join(WORK_DIR, 'raw', `${name}@2x.png`);
  await page.screenshot({ path: raw, clip, animations: 'disabled', caret: 'hide' });
  await downscalePng(raw, join(MEDIA_DIR, `${name}.png`), clip.width);
  log(`wrote docs/images/showcase/${name}.png (${clip.width}×${clip.height})`);
}

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('not on screen');
  return box;
}

export async function captureFlightsStills(baseUrl: string): Promise<void> {
  await ensureDir(join(WORK_DIR, 'raw'));
  const browser = await chromium.launch({ executablePath: await findChromium(), args: sandboxFlags() });
  try {
    for (const scheme of ['light', 'dark'] as const) {
      const { context, page } = await newPage(browser, STILL, scheme);
      await openFlights(page, baseUrl);
      await clippedStill(page, scheme === 'light' ? 'flights-map' : 'flights-map-dark');
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

const STEP = 1 / 15;

/** The video's frames, and the width they were clipped to (CSS px), for the encoder. */
export interface FlightsFrames {
  readonly frames: Frame[];
  readonly width: number;
}

/** Brush altitude → the map filters; pan the map → the charts follow; drag the time slider → the aircraft move back in time. */
export async function captureFlightsVideoFrames(baseUrl: string): Promise<FlightsFrames> {
  const dir = await ensureDir(join(WORK_DIR, 'flights-frames'));
  const browser = await chromium.launch({ executablePath: await findChromium(), args: sandboxFlags() });
  const frames: Frame[] = [];
  let width: number;
  try {
    const { page } = await newPage(browser, VIDEO_PAGE, 'light');
    await openFlights(page, baseUrl);
    await installPointer(page);
    const clip = await panelClip(page);
    width = clip.width;
    let pointer = { x: clip.x + clip.width * 0.5, y: VIDEO_PAGE.height * 0.6 };
    const frame = async (seconds: number) => {
      const file = join(dir, `${String(frames.length).padStart(4, '0')}.png`);
      await page.screenshot({ path: file, clip, animations: 'disabled', caret: 'hide' });
      frames.push({ file, seconds });
    };
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
    await frame(1.2);

    // 1. Brush the altitude histogram below about 10,000 ft (arrivals and departures): the map keeps only those aircraft.
    const histogram = await boxOf(page.getByTestId('chart-chart_2-chart-canvas'));
    const brushY = histogram.y + histogram.height * 0.5;
    await glide(histogram.x + histogram.width * 0.04, brushY, 8, false);
    await page.mouse.move(pointer.x, pointer.y);
    let before = await measures(page, CROSSFILTER_MEASURE);
    await page.mouse.down();
    await glide(histogram.x + histogram.width * 0.26, brushY, 12);
    await page.mouse.up();
    await nextMeasure(page, CROSSFILTER_MEASURE, before);
    await settleMap(page);
    await frame(2.0);

    // 2. Pan the map (towards the coast): the charts and the grid follow the box it shows.
    const map = await boxOf(page.getByTestId('map-view').locator('canvas'));
    await glide(map.x + map.width * 0.45, map.y + map.height * 0.55, 8, false);
    await page.mouse.move(pointer.x, pointer.y);
    before = await measures(page, CROSSFILTER_MEASURE);
    await page.mouse.down();
    await glide(map.x + map.width * 0.62, map.y + map.height * 0.45, 10);
    await page.mouse.up();
    await nextMeasure(page, CROSSFILTER_MEASURE, before);
    await settleMap(page);
    await frame(2.0);

    // 3. Drag the time slider's thumb back about ten minutes, a step at a time: the aircraft move back along their trails.
    const slider = await boxOf(page.getByRole('slider', { name: 'Time shown on the map' }));
    const thumb = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[role="slider"]');
      const min = Number(el?.getAttribute('aria-valuemin'));
      const max = Number(el?.getAttribute('aria-valuemax'));
      const now = Number(el?.getAttribute('aria-valuenow'));
      return max > min ? (now - min) / (max - min) : 0.5;
    });
    const y = slider.y + slider.height / 2;
    await glide(slider.x + slider.width * thumb, y, 8, false);
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      before = await measures(page, TIME_SEEK_MEASURE);
      const x = slider.x + slider.width * (thumb - 0.055 * step);
      await page.mouse.move(x, y);
      await showPointer(page, x, y);
      await nextMeasure(page, TIME_SEEK_MEASURE, before);
      await page.waitForTimeout(400);
      await frame(0.45);
      pointer = { x, y };
    }
    await page.mouse.up();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settleMap(page);
    await frame(1.5);
  } finally {
    await browser.close();
  }
  await writeFile(join(dir, 'frames.json'), `${JSON.stringify(frames, null, 2)}\n`);
  log(`recorded ${frames.length} flights video frames`);
  return { frames, width };
}
