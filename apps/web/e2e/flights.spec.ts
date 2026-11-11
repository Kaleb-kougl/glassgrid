import { expect, test, type Locator, type Page } from '@playwright/test';
import { CROSSFILTER_MEASURE, TIME_SEEK_MEASURE, type CrossfilterMeasureDetail } from '@glassgrid/app/perf';
import { expectEngineWithParquet, expectNoProblems, shownRows, watchProblems } from './support';

/*
 * The flights workspace (docs/live-flights-l3-data.md, l4.md) on the
 * production build: `?sample=flights` loads flights-bay-30min.parquet whole
 * into `flight_states` in the engine worker (L4's archive source), opens a
 * map, altitude and vertical-rate histograms and a category bar over it,
 * and the time scrubber plays it at 10×. No console error, CSP violation,
 * error toast or failed request on the way.
 *
 * The map is MapLibre (`@glassgrid/ui/map`'s lazy chunk); the tests read
 * the card's own state and the component's `data-state`. The L4 test pans
 * the map (charts and grid follow), brushes the altitude histogram (the
 * map's count drops), scrubs (the aircraft move) and selects an aircraft
 * (its track and details). The last test takes the map down and back (the
 * card's Remove, Undo, undoing the workspace, opening a CSV): each once
 * threw in MapView's teardown and blanked the page.
 */

const TOTAL_ROWS = 71_595;

/** Exact light-theme altitude-band colours of the aircraft glyphs (tokens chart.altitude.3-6; map.spec.ts). */
const GLYPH_COLOURS = ['#d4536f', '#b42d8e', '#8409a5', '#41049d'];

/** Points of the map canvas painted in a glyph colour, right of the altitude key (only glyph fills are opaque in those colours). */
async function glyphPixels(page: Page, canvas: Locator): Promise<[number, number][]> {
  const png = (await canvas.screenshot()).toString('base64');
  return page.evaluate(
    async ({ png, colours }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
      const rgb = colours.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
      const out: [number, number][] = [];
      for (let y = 12; y < height - 40; y += 2) {
        for (let x = 170; x < width - 12; x += 2) {
          const i = (y * width + x) * 4;
          if (rgb.some(([r = 0, g = 0, b = 0]) => Math.abs((data[i] ?? 0) - r) <= 6 && Math.abs((data[i + 1] ?? 0) - g) <= 6 && Math.abs((data[i + 2] ?? 0) - b) <= 6)) out.push([x, y]);
        }
      }
      return out;
    },
    { png, colours: GLYPH_COLOURS },
  );
}

async function measureCount(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => performance.getEntriesByName(n, 'measure').length, name);
}

async function nextMeasure(page: Page, name: string, previous: number, source?: string): Promise<{ duration: number; detail: unknown }> {
  const handle = await page.waitForFunction(
    ({ n, before, from }) => {
      const hit = (performance.getEntriesByName(n, 'measure') as PerformanceMeasure[]).slice(before).find((entry) => from === undefined || (entry.detail as { source?: string } | null)?.source === from);
      return hit ? { duration: hit.duration, detail: hit.detail as unknown } : null;
    },
    { n: name, before: previous, from: source },
    { timeout: 60_000, polling: 25 },
  );
  return (await handle.jsonValue()) as { duration: number; detail: unknown };
}

test('/?sample=flights loads the 30-minute fixture whole into flight_states and plays it on the map', async ({ page }) => {
  const problems = await watchProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?sample=flights');
  await expectEngineWithParquet(problems);

  await expect(page.getByTestId('file-name')).toHaveText('flight_states');
  const map = page.getByTestId('map-map_1');
  await expect(map).toBeVisible();
  const aircraft = async () => Number((await map.getAttribute('data-aircraft')) ?? 0);
  // Every fix at once (one batch), then the cursor plays from the first fix: aircraft on the map, T moving on.
  await expect(page.getByTestId('file-size')).toHaveText(`${TOTAL_ROWS.toLocaleString('en-US')} rows · Recorded`, { timeout: 60_000 });
  await expect(page.getByTestId('time-bar')).toHaveAttribute('data-mode', 'playing', { timeout: 60_000 });
  await expect.poll(aircraft, { timeout: 60_000 }).toBeGreaterThan(20);
  // Until the profile names the first fix the cursor sits at the end; then it plays from the start.
  const clock = async () => Number(await map.getAttribute('data-clock'));
  await expect.poll(clock, { timeout: 30_000 }).toBeLessThan(Date.parse('2026-11-09T23:40:00.000Z'));
  const first = await clock();
  await expect.poll(clock, { timeout: 30_000 }).toBeGreaterThan(first + 10_000);
  await expect(map.getByTestId('map-map_1-status')).toHaveText(/^Recorded · [1-9]\d* aircraft$/);
  await expect(page.getByTestId('time-range')).toHaveText('Data: Nov 9, 2026, 23:27:00–23:57:59 UTC (31 min)');
  await expect(page.getByRole('slider', { name: 'Time shown on the map' })).toHaveAttribute('aria-valuetext', /^\d\d:\d\d:\d\d UTC, /);
  await expect(page.getByTestId('map-view')).toBeVisible();
  // The colour key, and the live table's rows and state in the top bar (it has no file size).
  await expect(map.getByRole('list', { name: 'Bay Area traffic: aircraft altitude' }).getByRole('listitem')).toHaveCount(8);

  // The three charts over the live table draw rows: altitude, category, vertical rate.
  const cards = page.locator('section.gg-chart-card');
  await expect(cards).toHaveCount(3);
  await expect.poll(() => cards.evaluateAll((elements) => elements.every((card) => (card as HTMLElement).dataset['status'] === 'ready')), { timeout: 60_000 }).toBe(true);
  await expect(page.getByTestId('chart-chart_4').getByRole('heading')).toHaveText('Vertical rate (ft/min)');
  expect(new URL(page.url()).searchParams.get('sample')).toBe('flights');

  await expectNoProblems(page, problems);
});

test('/?sample=flights: pan → charts and grid follow; brush → fewer aircraft; scrub → they move; select → track and details', async ({ page }) => {
  const problems = await watchProblems(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./?sample=flights');
  await expectEngineWithParquet(problems);
  const map = page.getByTestId('map-map_1');
  const view = page.getByTestId('map-view');
  const aircraft = async () => Number((await map.getAttribute('data-aircraft')) ?? 0);
  await expect(page.getByTestId('time-bar')).toHaveAttribute('data-mode', 'playing', { timeout: 60_000 });
  await expect(view).toHaveAttribute('data-state', 'ready');
  await expect.poll(aircraft, { timeout: 60_000 }).toBeGreaterThan(20);
  // Hold T near 23:46 (busy traffic): Pause, End (23:57:59.99), then six Page Downs of 2 minutes.
  await page.getByTestId('time-play').click();
  await expect(page.getByTestId('time-bar')).toHaveAttribute('data-mode', 'paused');
  const slider = page.getByRole('slider', { name: 'Time shown on the map' });
  await slider.focus();
  await page.keyboard.press('End');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('PageDown');
  await expect(slider).toHaveAttribute('aria-valuetext', /^23:45:59 UTC/);
  await expect.poll(async () => Number(await map.getAttribute('data-clock'))).toBe(Date.parse('2026-11-09T23:45:59.990Z'));

  // "Filter to map view" is on: the box the map shows filters the grid (a chip says so) and the charts.
  await expect(page.getByTestId('map-map_1-filter')).toBeChecked();
  // The chip is short ("Map view"); its accessible name and tooltip carry the box.
  await expect(page.getByTestId('filter-map-map_1')).toHaveText('Map view×');
  await expect(page.getByTestId('filter-map-map_1')).toHaveAttribute('aria-label', /^Filter Bay Area traffic view \d+\.\d{3}–\d+\.\d{3}°N, /);
  const rowsBefore = await shownRows(page);
  expect(rowsBefore).toBeLessThan(TOTAL_ROWS);
  const chip = (await page.getByTestId('filter-map-map_1').getAttribute('aria-label')) ?? '';

  // Pan the map: every other view repaints with the new box (timed like a brush).
  const canvas = view.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no map canvas');
  let before = await measureCount(page, CROSSFILTER_MEASURE);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(box.x + box.width * (0.5 - 0.04 * step), box.y + box.height * 0.5);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  const panned = (await nextMeasure(page, CROSSFILTER_MEASURE, before, 'map:map_1')) as { duration: number; detail: CrossfilterMeasureDetail };
  expect(panned.detail.views.map((v) => v.view).sort()).toEqual(['chart:chart_2', 'chart:chart_3', 'chart:chart_4', 'grid:count', 'grid:rows']);
  await expect(page.getByTestId('filter-map-map_1')).not.toHaveAttribute('aria-label', chip);
  await expect.poll(() => shownRows(page)).not.toBe(rowsBefore);
  expect(panned.detail.rowCount).toBe(await shownRows(page));

  // Brush the altitude histogram above 10,000 ft: the map shows fewer aircraft (its latest fixes), and repaints.
  const all = await aircraft();
  const histogram = page.getByTestId('chart-chart_2-chart-canvas');
  await histogram.scrollIntoViewIfNeeded();
  const plot = await histogram.boundingBox();
  if (!plot) throw new Error('no histogram');
  before = await measureCount(page, CROSSFILTER_MEASURE);
  const y = plot.y + plot.height * 0.5;
  await page.mouse.move(plot.x + plot.width * 0.3, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(plot.x + plot.width * (0.3 + 0.05 * step), y);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  const brushed = (await nextMeasure(page, CROSSFILTER_MEASURE, before, 'chart_2')) as { duration: number; detail: CrossfilterMeasureDetail };
  expect(brushed.detail.views.map((v) => v.view)).toContain('map:map_1');
  await expect.poll(aircraft).toBeLessThan(all);
  expect(await aircraft()).toBeGreaterThan(0);
  await expect(page.getByTestId('filter-altBaroFt')).toBeVisible();

  // Scrub back two minutes: T moves, the aircraft are drawn elsewhere.
  await canvas.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1_200);
  const shotBefore = await canvas.screenshot();
  await slider.focus();
  before = await measureCount(page, TIME_SEEK_MEASURE);
  await page.keyboard.press('PageDown');
  await nextMeasure(page, TIME_SEEK_MEASURE, before);
  await expect.poll(async () => Number(await map.getAttribute('data-clock'))).toBe(Date.parse('2026-11-09T23:43:59.990Z'));
  await page.waitForTimeout(1_200);
  expect((await canvas.screenshot()).equals(shotBefore)).toBe(false);

  // Clear the brush (Undo), then click an aircraft: its track and its details appear.
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('filter-altBaroFt')).toHaveCount(0);
  await page.waitForTimeout(1_500);
  const pixels = await glyphPixels(page, canvas);
  expect(pixels.length).toBeGreaterThan(20);
  const [px, py] = pixels[Math.floor(pixels.length / 2)] ?? [0, 0];
  await page.mouse.click(box.x + px, box.y + py);
  const details = page.getByTestId('map-map_1-details');
  await expect(details).toBeVisible();
  await expect(details).toContainText('Callsign');
  await expect(details).toContainText('Registration');
  await expect(details).toContainText(/Last seen\s*\d\d:\d\d:\d\d UTC/);
  await expect(page.getByTestId('map-map_1-details-track')).toHaveText(/^[1-9][\d,]* points? to this time$/);
  await expect.poll(async () => Number((await view.getAttribute('data-track')) ?? 0)).toBeGreaterThan(1);
  const hex = await details.getAttribute('data-hex');
  await expect(page.getByTestId('map-map_1-selection')).toContainText('Selected ');
  await page.screenshot({ path: test.info().outputPath('flights-selected.png') });
  // Back a minute: its track is shorter (up to T only).
  const points = Number(await view.getAttribute('data-track'));
  await slider.focus();
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await details.count()) === 0 || Number(await view.getAttribute('data-track')) < points).toBe(true);
  // Escape on the map, or the details' close button, clears it.
  if ((await details.count()) > 0) {
    await page.getByRole('button', { name: /^Clear the selection of / }).click();
    await expect(details).toHaveCount(0);
  }
  expect(hex).toMatch(/^[0-9a-f~]+$/);
  // Remove the map's filter by its switch: back to every row.
  await page.getByTestId('map-map_1-filter').uncheck();
  await expect(page.getByTestId('filter-map-map_1')).toHaveCount(0);
  await expect.poll(() => shownRows(page)).toBe(TOTAL_ROWS);
  await expectNoProblems(page, problems);
});

test('/?sample=flights: removing the map card, undoing it, undoing the workspace and opening a CSV keep the app running', async ({ page }) => {
  const problems = await watchProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?sample=flights');
  await expectEngineWithParquet(problems);
  const view = page.getByTestId('map-view');
  const aircraft = async () => Number((await view.getAttribute('data-aircraft')) ?? 0);
  await expect(view).toHaveAttribute('data-state', 'ready');
  await expect.poll(aircraft, { timeout: 60_000 }).toBeGreaterThan(0);

  // Remove the map card: MapLibre is torn down, the rest of the workspace stays.
  await page.getByTestId('map-map_1-remove').click();
  await expect(page.getByTestId('map-map_1')).toHaveCount(0);
  await expect(page.getByTestId('app')).toBeVisible();
  await expect(page.getByTestId('file-name')).toHaveText('flight_states');
  await expect(page.locator('section.gg-chart-card')).toHaveCount(3);
  await expect(page.getByTestId('maps-failed')).toHaveCount(0);
  // A few seconds of playback later, still running and nothing thrown.
  await expect.poll(() => shownRows(page), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(2_500);
  await expect(page.getByTestId('app')).toBeVisible();
  expect(problems.list).toEqual([]);

  // Undo: the map is back, loaded again, with aircraft.
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('map-map_1')).toBeVisible();
  await expect(view).toHaveAttribute('data-state', 'ready');
  await expect.poll(aircraft, { timeout: 60_000 }).toBeGreaterThan(0);

  // Undo the flights workspace itself (Ctrl+Z): the start screen, not a blank page.
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByTestId('map-view')).toHaveCount(0);
  await page.getByTestId('redo').click();
  await expect(view).toHaveAttribute('data-state', 'ready');

  // Open a CSV over the flights workspace: the map goes with the old table.
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('open-csv').click();
  await (await chooser).setFiles({ name: 'tiny.csv', mimeType: 'text/csv', buffer: Buffer.from('id,name\n1,ada\n2,grace\n') });
  await expect(page.getByTestId('file-name')).toHaveText('tiny.csv');
  await expect.poll(() => shownRows(page)).toBe(2);
  await expect(page.getByTestId('map-view')).toHaveCount(0);
  await expectNoProblems(page, problems);
});
