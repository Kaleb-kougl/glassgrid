import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  CROSSFILTER_PREPARE_MEASURE,
  type CrossfilterMeasureDetail,
  type CrossfilterPrepareMeasureDetail,
} from '@glassgrid/app/perf';
import { BRUSH_PATH, brush, card, cardMenu, clickBar, DROPS, dropColumns, openTrips, plotBox, removeAllChips, removeChart, type Mark } from './charts';
import { PAYMENT_TYPES, writeTripsCsv } from './csv-fixture';
import { SqlReference, type ReferenceFilter } from './sql-reference';
import {
  axe,
  digits,
  launchApp,
  machineInfo,
  measureCount,
  measures,
  RESULTS_DIR,
  ROWS,
  screenshot,
  setTheme,
  stats,
  writeBaseline,
  type LaunchedApp,
} from './support';

/*
 * M3: four linked charts and the grid on a taxi-like file (timestamp, a
 * five-value category, a skewed distance and a fare), driven the way a
 * person does: columns dragged onto the charts panel, a bar clicked, the
 * histogram brushed with the mouse. Counts are checked against an
 * independent DuckDB over the same CSV. The last tests record the M3 exit
 * gate: chart create (drop -> drawn) per mark and cross-filter updates
 * (brush end -> last view painted) over 20+ brushes, on the Parquet copy
 * (10M) and, separately, on the raw CSV.
 */

/** Large files get a background Parquet copy; the exit gate measures on it. */
const PARQUET = ROWS > 2_000_000;
/** Brushes for the cross-filter budget (after the first, which includes building the cubes). */
const BRUSHES = 20;
/** Chart creations per mark beyond the first (each under a fresh filter, so none is a result-cache hit). */
const CREATE_ROUNDS = 5;
/** Wait after a filter before timing chart creation (the engine's background index build for the grid). */
const SETTLE_MS = PARQUET ? 6_000 : 2_500;
interface CreateSample {
  mark: string;
  ms: number;
  engineMs: number;
  cached: boolean;
  rows: number;
  filtered: boolean;
}

interface BrushSample {
  ms: number;
  rowCount: number | null;
  views: CrossfilterMeasureDetail['views'];
  filters: unknown[];
}

interface SourceResults {
  source: 'parquet' | 'csv';
  creates: CreateSample[];
  firstBrush?: BrushSample & { prepare?: { ms: number; detail: CrossfilterPrepareMeasureDetail } };
  brushes: BrushSample[];
}

const results: { parquet?: SourceResults; csv?: SourceResults; fileBytes?: number; machine?: Awaited<ReturnType<typeof machineInfo>> } = {};

const rowCountOf = async (page: Page) => Number(digits((await page.getByTestId('row-count').locator('strong').textContent()) ?? ''));

// ---------------------------------------------------------------------------

test.describe('linked charts', () => {
  test.describe.configure({ mode: 'serial' });

  let workDir: string;
  let csvPath: string;
  let fileBytes: number;
  let reference: SqlReference;
  let session: LaunchedApp | undefined;
  /** Chart ids by mark, in the order they were added. */
  const charts: Partial<Record<Mark, string>> = {};

  test.beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'glassgrid-e2e-m3-'));
    csvPath = join(workDir, `trips-${ROWS}-rows.csv`);
    fileBytes = await writeTripsCsv(csvPath, ROWS);
    reference = await SqlReference.open(csvPath);
    session = await launchApp(csvPath, join(workDir, 'user-data'));
  });

  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus && session) {
      await mkdir(RESULTS_DIR, { recursive: true });
      const path = join(RESULTS_DIR, 'app-logs-m3.txt');
      await writeFile(path, session.logs.join(''));
      await testInfo.attach('app-logs', { path, contentType: 'text/plain' });
    }
  });

  test.afterAll(async () => {
    await session?.app.close();
    reference.close();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  test('four linked charts and the grid: a bar click and a histogram brush cross-filter each other, undo restores', async () => {
    if (!session) throw new Error('Electron app failed to launch');
    const { app, page } = session;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await setTheme(app, page, 'dark');
    await openTrips(page, csvPath, PARQUET);
    results.fileBytes = fileBytes;
    results.machine = await machineInfo(app);

    // Drag-to-chart with the default chart rules: a line over time, bars, a histogram, a heatmap of two numbers.
    const creates: CreateSample[] = [];
    for (const mark of ['line', 'bar', 'histogram', 'heatmap'] as const) {
      const created = await dropColumns(page, DROPS[mark]);
      expect(created.detail.mark).toBe(mark);
      charts[mark] = created.detail.chartId;
      creates.push({ mark, ms: created.duration, engineMs: created.detail.engineMs, cached: created.detail.cached, rows: created.detail.rows, filtered: false });
      console.log(`chart create ${mark}: ${created.duration.toFixed(1)} ms (engine ${created.detail.engineMs.toFixed(1)} ms, ${created.detail.rows} rows)`);
    }
    results.parquet = { source: PARQUET ? 'parquet' : 'csv', creates, brushes: [] };
    const { line, bar, histogram, heatmap } = charts as Record<Mark, string>;
    await expect(card(page, line).getByRole('heading')).toHaveText('Rows over pickup_at');
    await expect(page.getByTestId(`chart-${line}-shelf-x`)).toContainText('hour(pickup_at)');
    await expect(card(page, histogram).getByRole('heading')).toHaveText('Distribution of trip_distance');
    await expect(page.getByTestId(`chart-${histogram}-shelf-x`)).toContainText(/bin\(trip_distance, [\d.]+\)/);
    await expect(card(page, heatmap).getByRole('heading')).toHaveText('Rows by trip_distance and fare_amount');

    // The bars match the reference, largest first.
    const byPayment = await reference.countBy('payment_type', []);
    const options = card(page, bar).getByRole('option');
    const order = [...PAYMENT_TYPES.map(([name]) => name)].sort((a, b) => (byPayment.get(b) ?? 0) - (byPayment.get(a) ?? 0));
    await expect(options).toHaveText(order.map((name) => `${name}: ${(byPayment.get(name) ?? 0).toLocaleString('en-US')}`));

    // Click "Cash": every other view re-queries with payment_type = Cash.
    const cashIndex = order.indexOf('Cash');
    const clicked = await clickBar(page, bar, cashIndex);
    const cash: ReferenceFilter = { kind: 'in', column: 'payment_type', values: ['Cash'] };
    const cashCount = await reference.count([cash]);
    expect(clicked.detail.filters).toEqual([cash]);
    expect(clicked.detail.rowCount).toBe(cashCount);
    expect(clicked.detail.views.map((view) => view.view).sort()).toEqual([`chart:${heatmap}`, `chart:${histogram}`, `chart:${line}`, 'grid:count', 'grid:rows'].sort());
    await expect(page.getByTestId('filter-payment_type')).toHaveText('payment_type= Cash×');
    await expect(card(page, bar)).toContainText('1 selected');
    expect(await rowCountOf(page)).toBe(cashCount);
    console.log(`bar click: ${clicked.duration.toFixed(1)} ms to the last view painted`);

    // Brush trip_distance on the histogram with the mouse.
    const brushed = await brush(page, histogram, 0.135, 0.22);
    const distance = brushed.detail.filters.find((filter) => (filter as ReferenceFilter).column === 'trip_distance') as ReferenceFilter | undefined;
    expect(distance).toMatchObject({ kind: 'range', column: 'trip_distance', minInclusive: true, maxInclusive: false });
    if (!distance) throw new Error('no distance filter');
    const both = await reference.count([cash, distance]);
    expect(brushed.detail.filters).toEqual([cash, distance]);
    expect(brushed.detail.rowCount).toBe(both);
    expect(brushed.detail.views.map((view) => view.view).sort()).toEqual([`chart:${bar}`, `chart:${heatmap}`, `chart:${line}`, 'grid:count', 'grid:rows'].sort());
    await expect.poll(() => rowCountOf(page)).toBe(both);
    await expect(page.getByRole('list', { name: 'Active filters' }).getByRole('listitem')).toHaveCount(2);
    await expect(page.getByTestId('filter-trip_distance')).toContainText('trip_distance');
    // The bars show the distance brush only (never their own click): each equals the reference.
    const underBrush = await reference.countBy('payment_type', [distance]);
    await expect(options).toHaveText(
      [...order].sort((a, b) => (underBrush.get(b) ?? 0) - (underBrush.get(a) ?? 0)).map((name) => `${name}: ${(underBrush.get(name) ?? 0).toLocaleString('en-US')}`),
    );
    // The histogram keeps its full distribution and shows the brush.
    await expect(card(page, histogram).getByRole('img')).toHaveAttribute('aria-label', /Selected bin\(trip_distance, [\d.]+\) /);
    console.log(`histogram brush: ${brushed.duration.toFixed(1)} ms to the last view painted; ${both} rows`);

    // Undo restores, one step per gesture.
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+KeyZ`);
    await expect(page.getByTestId('filter-trip_distance')).toHaveCount(0);
    await expect.poll(() => rowCountOf(page)).toBe(cashCount);
    await page.keyboard.press(`${mod}+KeyZ`);
    await expect(page.getByTestId('filter-payment_type')).toHaveCount(0);
    await expect.poll(async () => digits(await page.getByTestId('row-count').textContent())).toBe(String(ROWS));
    await page.keyboard.press(`${mod}+Shift+KeyZ`);
    await page.keyboard.press(`${mod}+Shift+KeyZ`);
    await expect(page.getByTestId('filter-trip_distance')).toHaveCount(1);
    await expect.poll(() => rowCountOf(page)).toBe(both);

    // State A as in the design: line, bars with a selection, histogram with a brush; a tooltip on the line.
    await page.getByTestId('charts-viewport').locator('.charts__list').evaluate((list) => list.scrollTo(0, 0));
    const lineBox = await plotBox(page, line);
    await page.mouse.move(lineBox.x + lineBox.width * 0.55, lineBox.y + lineBox.height * 0.5);
    await expect(page.getByRole('tooltip')).toBeVisible();
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(app, page, theme);
      await screenshot(page, `m3-populated-${theme}`);
    }
    await setTheme(app, page, 'dark');
    expect(session.rendererErrors, 'renderer console errors (CSP violations, exceptions)').toEqual([]);
  });

  test('every chart type passes axe in both themes', async () => {
    if (!session) throw new Error('Electron app failed to launch');
    const { app, page } = session;
    const { histogram } = charts as Record<Mark, string>;
    // A narrow brush in the tail keeps the scatter below its raw-point limit.
    await brush(page, histogram, 0.62, 0.66);
    const area = (await dropColumns(page, ['pickup_at'])).detail.chartId;
    await cardMenu(page, area, 'menuitemradio', /^Area chart/);
    await expect(card(page, area).getByRole('img')).toHaveAttribute('aria-label', /Area chart/);
    const scatter = (await dropColumns(page, ['trip_distance', 'fare_amount'])).detail.chartId;
    await cardMenu(page, scatter, 'menuitemradio', /^Scatter plot/);
    await expect(card(page, scatter).getByRole('img')).toHaveAttribute('aria-label', /Scatter plot/);
    // "View data" on one card: the same rows as a table.
    await card(page, scatter).getByTestId(`chart-${scatter}-view-data`).click();
    await expect(card(page, scatter).getByRole('table')).toBeVisible();
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(app, page, theme);
      expect(await axe(page, `m3-charts-${theme}`), `axe violations, every chart type, ${theme}`).toEqual([]);
    }
    await setTheme(app, page, 'dark');
    await removeChart(page, scatter);
    await removeChart(page, area);
    await removeAllChips(page);
    expect(session.rendererErrors, 'renderer console errors (CSP violations, exceptions)').toEqual([]);
  });

  test('M3 exit gate: chart create per mark and cross-filter updates over 20 brushes', async () => {
    if (!session) throw new Error('Electron app failed to launch');
    const { page } = session;
    const run = results.parquet;
    if (!run) throw new Error('the linked-charts test did not run');
    // Chart creation on an otherwise empty panel: a new chart never repeats a query another card already made.
    await removeAllChips(page);
    for (const chartId of Object.values(charts)) await removeChart(page, chartId);
    await createRounds(page, run);
    // Back to four charts (their results are cached from the first test: not timed) and the grid.
    for (const mark of ['line', 'bar', 'histogram', 'heatmap'] as const) charts[mark] = (await dropColumns(page, DROPS[mark])).detail.chartId;
    await brushRounds(page, (charts as Record<Mark, string>).histogram, run);
    expect(session.rendererErrors, 'renderer console errors (CSP violations, exceptions)').toEqual([]);
  });
});

/**
 * Chart creation per mark under a fresh filter each round, each chart removed
 * before the next: every aggregate is computed, none is a result-cache hit.
 */
async function createRounds(page: Page, run: SourceResults): Promise<void> {
  for (let round = 1; round <= CREATE_ROUNDS; round += 1) {
    await page.getByTestId('add-filter').click();
    const editor = page.getByTestId('filter-editor');
    await editor.getByTestId('filter-editor-column').selectOption('fare_amount');
    await editor.getByTestId('filter-editor-operator').selectOption('atLeast');
    await editor.getByTestId('filter-editor-value').fill(String(round));
    await editor.getByTestId('filter-editor-submit').click();
    await expect(page.getByTestId('filter-fare_amount')).toBeVisible();
    // Steady state: 1.5 s after a filter settles the engine builds the grid's filtered row-number index
    // in the background (docs/m3-xfilter-notes.md); a chart created during that build shares the 2 cores with it.
    await page.waitForTimeout(SETTLE_MS);
    for (const mark of ['line', 'bar', 'histogram', 'heatmap'] as const) {
      const created = await dropColumns(page, DROPS[mark]);
      expect(created.detail.mark).toBe(mark);
      expect(created.detail.cached).toBe(false);
      run.creates.push({ mark, ms: created.duration, engineMs: created.detail.engineMs, cached: created.detail.cached, rows: created.detail.rows, filtered: true });
      await removeChart(page, created.detail.chartId);
    }
    await removeAllChips(page);
  }
  for (const mark of ['line', 'bar', 'histogram', 'heatmap'] as const) {
    const ms = run.creates.filter((sample) => sample.mark === mark).map((sample) => sample.ms);
    const s = stats(ms);
    console.log(`[${run.source}] chart create ${mark}: p50 ${s.p50.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms (n=${s.n})`);
  }
}

/** The first brush (cubes built at pointer down) and 20 more on the same axis, 300 ms apart. */
async function brushRounds(page: Page, histogram: string, run: SourceResults): Promise<void> {
  await removeAllChips(page);
  const preparesBefore = await measureCount(page, CROSSFILTER_PREPARE_MEASURE);
  for (const [index, [from, to]] of BRUSH_PATH.slice(0, BRUSHES + 1).entries()) {
    const measured = await brush(page, histogram, from, to);
    const sample: BrushSample = { ms: measured.duration, rowCount: measured.detail.rowCount, views: measured.detail.views, filters: measured.detail.filters };
    if (index === 0) {
      const prepares = (await measures(page, CROSSFILTER_PREPARE_MEASURE)).slice(preparesBefore);
      const prepare = prepares[0];
      run.firstBrush = { ...sample, ...(prepare ? { prepare: { ms: prepare.duration, detail: prepare.detail as CrossfilterPrepareMeasureDetail } } : {}) };
    } else {
      run.brushes.push(sample);
    }
    await page.waitForTimeout(300);
  }
  // Spot check against the reference: the last brush's count.
  const last = run.brushes.at(-1);
  if (last) expect(await rowCountOf(page)).toBe(last.rowCount);
  const s = stats(run.brushes.map((sample) => sample.ms));
  const fromCube = run.brushes.flatMap((sample) => sample.views).filter((view) => view.fromCube).length;
  const total = run.brushes.flatMap((sample) => sample.views).length;
  console.log(
    `[${run.source}] cross-filter over ${s.n} brushes: p50 ${s.p50.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, max ${s.max.toFixed(1)} ms; ` +
      `first brush ${run.firstBrush?.ms.toFixed(1) ?? '?'} ms (cubes ready after ${run.firstBrush?.prepare?.ms.toFixed(0) ?? '?'} ms); ${fromCube}/${total} view answers from cubes`,
  );
}

test.describe('raw CSV (no Parquet copy)', () => {
  test.describe.configure({ mode: 'serial' });
  // On the default 1M fixture the file is below the conversion size: the run above already was the raw CSV.
  test.skip(!PARQUET, 'the default run already measures the raw CSV');

  let workDir: string;
  let csvPath: string;
  let session: LaunchedApp | undefined;

  test.beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'glassgrid-e2e-m3-csv-'));
    csvPath = join(workDir, `trips-${ROWS}-rows.csv`);
    await writeTripsCsv(csvPath, ROWS);
    session = await launchApp(csvPath, join(workDir, 'user-data'), { GLASSGRID_E2E_AUTO_CONVERT_MIN_BYTES: String(Number.MAX_SAFE_INTEGER) });
  });

  test.afterAll(async () => {
    await session?.app.close();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  test('chart create and cross-filter on the raw CSV', async () => {
    if (!session) throw new Error('Electron app failed to launch');
    const { app, page } = session;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await openTrips(page, csvPath, false);
    await expect(page.getByTestId('app')).toHaveAttribute('data-parquet', 'none');
    const run: SourceResults = { source: 'csv', creates: [], brushes: [] };
    let histogram = '';
    for (const mark of ['line', 'bar', 'histogram', 'heatmap'] as const) {
      const created = await dropColumns(page, DROPS[mark]);
      run.creates.push({ mark, ms: created.duration, engineMs: created.detail.engineMs, cached: created.detail.cached, rows: created.detail.rows, filtered: false });
      if (mark === 'histogram') histogram = created.detail.chartId;
    }
    await brushRounds(page, histogram, run);
    results.csv = run;
    expect(session.rendererErrors, 'renderer console errors (CSP violations, exceptions)').toEqual([]);
  });
});

test('records the M3 exit gate', async () => {
  const parquet = results.parquet;
  if (!parquet) throw new Error('no exit-gate measurements');
  const summary = (run: SourceResults) => {
    const perMark = Object.fromEntries(
      (['line', 'bar', 'histogram', 'heatmap'] as const).map((mark) => {
        const s = stats(run.creates.filter((sample) => sample.mark === mark).map((sample) => sample.ms));
        return [mark, { ...s, budgetMs: 250, met: s.p50 < 250 && s.p95 < 250 }];
      }),
    );
    const brushes = stats(run.brushes.map((sample) => sample.ms));
    const views = run.brushes.flatMap((sample) => sample.views);
    return {
      source: run.source,
      chartCreate: { perMark, met: Object.values(perMark).every((mark) => mark.met) },
      crossfilter: {
        ...brushes,
        budgetMs: 100,
        met: brushes.p95 < 100,
        viewsFromCube: views.filter((view) => view.fromCube).length,
        views: views.length,
        perView: Object.fromEntries(
          [...new Set(views.map((view) => view.view.startsWith('chart:') ? 'chart' : view.view))].map((name) => [
            name,
            stats(views.filter((view) => (view.view.startsWith('chart:') ? 'chart' : view.view) === name).map((view) => view.ms)),
          ]),
        ),
      },
      firstBrush: run.firstBrush ? { ms: run.firstBrush.ms, cubesReadyMs: run.firstBrush.prepare?.ms ?? null, cubes: run.firstBrush.prepare?.detail.cubes ?? [] } : null,
    };
  };
  const gate = summary(parquet);
  const outFile = await writeBaseline('m3-exit-gate', {
    benchmark: 'm3-exit-gate',
    milestone: 'M3',
    exitGate: {
      name: 'chart create (drop -> drawn) p50/p95 < 250 ms per mark; cross-filter (brush end -> last view painted) p95 < 100 ms over 20 brushes; 4 charts + grid',
      ...gate,
      met: gate.chartCreate.met && gate.crossfilter.met,
    },
    rawCsv: results.csv ? summary(results.csv) : null,
    recordedAt: new Date().toISOString(),
    rows: ROWS,
    fileBytes: results.fileBytes,
    ...results.machine,
    samples: { parquet: results.parquet, csv: results.csv },
  });
  console.log(`m3-exit-gate ${ROWS} rows -> ${outFile}`);
});
