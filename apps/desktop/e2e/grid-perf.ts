import { writeFileSync } from 'node:fs';
import type { CDPSession, ElectronApplication, Page } from '@playwright/test';

/*
 * Scroll and memory measurements for the M2 exit gate, in the real Electron
 * window (docs/technical-design.md, "Performance budgets"):
 *
 * - frame intervals from requestAnimationFrame timestamps in the page;
 * - main-thread work per frame from a Chrome trace over CDP: the renderer
 *   main thread's top-level task time (RunTask) between consecutive frame
 *   starts (the first rAF callback of each frame), plus the rAF callbacks
 *   alone (FireAnimationFrame), which is what the grid benchmark
 *   (packages/ui bench:grid) reports;
 * - compositor-presented frames (DrawFrame intervals), reported as measured;
 * - renderer memory from app.getAppMetrics() (the renderer process's working
 *   set) and the JS heap from CDP Performance.getMetrics.
 *
 * rAF intervals are vsync-quantised (16.67 ms at 60 Hz plus timer jitter), so
 * the budget "scroll p95 < 16.7 ms" is read as in the grid benchmark: p95
 * frame interval within one vsync plus 1 ms, and p95 main-thread work per
 * frame under 16.7 ms.
 */

export const FRAME_BUDGET_MS = 16.7;

export interface Stats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Share of samples over the 16.7 ms budget. */
  over: number;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

export function stats(values: readonly number[]): Stats {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : Number.NaN,
    over: values.length ? values.filter((v) => v > FRAME_BUDGET_MS).length / values.length : Number.NaN,
  };
}

interface TraceEvent {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { name?: string } & Record<string, unknown>;
}

async function startTrace(cdp: CDPSession): Promise<void> {
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    traceConfig: {
      includedCategories: [
        'toplevel',
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.frame',
        'blink.user_timing',
      ],
      excludedCategories: ['*'],
    },
  });
}

async function stopTrace(cdp: CDPSession): Promise<TraceEvent[]> {
  const complete = new Promise<{ stream?: string }>((resolve) => {
    cdp.once('Tracing.tracingComplete', resolve);
  });
  await cdp.send('Tracing.end');
  const { stream } = await complete;
  if (!stream) return [];
  let text = '';
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream, size: 1 << 20 });
    text += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  const parsed = JSON.parse(text) as { traceEvents?: TraceEvent[] } | TraceEvent[];
  return Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
}

/** Frame figures from the trace between two user-timing marks. */
function traceFrames(events: readonly TraceEvent[], startMark: string, endMark: string) {
  const mark = (name: string) => events.find((e) => e.name === name && e.cat.includes('blink.user_timing'))?.ts;
  const start = mark(startMark);
  const end = mark(endMark);
  const empty = { drawIntervals: stats([]), mainThreadPerFrame: stats([]), rafWork: stats([]), longestTaskMs: Number.NaN };
  if (start === undefined || end === undefined) return empty;
  // The page's main thread: the thread that recorded the marks.
  const marker = events.find((e) => e.name === startMark && e.cat.includes('blink.user_timing'));
  if (!marker) return empty;
  const onMain = (e: TraceEvent) => e.pid === marker.pid && e.tid === marker.tid;
  const inside = (e: TraceEvent) => e.ts >= start && e.ts <= end;

  const draws = events
    .filter((e) => e.name === 'DrawFrame' && e.pid === marker.pid && inside(e))
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  const drawIntervals: number[] = [];
  for (let i = 1; i < draws.length; i += 1) drawIntervals.push(((draws[i] ?? 0) - (draws[i - 1] ?? 0)) / 1000);

  const rafWork = events.filter((e) => e.name === 'FireAnimationFrame' && e.ph === 'X' && onMain(e) && inside(e)).map((e) => (e.dur ?? 0) / 1000);

  // Main-thread work per frame: top-level task time between consecutive frame starts.
  const tasks = events
    // RunTask only: ThreadControllerImpl::RunTask nests inside it with the same span.
    .filter((e) => e.name === 'RunTask' && e.ph === 'X' && onMain(e) && inside(e))
    .map((e) => ({ start: e.ts, end: e.ts + (e.dur ?? 0) }))
    .sort((a, b) => a.start - b.start);
  // Frame starts: the first rAF callback of each frame (the recorder requests one every frame, so no vsync is skipped).
  const callbacks = events
    .filter((e) => e.name === 'FireAnimationFrame' && e.ph === 'X' && onMain(e) && inside(e))
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  const frames: number[] = [];
  for (const ts of callbacks) if (frames.length === 0 || ts - (frames.at(-1) ?? 0) > 4_000) frames.push(ts);
  const perFrame: number[] = [];
  let t = 0;
  for (let i = 1; i < frames.length; i += 1) {
    const from = frames[i - 1] ?? 0;
    const to = frames[i] ?? 0;
    let busy = 0;
    while (t < tasks.length && (tasks[t]?.end ?? 0) <= from) t += 1;
    for (let k = t; k < tasks.length && (tasks[k]?.start ?? 0) < to; k += 1) {
      const task = tasks[k];
      if (task) busy += Math.max(0, Math.min(task.end, to) - Math.max(task.start, from));
    }
    perFrame.push(busy / 1000);
  }
  const longestTaskMs = tasks.length ? Math.max(...tasks.map((task) => (task.end - task.start) / 1000)) : Number.NaN;
  return { drawIntervals: stats(drawIntervals), mainThreadPerFrame: stats(perFrame), rafWork: stats(rafWork), longestTaskMs };
}

export interface FlingResult {
  /** requestAnimationFrame timestamp deltas while scrolling. */
  rafIntervals: Stats;
  /** Renderer main-thread task time per frame (between consecutive frame starts). */
  mainThreadPerFrame: Stats;
  /** rAF callback durations alone (FireAnimationFrame), as the grid benchmark reports them. */
  rafWork: Stats;
  /** Intervals between frames the compositor drew (DrawFrame). */
  presentedIntervals: Stats;
  longestTaskMs: number;
  /** First body row after the fling. */
  landedRow: number;
  /** From the end of the gesture until every row on screen had its value. */
  landingLoadMs: number;
}

/** Records rAF deltas in the page between start() and stop(). */
async function recordFrames(page: Page, mark: string): Promise<void> {
  await page.evaluate((name) => {
    const state = { frames: [] as number[], running: true };
    (window as unknown as { __ggFrames: typeof state }).__ggFrames = state;
    const loop = (time: number) => {
      if (!state.running) return;
      state.frames.push(time);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    performance.mark(`${name}-start`);
  }, mark);
}

async function stopFrames(page: Page, mark: string): Promise<number[]> {
  return page.evaluate((name) => {
    performance.mark(`${name}-end`);
    const state = (window as unknown as { __ggFrames: { frames: number[]; running: boolean } }).__ggFrames;
    state.running = false;
    const deltas: number[] = [];
    for (let i = 1; i < state.frames.length; i += 1) deltas.push((state.frames[i] ?? 0) - (state.frames[i - 1] ?? 0));
    return deltas;
  }, mark);
}

/** Resolves once every mirrored grid cell has its value; returns how long that took (at least 150 ms: the mirror's throttle). */
export async function waitRowsLoaded(page: Page, timeoutMs = 60_000): Promise<number> {
  return page.evaluate(async (timeout) => {
    const start = performance.now();
    // The mirror follows the visible window at most every 100 ms; let it catch up with the last scroll first.
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (;;) {
      const cells = [...document.querySelectorAll('[data-testid="grid-mirror"] [role="gridcell"]')];
      if (cells.length > 0 && cells.every((cell) => cell.textContent !== 'Loading')) return performance.now() - start;
      if (performance.now() - start > timeout) throw new Error('grid rows did not load');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }, timeoutMs);
}

async function firstVisibleRow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const row = document.querySelector('[data-testid="grid-mirror"] [role="rowgroup"]:nth-child(2) [role="row"]');
    return Number(row?.getAttribute('aria-rowindex') ?? '0') - 2;
  });
}

/** Moves the scrollbar thumb to `toFraction` of the range over `ms` (ease-out), one step per frame. */
async function thumbFling(page: Page, toFraction: number, ms: number): Promise<void> {
  await page.getByTestId('grid-scroller').evaluate(
    async (scroller, [fraction, duration]) => {
      const from = scroller.scrollTop;
      const to = (scroller.scrollHeight - scroller.clientHeight) * fraction;
      const start = performance.now();
      for (;;) {
        const t = Math.min(1, (performance.now() - start) / duration);
        scroller.scrollTop = from + (to - from) * (1 - (1 - t) ** 3);
        if (t >= 1) return;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    },
    [toFraction, ms] as const,
  );
}

/**
 * Two scripted flings over the grid, each measured on its own: a mouse-wheel
 * fling (40,000 px at 12,000 px/s, wheel events as Chromium synthesizes them)
 * and a scrollbar-thumb fling to 60% of a 10M-row range in 1.5 s, which lands
 * on new pages every frame.
 */
export async function fling(app: ElectronApplication, page: Page): Promise<Record<'wheel' | 'thumb', FlingResult>> {
  const cdp = await app.context().newCDPSession(page);
  const box = await page.getByTestId('grid').boundingBox();
  if (!box) throw new Error('grid has no box');
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const recorded: Partial<Record<'wheel' | 'thumb', { frames: number[]; landedRow: number; landingLoadMs: number }>> = {};

  await startTrace(cdp);
  await recordFrames(page, 'gg-wheel');
  await cdp.send('Input.synthesizeScrollGesture', {
    x: Math.round(centre.x),
    y: Math.round(centre.y),
    yDistance: -40_000,
    speed: 12_000,
    gestureSourceType: 'mouse',
    preventFling: false,
  });
  const wheelFrames = await stopFrames(page, 'gg-wheel');
  recorded.wheel = { frames: wheelFrames, landedRow: await firstVisibleRow(page), landingLoadMs: await waitRowsLoaded(page) };

  await recordFrames(page, 'gg-thumb');
  await thumbFling(page, 0.6, 1_500);
  const thumbFrames = await stopFrames(page, 'gg-thumb');
  recorded.thumb = { frames: thumbFrames, landedRow: await firstVisibleRow(page), landingLoadMs: await waitRowsLoaded(page) };
  const events = await stopTrace(cdp);
  await cdp.detach();
  const traceOut = process.env['GLASSGRID_E2E_TRACE'];
  if (traceOut) writeFileSync(traceOut, JSON.stringify(events));

  const result = {} as Record<'wheel' | 'thumb', FlingResult>;
  for (const name of ['wheel', 'thumb'] as const) {
    const run = recorded[name];
    if (!run) continue;
    const trace = traceFrames(events, `gg-${name}-start`, `gg-${name}-end`);
    result[name] = {
      rafIntervals: stats(run.frames),
      mainThreadPerFrame: trace.mainThreadPerFrame,
      rafWork: trace.rafWork,
      presentedIntervals: trace.drawIntervals,
      longestTaskMs: trace.longestTaskMs,
      landedRow: run.landedRow,
      landingLoadMs: run.landingLoadMs,
    };
  }
  return result;
}

export interface MemorySample {
  /** ms since the sweep started. */
  atMs: number;
  /** Renderer process working set (app.getAppMetrics), bytes. */
  workingSetBytes: number;
  /** Renderer JS heap in use (CDP Performance.getMetrics), bytes. */
  jsHeapBytes: number;
}

/** One memory sample of the window's renderer process. */
export async function rendererMemory(app: ElectronApplication, cdp: CDPSession, atMs = 0): Promise<MemorySample> {
  const kb = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const pid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId();
    return electronApp.getAppMetrics().find((metric) => metric.pid === pid)?.memory.workingSetSize ?? Number.NaN;
  });
  const { metrics } = await cdp.send('Performance.getMetrics');
  const heap = metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? Number.NaN;
  return { atMs, workingSetBytes: kb * 1024, jsHeapBytes: heap };
}

async function collectGarbage(cdp: CDPSession): Promise<void> {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
}

/**
 * A full scroll from the top to the bottom and back, landing `steps` times
 * each way and waiting for the rows on screen, with renderer memory sampled
 * every 500 ms throughout. "Before" is at the top with rows loaded, "after"
 * at each end; all three after a GC.
 */
export async function scrollSweep(app: ElectronApplication, page: Page, steps = 50) {
  const cdp = await app.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await collectGarbage(cdp);
  const before = await rendererMemory(app, cdp, 0);
  const samples: MemorySample[] = [before];
  const started = Date.now();
  const sampler = { running: true };
  const isRunning = () => sampler.running;
  const loop = (async () => {
    while (isRunning()) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (isRunning()) samples.push(await rendererMemory(app, cdp, Date.now() - started));
    }
  })();
  let pagesLanded = 0;
  for (let step = 1; step <= steps; step += 1) {
    await thumbFling(page, step / steps, 120);
    await waitRowsLoaded(page);
    pagesLanded += 1;
  }
  await collectGarbage(cdp);
  const afterDown = await rendererMemory(app, cdp, Date.now() - started);
  for (let step = steps - 1; step >= 0; step -= 1) {
    await thumbFling(page, step / steps, 120);
    await waitRowsLoaded(page);
    pagesLanded += 1;
  }
  sampler.running = false;
  await loop;
  await collectGarbage(cdp);
  const afterUp = await rendererMemory(app, cdp, Date.now() - started);
  samples.push(afterUp);
  await cdp.detach();
  return { samples, before, afterDown, afterUp, sweepMs: Date.now() - started, pagesLanded };
}
