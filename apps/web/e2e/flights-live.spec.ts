import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectNoProblems, watchProblems } from './support';

/*
 * `?live=1` against a stand-in for the portfolio's relay (e2e/serve.ts,
 * GLASSGRID_E2E_RELAY): the feed's states as the map card and the top bar
 * show them (live, retrying, rate-limited, offline), and offline → replay
 * (milestone L5): the offer after three failures, "Keep trying", recovery,
 * a 429 with a long Retry-After, the switch to the recorded traffic (and
 * the choice kept across a reload in the tab), and "Back to live" once a
 * probe of the relay finds fresh data again. Browser-agnostic: the relay
 * is scripted on the server, offline is Playwright's `setOffline`.
 *
 * Slow by nature: the feed never polls more than once per 10 s (20 s when
 * healthy), so the whole story takes about two minutes.
 */

type RelayMode = 'none' | 'ok' | 'stale' | 'fail' | '429';

async function relay(request: APIRequestContext, baseURL: string | undefined, body: { mode?: RelayMode; retryAfter?: number; reset?: boolean; fixtures?: 'ok' | 'fail' }): Promise<void> {
  const response = await request.post(new URL('/__e2e/relay', baseURL).href, { data: body });
  expect(response.status()).toBe(204);
}

/**
 * Failures these tests provoke on purpose, and only those: the relay's 503 and 429 and its polls while offline, as an
 * HTTP status, a failed request or the console's "Failed to load resource" (which support.ts tags with its URL).
 */
const EXPECTED = /^(?:HTTP (?:429|503) GET |request failed: GET |console\.error: Failed to load resource: .*\()https?:\/\/[^/]+\/api\/flights\b/;
/** The same, and the flight fixture the stand-in fails on purpose (`fixtures: 'fail'`). */
const EXPECTED_WITH_FIXTURE = /^(?:HTTP (?:429|503) (?:GET|HEAD) |request failed: (?:GET|HEAD) |console\.error: Failed to load resource: .*\()https?:\/\/[^/]+(?:\/api\/flights\b|\/(?:glassgrid\/)?samples\/flights\/flights-bay-30min\.parquet)/;

/**
 * Offline, MapLibre may ask for its glyphs again (the basemap's, `map/fonts/…`, not cached as immutable): those fail
 * with the network gone. Only in the tests that go offline, and only that failure.
 */
const OFFLINE_GLYPHS = /^(?:request failed: GET |console\.error: Failed to load resource: net::ERR_INTERNET_DISCONNECTED \()https?:\/\/[^/]+\/(?:glassgrid\/)?map\/fonts\/[^ ]+\.pbf(?: net::ERR_INTERNET_DISCONNECTED|\))$/;
const either = (...patterns: RegExp[]) => new RegExp(patterns.map((pattern) => `(?:${pattern.source})`).join('|'));

/** "Live · 40 aircraft", or "Live · 40 tracked · 34 in view" when some are outside the map's view. */
const LIVE_40 = /^Live · 40 (?:aircraft|tracked · \d+ in view)$/;
const COUNT = '40 (?:aircraft|tracked · \\d+ in view)';

const status = (page: Page) => page.getByTestId('map-map_1-status');
const notice = (page: Page) => page.getByTestId('live-fallback');

test.afterEach(async ({ request, baseURL }) => {
  await relay(request, baseURL, { mode: 'none', fixtures: 'ok', reset: true });
});

test('?live=1: live, three failures → the offer, Keep trying, recovery, a 429 → recorded traffic, kept across a reload, then Back to live', async ({ page, context, request, baseURL }) => {
  test.setTimeout(300_000);
  const problems = await watchProblems(page, { expected: either(EXPECTED, OFFLINE_GLYPHS) });
  await relay(request, baseURL, { mode: 'ok', reset: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./?live=1');

  // Live: the stand-in's 40 aircraft.
  await expect(status(page)).toHaveText(LIVE_40, { timeout: 60_000 });
  await expect(page.getByTestId('file-size')).toHaveText(/ rows · Live$/);
  await expect(notice(page)).toHaveCount(0);

  // The relay fails (503, Retry-After 10): retrying, then after the third failure in a row, the offer. Nothing switches.
  await relay(request, baseURL, { mode: 'fail' });
  await expect(status(page)).toHaveText(new RegExp(`^Retrying in \\d+ s · no data: network ENOTFOUND \\(HTTP 503\\) · ${COUNT}$`), { timeout: 40_000 });
  await expect(notice(page)).toHaveAttribute('data-reason', 'failing', { timeout: 60_000 });
  await expect(notice(page)).toContainText('The live feed has not answered 3 times in a row.');
  // Announced without the count, so the next failure (which updates the strip's text) is not announced again.
  await expect(page.getByTestId('live-fallback-announce')).toHaveText('The live feed is not answering. Recorded traffic is available instead.');
  await expect(page.getByTestId('file-size')).toHaveText(/ rows · Retrying$/);
  await page.screenshot({ path: test.info().outputPath('flights-offer.png') });
  await page.getByTestId('live-fallback-keep-trying').click();
  await expect(notice(page)).toHaveCount(0);
  // The button went away with the strip: focus is on the map card, not the page's body.
  await expect(page.getByTestId('map-map_1')).toBeFocused();

  // It recovers on its own.
  await relay(request, baseURL, { mode: 'ok' });
  await expect(status(page)).toHaveText(LIVE_40, { timeout: 40_000 });

  // Rate-limited with a two-minute Retry-After: its own state, and the offer at once.
  await relay(request, baseURL, { mode: '429', retryAfter: 120 });
  await expect(status(page)).toHaveText(new RegExp(`^Rate-limited · retrying in \\d+ s · ${COUNT}$`), { timeout: 40_000 });
  await expect(page.getByTestId('map-map_1-feed')).toHaveText(/rate-limited/);
  await expect(notice(page)).toHaveAttribute('data-reason', 'rate-limited');
  const { requests: beforeSwitch } = (await (await request.get(new URL('/__e2e/relay', baseURL).href)).json()) as { requests: number };

  // One click: the recorded half hour, playing from its first fix; the choice is kept for the tab.
  await page.getByTestId('live-fallback-watch-recorded').click();
  await expect(page.getByTestId('file-size')).toHaveText('71,595 rows · Recorded', { timeout: 60_000 });
  await expect(notice(page)).toHaveAttribute('data-mode', 'recorded');
  await expect(notice(page)).toBeFocused();
  await expect(notice(page)).toContainText('Showing recorded traffic');
  await expect(page.getByTestId('time-bar')).toHaveAttribute('data-mode', 'playing', { timeout: 30_000 });
  await expect.poll(async () => Number(await page.getByTestId('map-map_1').getAttribute('data-clock')), { timeout: 30_000 }).toBeLessThan(Date.parse('2026-11-09T23:40:00.000Z'));
  expect(await page.evaluate(() => sessionStorage.getItem('glassgrid.flights.choice'))).toBe('recorded');
  // The live source stopped polling (the recording replaced it).
  await page.waitForTimeout(2_000);
  const { requests: afterSwitch } = (await (await request.get(new URL('/__e2e/relay', baseURL).href)).json()) as { requests: number };
  expect(afterSwitch).toBe(beforeSwitch);

  // A reload of ?live=1 in this tab opens the recording at once, and says why.
  await page.reload();
  await expect(page.getByTestId('file-size')).toHaveText('71,595 rows · Recorded', { timeout: 60_000 });
  await expect(notice(page)).toHaveAttribute('data-mode', 'recorded');
  expect(new URL(page.url()).searchParams.get('live')).toBe('1');
  await expect(page.getByTestId('live-fallback-back-to-live')).toHaveCount(0);
  // ... and it is the whole recording, drawn and playing.
  await expect(page.getByTestId('time-bar')).toHaveAttribute('data-mode', 'playing', { timeout: 60_000 });
  await expect.poll(async () => Number((await page.getByTestId('map-map_1').getAttribute('data-aircraft')) ?? 0), { timeout: 60_000 }).toBeGreaterThan(20);
  await expect(page.getByTestId('time-range')).toHaveText('Data: Nov 9, 2026, 23:27:00–23:57:59 UTC (31 min)');

  // The relay is back. Offline, then online again: the page probes it at once and offers the way back.
  await relay(request, baseURL, { mode: 'ok' });
  await context.setOffline(true);
  await expect(notice(page)).toContainText('You are offline.');
  await context.setOffline(false);
  await expect(page.getByTestId('live-fallback-back-to-live')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('live-fallback-announce')).toHaveText('Live data is available again.');
  await page.screenshot({ path: test.info().outputPath('flights-back-to-live.png') });
  await page.getByTestId('live-fallback-back-to-live').click();
  await expect(status(page)).toHaveText(LIVE_40, { timeout: 60_000 });
  await expect(notice(page)).toHaveCount(0);
  await expect(page.getByTestId('map-map_1')).toBeFocused();
  await expect(page.getByTestId('time-bar')).toHaveAttribute('data-mode', 'live');
  expect(await page.evaluate(() => sessionStorage.getItem('glassgrid.flights.choice'))).toBeNull();
  await expectNoProblems(page, problems);
});

test('?live=1: offline is said at once and offers the recording; back online, the offer goes', async ({ page, context, request, baseURL }) => {
  test.setTimeout(120_000);
  const problems = await watchProblems(page, { expected: either(EXPECTED, OFFLINE_GLYPHS) });
  await relay(request, baseURL, { mode: 'ok', reset: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./?live=1');
  await expect(status(page)).toHaveText(LIVE_40, { timeout: 60_000 });
  await context.setOffline(true);
  await expect(status(page)).toHaveText(new RegExp(`^Offline · retrying in \\d+ s · ${COUNT}$`));
  await expect(page.getByTestId('file-size')).toHaveText(/ rows · Offline$/);
  await expect(notice(page)).toHaveAttribute('data-reason', 'offline');
  await expect(page.getByTestId('map-map_1-feed')).toContainText('You are offline');
  await context.setOffline(false);
  await expect(notice(page)).toHaveCount(0);
  await expect(status(page)).toHaveText(LIVE_40, { timeout: 60_000 });
  await expectNoProblems(page, problems);
});

test('?live=1: offline before choosing, the recording still loads (it was fetched ahead when the live feed started)', async ({ page, context, request, baseURL }) => {
  test.setTimeout(120_000);
  const problems = await watchProblems(page, { expected: either(EXPECTED, OFFLINE_GLYPHS) });
  await relay(request, baseURL, { mode: 'ok', reset: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./?live=1');
  await expect(status(page)).toHaveText(LIVE_40, { timeout: 60_000 });
  // The live start fetched the 30-minute fixture into memory.
  await expect.poll(async () => ((await (await request.get(new URL('/__e2e/relay', baseURL).href)).json()) as { fixtureRequests: number }).fixtureRequests, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1_000);
  await context.setOffline(true);
  await expect(notice(page)).toHaveAttribute('data-reason', 'offline');
  await page.getByTestId('live-fallback-watch-recorded').click();
  await expect(page.getByTestId('file-size')).toHaveText('71,595 rows · Recorded', { timeout: 60_000 });
  await expect(notice(page)).toHaveAttribute('data-recorded', 'shown');
  await expect(notice(page)).toContainText('Showing recorded traffic');
  await expect.poll(async () => Number((await page.getByTestId('map-map_1').getAttribute('data-aircraft')) ?? 0), { timeout: 60_000 }).toBeGreaterThan(20);
  expect(await page.evaluate(() => sessionStorage.getItem('glassgrid.flights.choice'))).toBe('recorded');
  await page.screenshot({ path: test.info().outputPath('flights-offline-recorded.png') });
  await context.setOffline(false);
  await expectNoProblems(page, problems);
});

test('?live=1: when the recording could not be fetched ahead, offline it says it did not load, keeps no choice, and loads once back online', async ({ page, context, request, baseURL }) => {
  test.setTimeout(120_000);
  const problems = await watchProblems(page, { expected: either(EXPECTED_WITH_FIXTURE, OFFLINE_GLYPHS) });
  await relay(request, baseURL, { mode: 'ok', fixtures: 'fail', reset: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./?live=1');
  await expect(status(page)).toHaveText(LIVE_40, { timeout: 60_000 });
  await expect.poll(async () => ((await (await request.get(new URL('/__e2e/relay', baseURL).href)).json()) as { fixtureRequests: number }).fixtureRequests, { timeout: 30_000 }).toBeGreaterThan(0);
  await relay(request, baseURL, { fixtures: 'ok' });
  await context.setOffline(true);
  await expect(notice(page)).toHaveAttribute('data-reason', 'offline');
  await page.getByTestId('live-fallback-watch-recorded').click();
  await expect(notice(page)).toHaveAttribute('data-recorded', 'failed', { timeout: 30_000 });
  await expect(notice(page)).toContainText('The recorded traffic didn’t load');
  await expect(notice(page)).toContainText('It will try again when you are back online.');
  await expect(notice(page)).not.toContainText('Showing recorded traffic');
  await expect(page.getByTestId('live-fallback-announce')).toHaveText('The recorded traffic didn’t load. It will try again when you are back online.');
  expect(await page.evaluate(() => sessionStorage.getItem('glassgrid.flights.choice'))).toBeNull();
  await page.screenshot({ path: test.info().outputPath('flights-offline-failed.png') });
  // Back online: tried again, and this time it loads (and is remembered).
  await context.setOffline(false);
  await expect(page.getByTestId('file-size')).toHaveText('71,595 rows · Recorded', { timeout: 60_000 });
  await expect(notice(page)).toHaveAttribute('data-recorded', 'shown');
  expect(await page.evaluate(() => sessionStorage.getItem('glassgrid.flights.choice'))).toBe('recorded');
  await expectNoProblems(page, problems);
});
