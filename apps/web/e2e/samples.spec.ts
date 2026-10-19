import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CROSSFILTER_MEASURE, type CrossfilterMeasureDetail } from '@glassgrid/app/perf';
import { expectEngineWithParquet, expectNoProblems, shownRows, watchProblems } from './support';

/*
 * The demo's exit gate in Chromium: each sample workspace opens from its
 * shareable link (`/?sample=<id>`) on the production build with the
 * production headers, its charts draw real (non-zero) data from the Parquet
 * file through DuckDB-WASM, a mouse brush cross-filters the other charts and
 * the grid, undo restores, and the grid scrolls deep into the table. No
 * console error, CSP violation, error toast or failed request on the way.
 *
 * Timings (navigation → engine ready, workspace loaded, first and last chart
 * drawn, brush → every view painted) go to test-results/web-demo-timings.json;
 * screenshots to $GLASSGRID_SCREENSHOTS (default test-results/screens).
 */

interface ManifestSample {
  id: string;
  file: string;
  rows: number;
  bytes: number;
}

const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'public', 'samples', 'samples.manifest.json'), 'utf8')) as { samples: ManifestSample[] };
const screens = process.env['GLASSGRID_SCREENSHOTS'] ?? resolve(import.meta.dirname, '..', 'test-results', 'screens');
const timingsFile = resolve(import.meta.dirname, '..', 'test-results', 'web-demo-timings.json');
const timings: Record<string, Record<string, number | string>> = {};

test.afterAll(() => {
  mkdirSync(resolve(timingsFile, '..'), { recursive: true });
  writeFileSync(timingsFile, `${JSON.stringify(timings, null, 2)}\n`);
});

/**
 * Milliseconds since navigation start when the first (`some`) or every (`every`) chart card has drawn
 * rows (checked every animation frame).
 */
async function chartsDrawnAt(page: Page, which: 'some' | 'every'): Promise<number> {
  const handle = await page.waitForFunction(
    (mode) => {
      const cards = [...document.querySelectorAll<HTMLElement>('section.gg-chart-card')];
      const drawn = (card: HTMLElement) => card.dataset['status'] === 'ready' && /^[1-9][\d,]* rows?$/.test(card.querySelector('.gg-chart-card__rows')?.textContent ?? '');
      const done = mode === 'some' ? cards.some(drawn) : cards.length >= 3 && cards.every(drawn);
      return done && performance.now();
    },
    which,
    { polling: 'raf', timeout: 120_000 },
  );
  return Math.round((await handle.jsonValue()) as number);
}

async function markTime(page: Page, name: string): Promise<number> {
  return Math.round(await page.evaluate((mark) => performance.getEntriesByName(mark, 'mark')[0]?.startTime ?? Number.NaN, name));
}

for (const sample of manifest.samples) {
  test(`/?sample=${sample.id} opens the ${sample.id} workspace: charts with data, a brush cross-filters, the grid scrolls`, async ({ page }) => {
    const problems = await watchProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Relative to the base: /?sample=… at the root, /glassgrid/?sample=… (redirected to /glassgrid?sample=…) under it.
    await page.goto(`./?sample=${sample.id}`);
    // The production CSP header (the engine worker's policy) and the <meta> copy are both in force.
    expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toContain("script-src 'self' 'wasm-unsafe-eval'");

    const firstChart = await chartsDrawnAt(page, 'some');
    const allCharts = await chartsDrawnAt(page, 'every');
    await expectEngineWithParquet(problems);
    await expect(page.getByTestId('file-name')).toHaveText(sample.file);
    await expect.poll(() => shownRows(page)).toBe(sample.rows);
    await expect(page.getByTestId('grid')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('sample')).toBe(sample.id);
    const cards = page.locator('section.gg-chart-card');
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThanOrEqual(3);
    timings[sample.id] = {
      rows: sample.rows,
      parquetBytes: sample.bytes,
      engineReadyMs: await markTime(page, 'glassgrid:engine-ready'),
      workspaceLoadedMs: await markTime(page, 'glassgrid:sample-loaded'),
      firstChartMs: firstChart,
      allChartsMs: allCharts,
      charts: cardCount,
    };
    // Bars carry real numbers: the bar chart's data view (a table in place of the plot) shows non-zero values.
    const barTestId = (await cards.filter({ has: page.locator('.chart-view__plot[data-mark="bar"]') }).first().getAttribute('data-testid')) ?? '';
    const barCard = page.getByTestId(barTestId);
    await barCard.getByRole('switch', { name: 'View data' }).click();
    const values = (await barCard.locator('table td.gg-num').allTextContents()).map((text) => Number(text.replaceAll(',', '')));
    expect(values.length).toBeGreaterThan(0);
    expect(Math.min(...values)).toBeGreaterThan(0);
    await barCard.getByRole('switch', { name: 'View data' }).click();
    await expect(barCard.locator('.chart-view__plot[data-mark="bar"]')).toBeVisible();
    await page.screenshot({ path: join(screens, `sample-${sample.id}.png`) });

    // A mouse brush over the histogram cross-filters the grid and every other chart.
    const histogram = page.locator('section.gg-chart-card').filter({ has: page.locator('.chart-view__plot[data-mark="histogram"]') }).first();
    const histogramId = ((await histogram.getAttribute('data-testid')) ?? '').replace(/^chart-/, '');
    const canvas = page.getByTestId(`chart-${histogramId}-chart-canvas`);
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('the histogram has no canvas');
    const before = await page.evaluate((name) => performance.getEntriesByName(name, 'measure').length, CROSSFILTER_MEASURE);
    const y = box.y + box.height * 0.5;
    await page.mouse.move(box.x + box.width * 0.2, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(box.x + box.width * (0.2 + (0.25 * step) / 10), y);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    const measured = await page.waitForFunction(
      ({ name, previous }) => {
        const entries = performance.getEntriesByName(name, 'measure') as PerformanceMeasure[];
        const latest = entries.at(-1);
        return entries.length > previous && latest ? { duration: latest.duration, detail: latest.detail as unknown } : null;
      },
      { name: CROSSFILTER_MEASURE, previous: before },
      { timeout: 120_000, polling: 25 },
    );
    const { duration, detail } = (await measured.jsonValue()) as { duration: number; detail: CrossfilterMeasureDetail };
    const others = (await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid') ?? ''))).filter((id) => id !== `chart-${histogramId}`);
    expect(detail.views.map((view) => view.view).sort()).toEqual([...others.map((id) => `chart:${id.replace(/^chart-/, '')}`), 'grid:count', 'grid:rows'].sort());
    expect(detail.rowCount).toBeGreaterThan(0);
    expect(detail.rowCount).toBeLessThan(sample.rows);
    await expect(page.getByTestId('row-count')).toContainText(`of ${sample.rows.toLocaleString('en-US')} rows`);
    timings[sample.id] = { ...timings[sample.id], brushMs: Math.round(duration), brushRows: detail.rowCount ?? 0, brushFromCube: detail.views.filter((view) => view.fromCube).length };
    await page.screenshot({ path: join(screens, `sample-${sample.id}-brushed.png`) });

    // Undo the brush: back to every row.
    await page.getByTestId('undo').click();
    await expect.poll(() => shownRows(page)).toBe(sample.rows);
    await expect(page.getByTestId('row-count')).not.toContainText(' of ');

    // The grid scrolls deep into the table and fills the rows it shows.
    const scroller = page.getByTestId('grid-scroller');
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight * 0.6;
    });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const mirror = document.querySelector('[data-testid="grid-mirror"]');
            const first = Number(mirror?.querySelector('[role="rowgroup"]:last-child [role="rowheader"]')?.textContent ?? 0);
            const loading = [...(mirror?.querySelectorAll('[role="gridcell"]') ?? [])].some((cell) => cell.textContent === 'Loading');
            return loading ? 0 : first;
          }),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(sample.rows * 0.3);

    await expectNoProblems(page, problems);
  });
}
