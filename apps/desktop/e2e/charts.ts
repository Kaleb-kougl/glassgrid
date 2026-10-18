import { basename } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import {
  CHART_CREATE_MEASURE,
  CROSSFILTER_MEASURE,
  PROFILE_MEASURE,
  type ChartCreateMeasureDetail,
  type CrossfilterMeasureDetail,
} from '../src/renderer/src/perf';
import { digits, gridGeometry, measureCount, nextMeasure, ROWS } from './support';

/*
 * Driving the charts the way a person does, shared by the linked-charts spec
 * (crossfilter.spec.ts) and the render benchmark (render-perf.spec.ts): the
 * taxi-like fixture opened, columns dragged onto the charts panel, the card
 * menu, a mouse brush over a chart, filter chips removed.
 */

/** `[from, to]` as fractions of the histogram's canvas width; each differs from the one before. */
export const BRUSH_PATH: readonly (readonly [number, number])[] = [
  [0.14, 0.3],
  [0.2, 0.42],
  [0.12, 0.22],
  [0.3, 0.55],
  [0.16, 0.36],
  [0.25, 0.33],
  [0.13, 0.5],
  [0.35, 0.7],
  [0.18, 0.27],
  [0.22, 0.6],
  [0.15, 0.19],
  [0.4, 0.85],
  [0.17, 0.45],
  [0.28, 0.38],
  [0.13, 0.65],
  [0.21, 0.31],
  [0.45, 0.6],
  [0.16, 0.24],
  [0.32, 0.48],
  [0.19, 0.9],
  [0.24, 0.29],
];

export type Mark = 'line' | 'bar' | 'histogram' | 'heatmap';
/** Columns dropped for each mark (the heatmap's second column is selected in the grid). */
export const DROPS: Record<Mark, string[]> = {
  line: ['pickup_at'],
  bar: ['payment_type'],
  histogram: ['trip_distance'],
  heatmap: ['trip_distance', 'fare_amount'],
};
export const GRID_COLUMNS = ['pickup_at', 'payment_type', 'trip_distance', 'fare_amount'];

/** Waits for the profile; on large files also for the background Parquet copy. */
export async function openTrips(page: Page, csvPath: string, waitForParquet: boolean, rows: number = ROWS): Promise<void> {
  const previous = await measureCount(page, PROFILE_MEASURE);
  await page.getByTestId('open-csv').click();
  await expect(page.getByTestId('file-name')).toHaveText(basename(csvPath));
  await nextMeasure(page, PROFILE_MEASURE, previous);
  await expect.poll(async () => digits(await page.getByTestId('row-count').textContent()), { timeout: 120_000 }).toBe(String(rows));
  if (waitForParquet) await expect(page.getByTestId('app')).toHaveAttribute('data-parquet', 'ready', { timeout: 300_000 });
}

/** Selects one cell (`cols` = 1) or a row of cells across two adjacent columns in the grid. */
export async function selectGridColumns(page: Page, first: number, last = first): Promise<void> {
  const grid = await gridGeometry(page);
  const from = grid.cell(0, first);
  await page.mouse.click(from.x, from.y);
  if (last !== first) {
    const to = grid.cell(0, last);
    await page.keyboard.down('Shift');
    await page.mouse.click(to.x, to.y);
    await page.keyboard.up('Shift');
  }
}

/**
 * Drags a column from the list onto the charts panel; resolves with the
 * chart-create measure. `beforeDrag` runs once the grid selection is made,
 * right before the drag (the render benchmark arms its recorder there).
 */
export async function dropColumns(
  page: Page,
  columns: string[],
  options: { beforeDrag?: () => Promise<void> } = {},
): Promise<{ duration: number; detail: ChartCreateMeasureDetail }> {
  const [first, second] = columns;
  if (!first) throw new Error('no column');
  if (second) {
    await selectGridColumns(page, GRID_COLUMNS.indexOf(first), GRID_COLUMNS.indexOf(second));
    await expect(page.getByTestId(`column-${second}`)).toHaveAttribute('data-selected', 'true');
  } else {
    // One cell in another column: a single column is dropped.
    await selectGridColumns(page, first === 'pickup_at' ? 1 : 0);
  }
  const previous = await measureCount(page, CHART_CREATE_MEASURE);
  await options.beforeDrag?.();
  const empty = page.getByTestId('charts-drop');
  if ((await empty.count()) > 0) await page.getByTestId(`column-${first}`).dragTo(empty);
  else await page.getByTestId(`column-${first}`).dragTo(page.locator('section.charts .panel__head'), { targetPosition: { x: 40, y: 12 } });
  const measured = await nextMeasure(page, CHART_CREATE_MEASURE, previous);
  const detail = measured.detail as ChartCreateMeasureDetail;
  expect(detail.columns).toEqual(columns);
  return { duration: measured.duration, detail };
}

export function card(page: Page, chartId: string): Locator {
  return page.getByTestId(`chart-${chartId}`);
}

/** Picks an item of the card's ⋯ menu: a mark (`menuitemradio`) or an action. */
export async function cardMenu(page: Page, chartId: string, role: 'menuitem' | 'menuitemradio', item: RegExp): Promise<void> {
  await card(page, chartId).getByRole('button', { name: 'Chart actions' }).click();
  await page.getByRole(role, { name: item }).click();
}

export async function removeChart(page: Page, chartId: string): Promise<void> {
  await cardMenu(page, chartId, 'menuitem', /^Remove chart/);
  await expect(card(page, chartId)).toHaveCount(0);
}

/** Pixel rectangle of a chart's plot canvas (the brush layer). */
export async function plotBox(page: Page, chartId: string) {
  const canvas = page.getByTestId(`chart-${chartId}-chart-canvas`);
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error(`chart ${chartId} has no canvas`);
  return box;
}

/**
 * Drags a brush over the histogram from `from` to `to` (fractions of the
 * canvas width) in about 300 ms, as a person does, and waits for the
 * cross-filter measure. `beforeDown` / `beforeUp` run right before the press
 * and the release (the render benchmark arms its recorder there).
 */
export async function brush(
  page: Page,
  chartId: string,
  from: number,
  to: number,
  options: { beforeDown?: () => Promise<void>; beforeUp?: () => Promise<void> } = {},
): Promise<{ duration: number; detail: CrossfilterMeasureDetail }> {
  const box = await plotBox(page, chartId);
  const y = box.y + box.height * 0.45;
  const previous = await measureCount(page, CROSSFILTER_MEASURE);
  await page.mouse.move(box.x + box.width * from, y);
  await options.beforeDown?.();
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(box.x + box.width * (from + ((to - from) * step) / 10), y);
    await page.waitForTimeout(30);
  }
  await options.beforeUp?.();
  await page.mouse.up();
  const measured = await nextMeasure(page, CROSSFILTER_MEASURE, previous);
  return { duration: measured.duration, detail: measured.detail as CrossfilterMeasureDetail };
}

/** Clicks the bar at `index` (bars are 20 px rows, 6 px apart). */
export async function clickBar(page: Page, chartId: string, index: number): Promise<{ duration: number; detail: CrossfilterMeasureDetail }> {
  const canvas = card(page, chartId).getByRole('listbox').locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('bar chart has no canvas');
  const previous = await measureCount(page, CROSSFILTER_MEASURE);
  await page.mouse.click(box.x + box.width / 2, box.y + index * 26 + 10);
  const measured = await nextMeasure(page, CROSSFILTER_MEASURE, previous);
  return { duration: measured.duration, detail: measured.detail as CrossfilterMeasureDetail };
}

export async function removeAllChips(page: Page): Promise<void> {
  const chips = page.getByRole('list', { name: 'Active filters' }).getByRole('button', { name: /^Remove filter on/ });
  while ((await chips.count()) > 0) {
    const before = await chips.count();
    await chips.first().click();
    await expect(chips).toHaveCount(before - 1);
  }
}
