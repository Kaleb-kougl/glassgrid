import { expect, test, type Locator, type Page } from '@playwright/test';
import './map-support';
import { expectNoProblems, watchProblems } from './support';

/*
 * The live-flights map (milestone L3) on the production build with the
 * production headers: `?map-demo` renders @glassgrid/ui's MapView on 183
 * synthetic aircraft. MapLibre must work under the unchanged CSP (no blob:
 * worker, no inline styles, no eval), load only same-origin files, and draw
 * the basemap and the aircraft. Any console error, CSP violation, failed
 * request or `[glassgrid]` warning fails (support.ts).
 */

interface Swatches {
  readonly [name: string]: readonly [number, number, number];
}

/** Pixels of a screenshot close to each named colour (max channel difference ≤ `tolerance`). */
async function countColours(page: Page, target: Locator, swatches: Swatches, tolerance = 10): Promise<Record<string, number>> {
  const png = (await target.screenshot()).toString('base64');
  return page.evaluate(
    async ({ png, swatches, tolerance }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const counts: Record<string, number> = {};
      const entries = Object.entries(swatches);
      for (const [name] of entries) counts[name] = 0;
      for (let i = 0; i < data.length; i += 4) {
        for (const [name, [r, g, b]] of entries) {
          if (Math.abs((data[i] ?? 0) - r) <= tolerance && Math.abs((data[i + 1] ?? 0) - g) <= tolerance && Math.abs((data[i + 2] ?? 0) - b) <= tolerance) {
            counts[name] = (counts[name] ?? 0) + 1;
            break;
          }
        }
      }
      return counts;
    },
    { png, swatches, tolerance },
  );
}

const hex = (value: string): [number, number, number] => [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
// tokens (packages/ui/tokens): map.land / map.water and chart.altitude per theme.
const LIGHT = { land: hex('#f6f7f9'), water: hex('#c3d7f1'), alt3: hex('#d4536f'), alt4: hex('#b42d8e'), alt5: hex('#8409a5'), alt6: hex('#41049d') };
const DARK = { land: hex('#262c34'), water: hex('#1a2533'), alt1: hex('#f4ec22'), alt2: hex('#fcb62f'), alt3: hex('#f38749'), alt4: hex('#dd5e66') };

test('?map-demo draws the basemap and 183 aircraft under the production CSP, with a same-origin MapLibre worker', async ({ page, baseURL }) => {
  const problems = await watchProblems(page);
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const response = await page.goto('./?map-demo');
  const origin = new URL(baseURL ?? page.url()).origin;

  // The unchanged policy: no blob: workers, no inline styles, no eval.
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("worker-src 'self'");
  expect(csp).toContain("style-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toMatch(/blob:|'unsafe-inline'|(^|\s)'unsafe-eval'/);

  const view = page.getByTestId('map-view');
  await expect(view).toHaveAttribute('data-state', 'ready');
  const canvas = page.locator('canvas.maplibregl-canvas');
  await expect(canvas).toBeVisible();
  // Keyboard and screen readers: a focusable canvas named with the aircraft count.
  await expect(canvas).toHaveAttribute('tabindex', '0');
  await expect(canvas).toHaveAttribute('aria-label', /^Live flights map, 183 aircraft\./);
  await expect.poll(() => page.evaluate(() => window.__ggMapDemo?.stats().frames ?? 0)).toBeGreaterThan(10);
  expect(await page.evaluate(() => window.__ggMapDemo?.stats().glyphs)).toBe(183);

  // MapLibre's worker is a same-origin module script, never a blob.
  expect(workers.filter((url) => /maplibre-gl-worker-[\w-]+\.js/.test(url) && new URL(url).origin === origin)).toHaveLength(workers.length > 0 ? workers.length : 1);
  expect(workers.filter((url) => url.startsWith('blob:'))).toEqual([]);
  // Everything came from this origin: the basemap, its descriptor and the glyphs.
  expect(requests.filter((url) => /^https?:/.test(url) && new URL(url).origin !== origin)).toEqual([]);
  for (const file of ['map/basemap.json', 'map/basemap.geojson', 'map/fonts/Noto%20Sans%20Regular/0-255.pbf']) {
    expect(requests.some((url) => url.endsWith(file)), file).toBe(true);
  }

  // Credits: the props' attribution and the basemap's.
  const credits = page.locator('.maplibregl-ctrl-attrib');
  await expect(credits).toContainText('Synthetic aircraft (test data)');
  await expect(credits).toContainText('Natural Earth');
  await expect(credits).toContainText('OurAirports');

  // Land, water and aircraft of several altitude bands are on the canvas.
  const light = await countColours(page, canvas, LIGHT);
  expect(light['land']).toBeGreaterThan(50_000);
  expect(light['water']).toBeGreaterThan(50_000);
  const bandsSeen = ['alt3', 'alt4', 'alt5', 'alt6'].filter((band) => (light[band] ?? 0) > 20);
  expect(bandsSeen.length, JSON.stringify(light)).toBeGreaterThanOrEqual(3);

  // Clicking the aircraft at the centre (TEST01, stationary) selects it; Escape on the canvas clears it.
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('map-demo-selected')).toHaveText('Selected: TEST01');
  await expect(canvas).toHaveAttribute('aria-label', /TEST01 selected/);
  await canvas.focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('map-demo-selected')).toHaveText('Selected: none');
  // A click on empty water selects nothing.
  await page.mouse.click(box.x + 12, box.y + 12);
  await expect(page.getByTestId('map-demo-selected')).toHaveText('Selected: none');

  // Keyboard: + zooms in, arrow keys pan; the viewport callback reports the bounds after each move.
  const west = () => page.evaluate(() => window.__ggMapDemo?.viewport?.west ?? Number.NaN);
  const before = await west();
  expect(before).toBeGreaterThan(-123.26);
  await canvas.focus();
  await page.keyboard.press('Equal');
  await expect.poll(west).toBeGreaterThan(before + 0.1);
  const zoomed = await west();
  await page.keyboard.press('ArrowRight');
  await expect.poll(west).toBeGreaterThan(zoomed + 0.01);

  // The dark theme repaints the basemap and the aircraft from the dark tokens, without reloading the style.
  await page.getByTestId('map-demo-theme').click();
  await expect(view).toHaveAttribute('data-gg-theme', 'dark');
  await expect.poll(async () => (await countColours(page, canvas, DARK))['water'] ?? 0).toBeGreaterThan(50_000);
  const dark = await countColours(page, canvas, DARK);
  expect(dark['land']).toBeGreaterThan(50_000);
  expect(['alt1', 'alt2', 'alt3', 'alt4'].filter((band) => (dark[band] ?? 0) > 20).length, JSON.stringify(dark)).toBeGreaterThanOrEqual(3);

  await page.screenshot({ path: test.info().outputPath('map-demo-dark.png') });
  await expectNoProblems(page, problems);
});

test('?map-demo pauses: no frames are drawn while paused and nothing changes', async ({ page }) => {
  const problems = await watchProblems(page);
  await page.goto('./?map-demo&paused');
  await expect(page.getByTestId('map-view')).toHaveAttribute('data-state', 'ready');
  await expect.poll(() => page.evaluate(() => window.__ggMapDemo?.stats().frames ?? 0)).toBeGreaterThan(0);
  // Let the load settle, then count frames over a second: a paused map with no input renders none.
  await page.waitForTimeout(1_500);
  const frames = await page.evaluate(() => window.__ggMapDemo?.stats().frames ?? 0);
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => window.__ggMapDemo?.stats().frames ?? 0)).toBe(frames);
  // Play: frames flow again.
  await page.getByTestId('map-demo-play').click();
  await expect.poll(() => page.evaluate(() => window.__ggMapDemo?.stats().frames ?? 0)).toBeGreaterThan(frames + 10);
  await expectNoProblems(page, problems);
});
