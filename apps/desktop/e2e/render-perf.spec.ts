import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type CDPSession, type ElectronApplication, type Page } from '@playwright/test';
import type { RenderPerfRecording } from '../src/renderer/src/perf';
import { BRUSH_PATH, brush, DROPS, dropColumns, openTrips, type Mark } from './charts';
import { writeTripsCsv } from './csv-fixture';
import {
  analyzeCreate,
  analyzeInteraction,
  bundleRegions,
  componentTable,
  firstSampleIn,
  regionTable,
  statsByField,
  summarizeProfile,
  type CommitSummary,
  type CpuProfile,
  type CreateAnalysis,
  type InteractionAnalysis,
  rendererMainThread,
  summarizeTrace,
  type ProfileSummary,
  type TraceEvent,
  type TraceSummary,
} from './render-analysis';
import { gridGeometry, launchApp, machineInfo, RESULTS_DIR, ROWS, stats, writeBaseline, type LaunchedApp } from './support';

/*
 * Render-path benchmark: where the non-engine time of a chart create goes,
 * and what a cross-filter brush and a grid key press cost on the React side.
 * Run with `pnpm --filter @glassgrid/desktop e2e:render` (builds with
 * GLASSGRID_RENDER_PERF=1: phase marks, React Profiler regions and the commit
 * inspector compiled in; React's profiling build). Not part of `pnpm e2e`.
 *
 * Against an ordinary build (no instrumentation) the same flows run and only
 * the app's own measures are recorded (`glassgrid:chart-create`,
 * `glassgrid:crossfilter`): the instrumentation's overhead.
 *
 * - create, cached: the same chart dropped again (the engine answers from its
 *   result cache, `cached: true`), so only the non-engine path remains;
 * - create, fresh: a new `fare_amount ≥ k` filter before each create (as the
 *   M3 exit gate), so every aggregate is computed;
 * - brush: 4 charts (line, bars, histogram, heatmap) + the grid, a mouse
 *   brush on the histogram; recorded from the release;
 * - brush-start: the press and the 300 ms drag before it;
 * - select: one ArrowDown in the grid with the 4 charts on screen.
 */

const PARQUET = ROWS > 2_000_000;
/** Samples per mark and variant (the brief: at least 20). */
const N = Number(process.env['GLASSGRID_E2E_RENDER_N'] ?? 20);
/** Wait after a filter (the engine's background index build), as in crossfilter.spec.ts. */
const SETTLE_MS = PARQUET ? 6_000 : 2_500;
/** Quiet time before arming and after the frame, so the recording holds the whole interaction and nothing else. */
const QUIET_MS = 300;
/** Interactions per CPU profile. */
const PROFILED = 10;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

interface RecorderApi {
  arm(kind: string, input: string): void;
  take(): RenderPerfRecording | null;
  setInspect(on: boolean): void;
}

type Win = Window & { __ggRenderPerf?: RecorderApi };

interface CreateSample {
  mark: Mark;
  /** The app's own glassgrid:chart-create measure (drop handler -> drawn). */
  measureMs: number;
  engineMs: number;
  cached: boolean;
  analysis?: CreateAnalysis;
}

interface InteractionSample {
  /** glassgrid:crossfilter for brushes. */
  measureMs?: number;
  analysis?: InteractionAnalysis;
}

const results: {
  instrumented?: boolean;
  machine?: Awaited<ReturnType<typeof machineInfo>>;
  create: Record<string, CreateSample[]>;
  brush: InteractionSample[];
  brushStart: InteractionSample[];
  select: InteractionSample[];
  profiles: Record<string, ProfileSummary>;
  traces: Record<string, TraceSummary>;
} = { create: {}, brush: [], brushStart: [], select: [], profiles: {}, traces: {} };

// ---------------------------------------------------------------------------

async function instrumented(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as Win).__ggRenderPerf !== undefined);
}

async function arm(page: Page, kind: string, input: string): Promise<void> {
  await page.evaluate(([k, i]) => (window as Win).__ggRenderPerf?.arm(k, i), [kind, input] as const);
}

/** Waits for the frame after the last `after` mark (`drawn` or `commit-end`), lets things settle, and takes the recording. */
async function take(page: Page, kind: string, after: 'drawn' | 'commit-end'): Promise<RenderPerfRecording | null> {
  if (!(await instrumented(page))) return null;
  await page.waitForFunction(
    ([kind, after]) => {
      const marks = (name: string) => performance.getEntriesByName(`glassgrid:${kind}:${name}`, 'mark').map((entry) => entry.startTime);
      const last = Math.max(...marks(after));
      return Number.isFinite(last) && marks('presented').some((t) => t > last);
    },
    [kind, after] as const,
    { polling: 25, timeout: 30_000 },
  );
  await page.waitForTimeout(QUIET_MS);
  return page.evaluate(() => (window as Win).__ggRenderPerf?.take() ?? null);
}

async function undo(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+KeyZ`);
}

/** Drops the mark's columns, records the create, then undoes it (no "Removed" toast to re-render the app later). */
async function createOnce(page: Page, mark: Mark): Promise<CreateSample> {
  const recording = { value: null as RenderPerfRecording | null };
  const created = await dropColumns(page, DROPS[mark], {
    beforeDrag: async () => {
      await page.waitForTimeout(QUIET_MS);
      await arm(page, 'create', 'drop');
    },
  });
  recording.value = await take(page, 'create', 'drawn');
  expect(created.detail.mark).toBe(mark);
  const sample: CreateSample = { mark, measureMs: created.duration, engineMs: created.detail.engineMs, cached: created.detail.cached };
  if (recording.value) sample.analysis = analyzeCreate(recording.value, created.detail.chartId);
  await undo(page);
  await expect(page.getByTestId(`chart-${created.detail.chartId}`)).toHaveCount(0);
  return sample;
}

async function addFareFilter(page: Page, atLeast: number): Promise<void> {
  await page.getByTestId('add-filter').click();
  const editor = page.getByTestId('filter-editor');
  await editor.getByTestId('filter-editor-column').selectOption('fare_amount');
  await editor.getByTestId('filter-editor-operator').selectOption('atLeast');
  await editor.getByTestId('filter-editor-value').fill(String(atLeast));
  await editor.getByTestId('filter-editor-submit').click();
  await expect(page.getByTestId('filter-fare_amount')).toBeVisible();
}

function push(key: string, sample: CreateSample): void {
  (results.create[key] ??= []).push(sample);
}

function logCreates(key: string): void {
  const samples = results.create[key] ?? [];
  const s = stats(samples.map((sample) => sample.analysis?.totals.toPresented ?? sample.measureMs));
  const engine = stats(samples.map((sample) => sample.engineMs));
  const nonEngine = stats(samples.map((sample) => sample.analysis?.totals.nonEngine ?? sample.measureMs - sample.engineMs));
  console.info(`[render-perf ${ROWS}] create ${key}: total p50 ${s.p50.toFixed(1)} / p95 ${s.p95.toFixed(1)} ms; engine p50 ${engine.p50.toFixed(1)}; non-engine p50 ${nonEngine.p50.toFixed(1)} / p95 ${nonEngine.p95.toFixed(1)} ms (n=${s.n})`);
}

// ---------------------------------------------------------------------------
// CPU profiles (CDP Profiler) over a few interactions

async function startProfile(page: Page): Promise<{ cdp: CDPSession; t0: number }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  await cdp.send('Profiler.start');
  // A named busy loop maps performance.now() onto the profile's clock (first sample inside it).
  const t0 = await page.evaluate<number>(
    '(() => { function ggProfileCalibration() { const start = performance.now(); while (performance.now() - start < 30) {} return start; } return ggProfileCalibration(); })()',
  );
  return { cdp, t0 };
}

async function stopProfile(
  session: { cdp: CDPSession; t0: number },
  windows: readonly (readonly [number, number])[],
  name: string,
): Promise<ProfileSummary> {
  const { profile } = (await session.cdp.send('Profiler.stop')) as unknown as { profile: CpuProfile };
  await session.cdp.detach();
  await mkdir(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `render-perf-${name}-${ROWS}.cpuprofile`);
  await writeFile(path, JSON.stringify(profile));
  const calibration = firstSampleIn(profile, 'ggProfileCalibration');
  if (calibration === null) throw new Error('calibration loop not sampled');
  const offset = calibration - session.t0 * 1000;
  const bundles = new Map<string, (line: number) => string>();
  for (const node of profile.nodes) {
    const url = node.callFrame.url;
    if (!url.startsWith('file://') || !url.endsWith('.js') || bundles.has(url)) continue;
    try {
      bundles.set(url, bundleRegions(await readFile(fileURLToPath(url), 'utf8')));
    } catch {
      bundles.set(url, () => url);
    }
  }
  const moduleOf = (url: string, line: number) => bundles.get(url)?.(line) ?? url;
  return summarizeProfile(
    profile,
    windows.map(([from, to]) => [from * 1000 + offset, to * 1000 + offset] as const),
    moduleOf,
  );
}

function windowOf(recording: RenderPerfRecording | null, analysis: { milestones: Record<string, number> } | undefined): [number, number] | null {
  const input = recording?.events.find((event) => event.type === 'input')?.t;
  const presented = analysis?.milestones['presented'];
  return input === undefined || presented === undefined ? null : [input, input + presented];
}

// ---------------------------------------------------------------------------
// Interactions repeated under a profiler or a trace: each returns its [input, presented] windows (performance.now()).

/** Cached heatmap creates on an empty panel (the engine has the result cached from the first test). */
async function cachedCreates(page: Page, count: number): Promise<[number, number][]> {
  const windows: [number, number][] = [];
  for (let i = 0; i < count; i += 1) {
    const created = await dropColumns(page, DROPS.heatmap, {
      beforeDrag: async () => {
        await page.waitForTimeout(QUIET_MS);
        await arm(page, 'create', 'drop');
      },
    });
    const recording = await take(page, 'create', 'drawn');
    const window = recording ? windowOf(recording, analyzeCreate(recording, created.detail.chartId)) : null;
    if (window) windows.push(window);
    await undo(page);
    await expect(page.getByTestId(`chart-${created.detail.chartId}`)).toHaveCount(0);
  }
  return windows;
}

/** Line, bars, histogram and heatmap on the panel, and a first brush (cubes built); returns the histogram's id. */
async function fourCharts(page: Page): Promise<string> {
  const charts: Partial<Record<Mark, string>> = {};
  for (const mark of ['line', 'bar', 'histogram', 'heatmap'] as const) charts[mark] = (await dropColumns(page, DROPS[mark])).detail.chartId;
  const histogram = charts.histogram ?? '';
  await page.waitForTimeout(QUIET_MS);
  await brush(page, histogram, BRUSH_PATH[0]?.[0] ?? 0.14, BRUSH_PATH[0]?.[1] ?? 0.3);
  return histogram;
}

async function brushes(page: Page, histogram: string, count: number): Promise<[number, number][]> {
  const windows: [number, number][] = [];
  for (let i = 1; i <= count; i += 1) {
    const [from, to] = BRUSH_PATH[i % BRUSH_PATH.length] ?? [0.2, 0.4];
    await page.waitForTimeout(QUIET_MS);
    await brush(page, histogram, from, to, { beforeUp: () => arm(page, 'brush', 'pointerup') });
    const recording = await take(page, 'brush', 'drawn');
    const window = recording ? windowOf(recording, analyzeInteraction(recording)) : null;
    if (window) windows.push(window);
  }
  return windows;
}

/** ArrowDown / ArrowUp in the grid (a cell focused first). */
async function selects(page: Page, count: number): Promise<[number, number][]> {
  const grid = await gridGeometry(page);
  const cell = grid.cell(2, 1);
  await page.mouse.click(cell.x, cell.y);
  const windows: [number, number][] = [];
  for (let i = 0; i < count; i += 1) {
    await page.waitForTimeout(QUIET_MS);
    await arm(page, 'select', 'keydown');
    await page.keyboard.press(i % 2 === 0 ? 'ArrowDown' : 'ArrowUp');
    const recording = await take(page, 'select', 'commit-end');
    const window = recording ? windowOf(recording, analyzeInteraction(recording)) : null;
    if (window) windows.push(window);
  }
  return windows;
}

/** Undo brushes and charts until the panel is empty (never past the open file). */
async function clearCharts(page: Page): Promise<void> {
  for (let i = 0; i < 200 && (await page.getByTestId('charts-drop').count()) === 0; i += 1) {
    await undo(page);
    await page.waitForTimeout(50);
  }
  await expect(page.getByTestId('charts-drop')).toBeVisible();
}

const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'toplevel',
  'blink.user_timing',
  'v8',
];

/** Runs `work` under Electron's contentTracing and summarizes the renderer main thread inside its windows. */
async function traced(app: ElectronApplication, page: Page, name: string, work: () => Promise<[number, number][]>): Promise<TraceSummary> {
  await app.evaluate(async ({ contentTracing }, categories) => {
    await contentTracing.startRecording({ included_categories: categories, excluded_categories: ['*'] });
  }, TRACE_CATEGORIES);
  // A user-timing mark maps performance.now() onto the trace clock.
  const t0 = await page.evaluate(() => performance.mark('gg-trace-calibration').startTime);
  const windows = await work();
  await mkdir(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `render-perf-trace-${name}-${ROWS}.json`);
  await app.evaluate(async ({ contentTracing }, out) => {
    await contentTracing.stopRecording(out);
  }, path);
  const parsed = JSON.parse(await readFile(path, 'utf8')) as TraceEvent[] | { traceEvents: TraceEvent[] };
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
  const thread = rendererMainThread(events, 'gg-trace-calibration');
  if (!thread) throw new Error('renderer main thread or calibration mark not found in the trace');
  const offset = thread.markerTs - t0 * 1000;
  return summarizeTrace(
    events,
    thread,
    windows.map(([from, to]) => [from * 1000 + offset, to * 1000 + offset] as const),
  );
}

// ---------------------------------------------------------------------------

test.describe('render path', () => {
  // N cached and N fresh creates per mark, brushes, key presses and two profiles: longer than the default budget.
  test.describe.configure({ mode: 'serial', timeout: 40 * 60_000 });

  let workDir: string;
  let csvPath: string;
  let session: LaunchedApp | undefined;

  test.beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'glassgrid-e2e-render-'));
    csvPath = join(workDir, `trips-${ROWS}-rows.csv`);
    await writeTripsCsv(csvPath, ROWS);
    session = await launchApp(csvPath, join(workDir, 'user-data'));
  });

  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus && session) {
      await mkdir(RESULTS_DIR, { recursive: true });
      const path = join(RESULTS_DIR, 'app-logs-render-perf.txt');
      await writeFile(path, session.logs.join(''));
      await testInfo.attach('app-logs', { path, contentType: 'text/plain' });
    }
  });

  test.afterAll(async () => {
    await session?.app.close();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  test('chart create: cached replays and fresh filters, heatmap and bars', async () => {
    if (!session) throw new Error('Electron app failed to launch');
    const { app, page } = session;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await openTrips(page, csvPath, PARQUET);
    results.machine = await machineInfo(app);
    results.instrumented = await instrumented(page);
    console.info(`[render-perf ${ROWS}] instrumented build: ${String(results.instrumented)}`);

    // Cached: a first (cold) create fills the engine's result cache; the next N replay it.
    for (const mark of ['heatmap', 'bar'] as const) {
      push(`${mark}:cold`, await createOnce(page, mark));
      for (let i = 0; i < N; i += 1) {
        const sample = await createOnce(page, mark);
        expect(sample.cached, 'a repeated create is answered from the result cache').toBe(true);
        push(`${mark}:cached`, sample);
      }
      logCreates(`${mark}:cached`);
    }

    // The commit inspector's own cost: cached heatmaps without the per-commit walk.
    if (results.instrumented) {
      await page.evaluate(() => (window as Win).__ggRenderPerf?.setInspect(false));
      for (let i = 0; i < Math.min(N, 10); i += 1) push('heatmap:cached-no-inspect', await createOnce(page, 'heatmap'));
      await page.evaluate(() => (window as Win).__ggRenderPerf?.setInspect(true));
      logCreates('heatmap:cached-no-inspect');
    }

    // Fresh: a new filter before each pair of creates, so every aggregate is computed.
    for (let round = 1; round <= N; round += 1) {
      await addFareFilter(page, 3 + round * 0.25);
      await page.waitForTimeout(SETTLE_MS);
      for (const mark of ['heatmap', 'bar'] as const) {
        const sample = await createOnce(page, mark);
        expect(sample.cached).toBe(false);
        push(`${mark}:fresh`, sample);
      }
      await undo(page);
      await expect(page.getByTestId('filter-fare_amount')).toHaveCount(0);
    }
    logCreates('heatmap:fresh');
    logCreates('bar:fresh');
    expect(session.rendererErrors, 'renderer console errors').toEqual([]);
  });

  test('cross-filter brush with 4 charts, and a grid key press', async () => {
    if (!session) throw new Error('Electron app failed to launch');
    const { page } = session;
    // The first brush builds the cubes (not recorded); then N brushes, each a different range.
    const histogram = await fourCharts(page);
    for (let i = 1; i <= N; i += 1) {
      const [from, to] = BRUSH_PATH[i % BRUSH_PATH.length] ?? [0.2, 0.4];
      await page.waitForTimeout(QUIET_MS);
      const press: { recording: RenderPerfRecording | null } = { recording: null };
      const measured = await brush(page, histogram, from, to, {
        beforeDown: () => arm(page, 'brushstart', 'pointerdown'),
        beforeUp: async () => {
          press.recording = await page.evaluate(() => (window as Win).__ggRenderPerf?.take() ?? null);
          await arm(page, 'brush', 'pointerup');
        },
      });
      const recording = await take(page, 'brush', 'drawn');
      results.brush.push({ measureMs: measured.duration, ...(recording ? { analysis: analyzeInteraction(recording) } : {}) });
      if (press.recording) results.brushStart.push({ analysis: analyzeInteraction(press.recording) });
    }
    const brushStats = stats(results.brush.map((sample) => sample.analysis?.totals.toPresented ?? sample.measureMs ?? 0));
    console.info(`[render-perf ${ROWS}] brush -> last view presented p50 ${brushStats.p50.toFixed(1)} / p95 ${brushStats.p95.toFixed(1)} ms`);

    // One ArrowDown in the grid (focus on a cell first), with the 4 charts and the brush on screen.
    const grid = await gridGeometry(page);
    const cell = grid.cell(2, 1);
    await page.mouse.click(cell.x, cell.y);
    await page.waitForTimeout(QUIET_MS);
    for (let i = 0; i < N; i += 1) {
      await arm(page, 'select', 'keydown');
      await page.keyboard.press(i % 2 === 0 ? 'ArrowDown' : 'ArrowUp');
      const recording = await take(page, 'select', 'commit-end');
      results.select.push(recording ? { analysis: analyzeInteraction(recording) } : {});
    }
    const selectStats = stats(results.select.map((sample) => sample.analysis?.totals.toPresented ?? 0));
    console.info(`[render-perf ${ROWS}] select -> presented p50 ${selectStats.p50.toFixed(1)} / p95 ${selectStats.p95.toFixed(1)} ms`);
    expect(session.rendererErrors, 'renderer console errors').toEqual([]);

    // Leave the panel empty for the profiles.
    await clearCharts(page);
  });

  test('CPU profiles: cached heatmap creates and brushes', async () => {
    if (!session) throw new Error('Electron app failed to launch');
    const { page } = session;
    test.skip(!(await instrumented(page)), 'needs the render-perf build (windows come from its marks)');

    // A failed profile is logged, not thrown: a failure restarts the worker, which would drop the run's results.
    try {
      let profiling = await startProfile(page);
      const createWindows = await cachedCreates(page, PROFILED);
      results.profiles['create-heatmap-cached'] = await stopProfile(profiling, createWindows, 'create-heatmap-cached');

      const histogram = await fourCharts(page);
      profiling = await startProfile(page);
      const brushWindows = await brushes(page, histogram, PROFILED);
      results.profiles['brush'] = await stopProfile(profiling, brushWindows, 'brush');
    } catch (error) {
      console.warn(`[render-perf ${ROWS}] CPU profile failed: ${String(error)}`);
    }
    for (const [name, summary] of Object.entries(results.profiles)) {
      console.info(`[render-perf ${ROWS}] profile ${name}: ${summary.totalMs.toFixed(1)} ms sampled per interaction; ${JSON.stringify(summary.byCategory)}`);
    }
    await clearCharts(page);
  });

  test('main-thread trace: style, layout, paint and script per interaction', async () => {
    if (!session) throw new Error('Electron app failed to launch');
    const { app, page } = session;
    test.skip(!(await instrumented(page)), 'needs the render-perf build (windows come from its marks)');
    try {
      results.traces['create-heatmap-cached'] = await traced(app, page, 'create-heatmap-cached', () => cachedCreates(page, PROFILED));
      const histogram = await fourCharts(page);
      results.traces['brush'] = await traced(app, page, 'brush', () => brushes(page, histogram, PROFILED));
      results.traces['select'] = await traced(app, page, 'select', () => selects(page, PROFILED));
    } catch (error) {
      console.warn(`[render-perf ${ROWS}] trace failed: ${String(error)}`);
    }
    for (const [name, summary] of Object.entries(results.traces)) {
      console.info(`[render-perf ${ROWS}] trace ${name}: main thread busy ${summary.busyMs.toFixed(1)} ms per interaction; ${JSON.stringify(summary.byCategory)}`);
    }
  });
});

// ---------------------------------------------------------------------------

function summarizeCreates(samples: readonly CreateSample[]) {
  const analyses = samples.flatMap((sample) => (sample.analysis ? [sample.analysis] : []));
  const commits = analyses.map((analysis) => analysis.commits);
  return {
    n: samples.length,
    measureMs: stats(samples.map((sample) => sample.measureMs)),
    engineMs: stats(samples.map((sample) => sample.engineMs)),
    ...(analyses.length > 0
      ? {
          totals: statsByField(analyses, (analysis) => analysis.totals),
          milestones: statsByField(analyses, (analysis) => analysis.milestones),
          segments: statsByField(analyses, (analysis) => analysis.segments),
          work: statsByField(analyses, (analysis) => analysis.work),
          bytes: stats(analyses.map((analysis) => analysis.bytes)),
          commits: commitStats(commits),
          after: commitStats(analyses.map((analysis) => analysis.after)),
          drag: commitStats(analyses.map((analysis) => analysis.drag)),
          dragComponents: componentTable(analyses.map((analysis) => analysis.drag)),
          regions: regionTable(commits),
          components: componentTable(commits),
        }
      : {}),
  };
}

/** Numbers to 0.01 (ms): the timer resolution is coarser, and the file stays readable. */
function rounded<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'number' && !Number.isInteger(inner) ? Math.round(inner * 100) / 100 : inner))) as T;
}

/** A sample for the baseline file: commit summaries without their component and region maps; the timeline only when asked. */
function slim(analysis: CreateAnalysis | InteractionAnalysis, timeline: boolean): Record<string, unknown> {
  const totals = (summary: CommitSummary) => ({
    count: summary.count,
    renderMs: summary.renderMs,
    commitMs: summary.commitMs,
    layoutEffectsMs: summary.layoutEffectsMs,
    inspectMs: summary.inspectMs,
    renders: summary.renders,
    wasted: summary.wasted,
  });
  const out: Record<string, unknown> = { ...analysis, commits: totals(analysis.commits), after: totals(analysis.after) };
  if ('drag' in analysis) out['drag'] = totals(analysis.drag);
  if (!timeline) delete out['timeline'];
  return out;
}

function commitStats(summaries: readonly CommitSummary[]) {
  return statsByField(summaries, (summary) => ({
    count: summary.count,
    renderMs: summary.renderMs,
    commitMs: summary.commitMs,
    layoutEffectsMs: summary.layoutEffectsMs,
    inspectMs: summary.inspectMs,
    renders: summary.renders,
    wasted: summary.wasted,
  }));
}

function summarizeInteractions(samples: readonly InteractionSample[]) {
  const analyses = samples.flatMap((sample) => (sample.analysis ? [sample.analysis] : []));
  const commits = analyses.map((analysis) => analysis.commits);
  const measured = samples.flatMap((sample) => (sample.measureMs === undefined ? [] : [sample.measureMs]));
  return {
    n: samples.length,
    ...(measured.length > 0 ? { measureMs: stats(measured) } : {}),
    ...(analyses.length > 0
      ? {
          totals: statsByField(analyses, (analysis) => analysis.totals),
          milestones: statsByField(analyses, (analysis) => analysis.milestones),
          segments: statsByField(analyses, (analysis) => analysis.segments),
          work: statsByField(analyses, (analysis) => analysis.work),
          views: statsByField(analyses, (analysis) =>
            Object.fromEntries(analysis.views.map((view) => [view.view.replace(/^chart:.*$/, 'chart'), { engineMs: view.engineMs, request: view.request, reply: view.reply, drawn: view.drawn, decodeMs: view.decodeMs }])),
          ),
          commits: commitStats(commits),
          after: commitStats(analyses.map((analysis) => analysis.after)),
          regions: regionTable(commits),
          components: componentTable(commits),
        }
      : {}),
  };
}

test('records the render benchmark', async () => {
  test.skip(Object.keys(results.create).length === 0, 'no measurements');
  const name = results.instrumented ? 'render-perf' : 'render-perf-plain';
  const outFile = await writeBaseline(name, rounded({
    benchmark: name,
    description:
      'Chart create (drop -> new chart drawn -> next frame) per phase, cached (engine result cache) and fresh (new filter each); cross-filter brush with 4 charts; one grid key press. React commits and component renders per interaction (wasted = re-rendered with props equal by value and no state/context change).',
    recordedAt: new Date().toISOString(),
    rows: ROWS,
    source: PARQUET ? 'parquet' : 'csv',
    instrumented: results.instrumented ?? false,
    ...results.machine,
    summary: {
      create: Object.fromEntries(Object.entries(results.create).map(([key, samples]) => [key, summarizeCreates(samples)])),
      brush: summarizeInteractions(results.brush),
      brushStart: summarizeInteractions(results.brushStart),
      select: summarizeInteractions(results.select),
      profiles: results.profiles,
      traces: results.traces,
    },
    // Per sample: milestones, segments, work and commit totals (component tallies are in the summary; timelines for the first 3).
    samples: {
      create: Object.fromEntries(Object.entries(results.create).map(([key, samples]) => [key, samples.map((sample, i) => ({ ...sample, ...(sample.analysis ? { analysis: slim(sample.analysis, i < 3) } : {}) }))])),
      brush: results.brush.map((sample, i) => ({ ...sample, ...(sample.analysis ? { analysis: slim(sample.analysis, i < 3) } : {}) })),
      select: results.select.map((sample, i) => ({ ...sample, ...(sample.analysis ? { analysis: slim(sample.analysis, i < 3) } : {}) })),
    },
  }));
  console.info(`render-perf ${ROWS} rows -> ${outFile}`);
});
