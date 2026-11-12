import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { BASE, expectEngineWithParquet, expectNoProblems, watchProblems } from './support';

/*
 * The flights workspace for keyboard and screen-reader users (milestone L5,
 * docs/live-flights.md), on the recorded traffic (`?sample=flights`): axe
 * finds nothing with the aircraft list hidden and shown, in both themes;
 * the list mirrors what the map draws (the aircraft in its view, by
 * callsign); selecting a row selects the aircraft on the map and the
 * reverse; Tab reaches the scrubber, the map, the switch and the list, and
 * arrow keys move within the list. Browser-agnostic: DOM, keyboard and
 * pointer only.
 */

async function axe(page: Page, name: string): Promise<{ id: string; impact: string | null | undefined; nodes: string[] }[]> {
  const results = await new AxeBuilder({ page }).analyze();
  await test.info().attach(`axe-${name}`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  return results.violations.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.map((node) => `${node.target.join(' ')}: ${node.failureSummary ?? ''}`) }));
}

/** Opens the recorded traffic, paused at 23:45:59 UTC (busy, and still): the list then holds still too. */
async function openPaused(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./?sample=flights');
  const map = page.getByTestId('map-map_1');
  await expect(page.getByTestId('time-bar')).toHaveAttribute('data-mode', 'playing', { timeout: 60_000 });
  await expect(page.getByTestId('map-view')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  await page.getByTestId('time-play').click();
  const slider = page.getByRole('slider', { name: 'Time shown on the map' });
  await slider.focus();
  await page.keyboard.press('End');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('PageDown');
  await expect(slider).toHaveAttribute('aria-valuetext', /^23:45:59 UTC/);
  // The map's snapshot is the one at T (not one of the seeks on the way there).
  await expect.poll(async () => Number(await map.getAttribute('data-clock')), { timeout: 60_000 }).toBe(Date.parse('2026-11-09T23:45:59.990Z'));
  await expect.poll(async () => Number(await map.getAttribute('data-aircraft')), { timeout: 60_000 }).toBeGreaterThan(20);
  // Every chart drawn, so axe sees the page as a person would.
  await expect.poll(() => page.locator('section.gg-chart-card').evaluateAll((cards) => cards.length === 3 && cards.every((card) => (card as HTMLElement).dataset['status'] === 'ready')), { timeout: 60_000 }).toBe(true);
}

const listGrid = (page: Page) => page.getByRole('grid', { name: 'Aircraft in view: Bay Area traffic' });

// The page's DOM and ARIA do not depend on where the demo is served: run once, at the root. (flights-live.spec.ts does
// run under /glassgrid/ too: there the relay is outside the app's base, as in production.)
test.skip(BASE !== '/', 'the same DOM and ARIA under any base: run at the root only');

test('/?sample=flights: axe finds nothing with the aircraft list hidden and shown, light and dark', async ({ page }) => {
  const problems = await watchProblems(page);
  await openPaused(page);
  await expectEngineWithParquet(problems);
  const list = page.getByTestId('map-map_1-list');
  await expect(list).toHaveAttribute('data-visible', 'false');
  // Hidden from sight, present for screen readers.
  await expect(listGrid(page)).toBeAttached();
  expect(await list.boundingBox().then((box) => (box?.width ?? 0) <= 1)).toBe(true);
  expect(await axe(page, 'list-hidden')).toEqual([]);

  await page.getByTestId('map-map_1-list-toggle').click();
  await expect(page.getByTestId('map-map_1-list-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(list).toHaveAttribute('data-visible', 'true');
  await expect(listGrid(page)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('flights-list-light.png') });
  expect(await axe(page, 'list-shown')).toEqual([]);

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-gg-theme', 'dark');
  await page.screenshot({ path: test.info().outputPath('flights-list-dark.png') });
  expect(await axe(page, 'list-shown-dark')).toEqual([]);
  await page.getByTestId('map-map_1-list-toggle').click();
  expect(await axe(page, 'list-hidden-dark')).toEqual([]);
  await expectNoProblems(page, problems);
});

test('/?sample=flights: the list mirrors the map (in view, by callsign); selection goes both ways; Tab and arrow keys get everywhere', async ({ page }) => {
  const problems = await watchProblems(page);
  await openPaused(page);
  const map = page.getByTestId('map-map_1');
  const grid = listGrid(page);
  const rows = grid.locator('tbody tr');

  // The rows are the aircraft the map draws inside its view: no more than it shows, and ordered by callsign.
  const drawn = Number(await map.getAttribute('data-aircraft'));
  await expect.poll(() => rows.count()).toBeGreaterThan(10);
  expect(await rows.count()).toBeLessThanOrEqual(drawn);
  expect(await grid.getAttribute('aria-rowcount')).toBe(String((await rows.count()) + 1));
  const callsigns = await rows.evaluateAll((trs) => trs.map((tr) => tr.querySelector('td')?.textContent ?? ''));
  const named = callsigns.filter((c) => !c.startsWith('None ('));
  expect(named).toEqual([...named].sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })));
  // Zoom in on the map: fewer aircraft in view, fewer rows (the map's own count, of every aircraft it was given, stays).
  await expect.poll(() => rows.count()).toBe(Number(await page.getByTestId('map-map_1').locator('.map-card__list-count').textContent().then((t) => (t ?? '').replace(/\D/g, ''))));
  const before = await rows.count();
  const canvas = page.getByTestId('map-view').locator('canvas');
  await canvas.focus();
  await page.keyboard.press('Equal');
  await page.keyboard.press('Equal');
  await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeLessThan(before);

  // Where the card and the chart below it are, before focus enters the hidden list (and after: unchanged).
  const layout = () =>
    page.evaluate(() => {
      const box = (selector: string) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect ? [Math.round(rect.top), Math.round(rect.height)] : null;
      };
      return { card: box('[data-testid="map-map_1"]'), chart: box('[data-testid="chart-chart_2"]') };
    });
  const laidOut = await layout();

  // Tab order through the card: the switch, Remove, the scrubber's slider and buttons, the map, then the list.
  await page.getByTestId('map-map_1-filter').focus();
  const reached: string[] = [];
  for (let i = 0; i < 16 && !reached.includes('list'); i += 1) {
    await page.keyboard.press('Tab');
    reached.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return 'none';
        if (el.getAttribute('role') === 'slider') return 'slider';
        if (el.tagName === 'CANVAS' && el.closest('[data-testid="map-view"]')) return 'map';
        if (el.closest('[data-testid="map-map_1-list"]')) return 'list';
        return el.dataset['testid'] ?? el.tagName.toLowerCase();
      }),
    );
  }
  expect(reached).toContain('slider');
  expect(reached.indexOf('map')).toBeGreaterThan(reached.indexOf('slider'));
  expect(reached.indexOf('list')).toBeGreaterThan(reached.indexOf('map'));
  // Focus inside the hidden list shows it (no invisible focus), over the map: nothing on the page moves.
  await expect(page.getByTestId('map-map_1-list')).toBeVisible();
  const overlay = await page.getByTestId('map-map_1-list').boundingBox();
  const mapBox = await page.getByTestId('map-view').boundingBox();
  expect(overlay?.height ?? 0).toBeGreaterThan(40);
  expect((overlay?.y ?? 0) + (overlay?.height ?? 0)).toBeLessThanOrEqual((mapBox?.y ?? 0) + (mapBox?.height ?? 0) + 1);
  expect(await layout()).toEqual(laidOut);

  // Arrow keys move within the list; Enter selects that aircraft on the map (its details strip opens).
  const focusedRow = () => page.evaluate(() => document.activeElement?.closest('tr')?.getAttribute('data-hex') ?? null);
  const first = await focusedRow();
  await page.keyboard.press('ArrowDown');
  const second = await focusedRow();
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => (document.activeElement as HTMLTableCellElement | null)?.cellIndex)).toBe(1);
  await page.keyboard.press('Enter');
  const details = page.getByTestId('map-map_1-details');
  await expect(details).toHaveAttribute('data-hex', second ?? '');
  await expect(grid.locator(`tr[data-hex="${second}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('map-map_1-selection')).toContainText('Selected ');
  // Escape in the list clears it.
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await expect(grid.locator('tr[aria-selected="true"]')).toHaveCount(0);

  // The reverse: a row clicked in the shown list, then the map's own Escape, both reach the other side.
  await page.getByTestId('map-map_1-list-toggle').click();
  const third = rows.nth(2);
  const hex = await third.getAttribute('data-hex');
  await third.locator('td').first().click();
  await expect(details).toHaveAttribute('data-hex', hex ?? '');
  await canvas.focus();
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await expect(third).toHaveAttribute('aria-selected', 'false');
  // The count is announced politely (never the rows), once focus is in the list.
  await third.locator('td').first().focus();
  await expect(page.getByTestId('map-map_1-list-count')).toHaveText(/^\d+ aircraft in view$/, { timeout: 15_000 });
  await expect(grid).not.toHaveAttribute('aria-live', /.*/);
  await expectNoProblems(page, problems);
});
