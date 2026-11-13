import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CROSSFILTER_MEASURE, TIME_SEEK_MEASURE, type CrossfilterMeasureDetail, type TimeSeekMeasureDetail } from '@glassgrid/app/perf';
import { expectEngineWithParquet, watchProblems } from './support';
import { BENCHMARK_DIR } from './results';

/*
 * L4's exit gate (docs/live-flights-l4.md), in the style of the M3
 * cross-filter harness (apps/desktop/e2e/crossfilter.spec.ts): the flights
 * workspace on the production build with the production headers, the time
 * cursor paused at 23:45 UTC, then
 *
 * - brushes: 20 mouse brushes over the altitude histogram (pointer down
 *   builds the cubes, a 300 ms drag, release), each timed from release to
 *   the last other view painted: the map (its latest fixes and trails),
 *   the category and vertical-rate charts, the grid's count and first page
 *   (`glassgrid:crossfilter`, the app's CrossfilterTracker);
 * - pans: 20 drags of the map, each timed from the viewport's report (200 ms
 *   after moveend) to every other view painted (the same measure, source
 *   `map:map_1`);
 * - seeks: 20 keyboard steps of the time scrubber (Page Up / Page Down),
 *   each timed from the `setTime` to the map painted as of the new T
 *   (`glassgrid:time-seek`);
 *
 * first with the 30-minute fixture loaded whole (71,595 fixes), then after
 * "Load full day" (1,456,777), whose load time and the renderer's memory
 * (the engine worker runs in it) before and after are recorded too.
 *
 *   GLASSGRID_E2E_FLIGHTS_PERF=1 pnpm --filter @glassgrid/web exec playwright test e2e/flights-perf.spec.ts
 *   GLASSGRID_E2E_FLIGHTS_PERF_ROUNDS=30                                    # per kind (default 20)
 *
 * Writes e2e-results/flights-perf-chromium-<os>-<arch>.json (BENCHMARK_DIR, kept across runs). Skipped in the
 * ordinary `pnpm e2e:web` (it measures; it does not check behaviour).
 */

const ENABLED = process.env['GLASSGRID_E2E_FLIGHTS_PERF'] === '1';
const ROUNDS = Math.max(3, Number(process.env['GLASSGRID_E2E_FLIGHTS_PERF_ROUNDS'] ?? 20) || 20);
const BUDGET_P95_MS = 100;
/** A comma-separated subset of `flights-bay-30min,flights-bay-day` (default both; the day is loaded after the 30 minutes). */
const FIXTURES = (process.env['GLASSGRID_E2E_FLIGHTS_PERF_FIXTURES'] ?? 'flights-bay-30min,flights-bay-day').split(',');

test.skip(!ENABLED, 'benchmark: set GLASSGRID_E2E_FLIGHTS_PERF=1');
// The JSON is named and compared as Chromium's (and reads Chromium's renderer processes); other browsers are not benchmarked.
test.skip(({ browserName }) => browserName !== 'chromium', 'benchmark: Chromium only (its numbers are the recorded baseline)');

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (rank - lo);
}

const summary = (values: readonly number[]) => ({
  count: values.length,
  p50: +percentile(values, 50).toFixed(1),
  p95: +percentile(values, 95).toFixed(1),
  max: values.length ? +Math.max(...values).toFixed(1) : Number.NaN,
});

/** Resident memory of Chromium's renderer processes (Linux), MB. The page's engine worker runs in its renderer. */
function rendererRssMb(): number | null {
  if (platform() !== 'linux') return null;
  let kb = 0;
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmdline.includes('--type=renderer')) continue;
      const rss = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      kb += Number(rss?.[1] ?? 0);
    } catch {
      // gone meanwhile
    }
  }
  return Math.round(kb / 1024);
}

async function measureCount(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => performance.getEntriesByName(n, 'measure').length, name);
}

async function nextMeasure(page: Page, name: string, previous: number, source?: string): Promise<{ duration: number; detail: unknown }> {
  const handle = await page.waitForFunction(
    ({ n, previous: before, source: from }) => {
      const entries = (performance.getEntriesByName(n, 'measure') as PerformanceMeasure[]).slice(before);
      const hit = entries.find((entry) => from === undefined || (entry.detail as { source?: string } | null)?.source === from);
      return hit ? { duration: hit.duration, detail: hit.detail as unknown } : null;
    },
    { n: name, previous, source },
    { timeout: 60_000, polling: 10 },
  );
  return (await handle.jsonValue()) as { duration: number; detail: unknown };
}

interface Round {
  ms: number;
  rowCount: number | null;
  views: CrossfilterMeasureDetail['views'];
}

/** `rounds` brushes; consecutive ones always differ (an unchanged snapped brush changes nothing and is not timed). */
async function brushes(page: Page, rounds: number, offset = 0): Promise<Round[]> {
  const canvas = page.getByTestId('chart-chart_2-chart-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no histogram');
  const out: Round[] = [];
  for (let n = 0; n < rounds; n += 1) {
    const i = n + offset;
    // Starts across the first half of the plot, 4 to 34 % wide (a few select little or nothing), a new pair every
    // round (golden-ratio steps), so no brush is answered from the result cache.
    const from = 0.04 + ((i * 0.618_034) % 1) * 0.45;
    const width = 0.04 + ((i * 0.414_214 + 0.2) % 1) * 0.3;
    const y = box.y + box.height * 0.5;
    const before = await measureCount(page, CROSSFILTER_MEASURE);
    await page.mouse.move(box.x + box.width * from, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(box.x + box.width * (from + (width * step) / 10), y);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    const { duration, detail } = (await nextMeasure(page, CROSSFILTER_MEASURE, before, 'chart_2')) as { duration: number; detail: CrossfilterMeasureDetail };
    out.push({ ms: duration, rowCount: detail.rowCount, views: detail.views });
    await page.waitForTimeout(300);
  }
  return out;
}

async function pans(page: Page, rounds: number): Promise<Round[]> {
  const canvas = page.locator('.gg-map canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no map');
  const out: Round[] = [];
  for (let i = 0; i < rounds; i += 1) {
    const dx = (i % 2 === 0 ? -1 : 1) * box.width * (0.12 + (i % 3) * 0.04);
    const dy = (i % 4 < 2 ? -1 : 1) * box.height * 0.05;
    const before = await measureCount(page, CROSSFILTER_MEASURE);
    const x = box.x + box.width * 0.5;
    const y = box.y + box.height * 0.5;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(x + (dx * step) / 8, y + (dy * step) / 8);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    const { duration, detail } = (await nextMeasure(page, CROSSFILTER_MEASURE, before, 'map:map_1')) as { duration: number; detail: CrossfilterMeasureDetail };
    out.push({ ms: duration, rowCount: detail.rowCount, views: detail.views });
    await page.waitForTimeout(300);
  }
  return out;
}

async function seeks(page: Page, rounds: number): Promise<{ ms: number; engineMs: number }[]> {
  const slider = page.getByTestId('time-slider');
  await slider.scrollIntoViewIfNeeded();
  await slider.focus();
  const out: { ms: number; engineMs: number }[] = [];
  for (let i = 0; i < rounds; i += 1) {
    const before = await measureCount(page, TIME_SEEK_MEASURE);
    // Back and forth by one page, then further back each time, so most seeks reach a T not queried before.
    await page.keyboard.press(i % 2 === 0 ? 'PageDown' : 'ArrowUp');
    const { duration, detail } = (await nextMeasure(page, TIME_SEEK_MEASURE, before)) as { duration: number; detail: TimeSeekMeasureDetail };
    out.push({ ms: duration, engineMs: detail.engineMs });
    await page.waitForTimeout(300);
  }
  return out;
}

/** Pause the cursor and move T to 23:45:00 UTC (both fixtures have it), by the slider's keys. */
async function pauseAt2345(page: Page): Promise<void> {
  const bar = page.getByTestId('time-bar');
  if ((await bar.getAttribute('data-mode')) === 'playing') await page.getByTestId('time-play').click();
  const target = Date.parse('2026-11-09T23:45:00.000Z');
  const slider = page.getByTestId('time-slider');
  await slider.focus();
  await page.keyboard.press('End');
  for (let i = 0; i < 400; i += 1) {
    const at = Number(await bar.getAttribute('data-at'));
    if (at <= target) break;
    await page.keyboard.press('ArrowLeft');
  }
  await page.waitForTimeout(1_500);
}

const results: Record<string, unknown> = {};

test('flights workspace: brush, pan and seek timings on the 30-minute and the day fixture', async ({ page }) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const problems = await watchProblems(page);
  const rssStart = rendererRssMb();
  await page.goto('./?sample=flights');
  await expectEngineWithParquet(problems);
  const map = page.getByTestId('map-map_1');
  await expect(page.getByTestId('time-bar')).toHaveAttribute('data-mode', 'playing', { timeout: 60_000 });
  await expect.poll(async () => Number((await map.getAttribute('data-aircraft')) ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);

  for (const fixture of ['flights-bay-30min', 'flights-bay-day'] as const) {
    if (!FIXTURES.includes(fixture)) continue;
    let load: { ms: number; rssBeforeMb: number | null; rssAfterMb: number | null } | null = null;
    if (fixture === 'flights-bay-day') {
      const rssBeforeMb = rendererRssMb();
      const started = Date.now();
      await page.getByTestId('time-load-day').click();
      await expect(page.getByTestId('time-range')).toContainText('00:00:00–23:59:59', { timeout: 120_000 });
      await expect(page.getByTestId('file-size')).toHaveText(/^1,456,777 rows · Recorded$/, { timeout: 120_000 });
      load = { ms: Date.now() - started, rssBeforeMb, rssAfterMb: rendererRssMb() };
      console.info(`[flights-perf] day loaded in ${load.ms} ms; renderer RSS ${rssBeforeMb} -> ${load.rssAfterMb} MB`);
    }
    await pauseAt2345(page);
    const warm = await brushes(page, 1);
    const brushRounds = await brushes(page, ROUNDS, 1);
    const panRounds = await pans(page, ROUNDS);
    const seekRounds = await seeks(page, ROUNDS);
    const perView = (rounds: Round[]) => {
      const views = new Map<string, { ms: number[]; engineMs: number[] }>();
      for (const round of rounds) {
        for (const view of round.views) {
          const entry = views.get(view.view) ?? { ms: [], engineMs: [] };
          entry.ms.push(view.ms);
          entry.engineMs.push(view.engineMs);
          views.set(view.view, entry);
        }
      }
      return Object.fromEntries([...views].map(([view, values]) => [view, { ...summary(values.ms), engineMs: summary(values.engineMs) }]));
    };
    const raw = (rounds: Round[]) => rounds.map((round) => ({ ms: +round.ms.toFixed(1), rows: round.rowCount, views: round.views.map((v) => `${v.view} ${v.ms.toFixed(0)}/${v.engineMs.toFixed(0)}${v.fromCube ? ' cube' : ''}${v.cached ? ' cached' : ''}`) }));
    results[fixture] = {
      load,
      rssMb: rendererRssMb(),
      firstBrushMs: warm[0]?.ms,
      brush: {
        ...summary(brushRounds.map((r) => r.ms)),
        // The gate as L4's plan words it: the map and the charts repainted (the grid's count and first page aside).
        mapAndCharts: summary(brushRounds.map((r) => Math.max(...r.views.filter((v) => v.view.startsWith('map:') || v.view.startsWith('chart:')).map((v) => v.ms)))),
        perView: perView(brushRounds), fromCube: brushRounds.reduce((n, r) => n + r.views.filter((v) => v.fromCube).length, 0), rounds: raw(brushRounds) },
      pan: { ...summary(panRounds.map((r) => r.ms)), perView: perView(panRounds), rounds: raw(panRounds) },
      seek: { ...summary(seekRounds.map((r) => r.ms)), engineMs: summary(seekRounds.map((r) => r.engineMs)) },
    };
    console.info(`[flights-perf] ${fixture}:`, JSON.stringify({ brush: summary(brushRounds.map((r) => r.ms)), pan: summary(panRounds.map((r) => r.ms)), seek: summary(seekRounds.map((r) => r.ms)) }));
    // Every brush repainted the map along with the charts and the grid.
    expect(brushRounds.every((round) => round.views.some((view) => view.view === 'map:map_1'))).toBe(true);
  }

  const dir = BENCHMARK_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `flights-perf-chromium-${platform()}-${arch()}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        budgetP95Ms: BUDGET_P95_MS,
        machine: { platform: platform(), arch: arch(), cpus: cpus().length, cpu: cpus()[0]?.model, memoryGb: Math.round(totalmem() / 1024 ** 3), loadAvg: loadavg() },
        browser: page.context().browser()?.version(),
        conditions:
          'production build and headers, 1440x1000 CSS px, DPR 1, headless Chromium (SwiftShader WebGL), DuckDB-WASM in the page worker; T paused at 23:45 UTC; "Filter to map view" on; brushes on the altitude histogram (cubes prepared at pointer down); 300 ms between rounds',
        rssStartMb: rssStart,
        ...results,
      },
      null,
      2,
    )}\n`,
  );
  console.info(`[flights-perf] wrote ${file}`);
});
