/*
 * CanvasGrid scroll benchmark in plain Chromium (no Electron).
 *
 *   pnpm --filter @glassgrid/ui bench:grid [-- --runs 3 --rows 10000000 --headed]
 *
 * Builds bench/grid (production React), serves it, and in a 1440×900
 * Chromium page mounts CanvasGrid over a 10M-row, 12-column SyntheticSource.
 * Per run it records, via requestAnimationFrame deltas and a CDP trace:
 *   - wheel fling: a synthesized mouse-wheel scroll gesture (CDP Input);
 *   - thumb fling: the scrollbar flung to 60% of the range in 1.5 s, landing on new pages every frame;
 *   - jump to end: Ctrl+End on the focused grid, then waiting for the last rows;
 * plus JS heap (after GC) before and after, heap samples while scrolling,
 * and heap growth per paint in the steady state. Results are printed and
 * written to bench/results/grid-latest.json.
 *
 * Chromium: GLASSGRID_CHROMIUM, else Playwright's own build, else the
 * newest chromium-* under PLAYWRIGHT_BROWSERS_PATH. Never downloads one.
 * Extra flags (e.g. --disable-gpu) go in GLASSGRID_CHROMIUM_ARGS.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type CDPSession, type Page } from 'playwright-core';
import { build, preview } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? Number(args[index + 1]) : Number.NaN;
  return Number.isFinite(value) ? value : fallback;
};
const RUNS = option('runs', 3);
const ROWS = option('rows', 10_000_000);
const COLS = option('cols', 12);
const LATENCY = option('latency', 30);
const VIEWPORT = { width: 1440, height: 900 };
const BUDGET_MS = 16.7;

function findChromium(): string {
  const fromEnv = process.env['GLASSGRID_CHROMIUM'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const own = chromium.executablePath();
    if (existsSync(own)) return own;
  } catch {
    // Not installed for this Playwright version.
  }
  const root = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '/opt/pw-browsers';
  if (existsSync(join(root, 'chromium'))) return join(root, 'chromium');
  const builds = existsSync(root) ? readdirSync(root).filter((name) => /^chromium-\d+$/.test(name)) : [];
  builds.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const name of builds) {
    for (const candidate of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
      const path = join(root, name, candidate);
      if (existsSync(path)) return path;
    }
  }
  throw new Error('No Chromium found: set GLASSGRID_CHROMIUM or PLAYWRIGHT_BROWSERS_PATH (this script never downloads browsers).');
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

interface Stats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Share of frames over the 16.7 ms budget. */
  over: number;
  /** Share of frames that missed at least one vsync (interval over 1.5 × 16.7 ms). */
  dropped: number;
}

function stats(values: readonly number[]): Stats {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : Number.NaN,
    over: values.length ? values.filter((v) => v > BUDGET_MS).length / values.length : Number.NaN,
    dropped: values.length ? values.filter((v) => v > BUDGET_MS * 1.5).length / values.length : Number.NaN,
  };
}

const median = (values: readonly number[]) => percentile(values, 50);

interface TraceEvent {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
}

async function startTrace(cdp: CDPSession): Promise<void> {
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    traceConfig: {
      includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'blink.user_timing', 'v8'],
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

/**
 * Frame figures from the trace between two user-timing marks: intervals
 * between DrawFrame events of the renderer's compositor (presented frames),
 * and main-thread animation-frame callback durations (FireAnimationFrame).
 */
function traceFrames(events: readonly TraceEvent[], startMark: string, endMark: string) {
  const mark = (name: string) => events.find((e) => e.name === name && e.cat.includes('blink.user_timing'))?.ts;
  const start = mark(startMark);
  const end = mark(endMark);
  if (start === undefined || end === undefined) return { drawIntervals: stats([]), animationFrames: stats([]), gcMs: 0 };
  const inside = (e: TraceEvent) => e.ts >= start && e.ts <= end;
  const draws = events
    .filter((e) => e.name === 'DrawFrame' && inside(e))
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  const drawIntervals: number[] = [];
  for (let i = 1; i < draws.length; i += 1) drawIntervals.push(((draws[i] ?? 0) - (draws[i - 1] ?? 0)) / 1000);
  const animationFrames = events.filter((e) => e.name === 'FireAnimationFrame' && e.ph === 'X' && inside(e)).map((e) => (e.dur ?? 0) / 1000);
  const gcMs = events
    .filter((e) => (e.name === 'MinorGC' || e.name === 'MajorGC' || e.name === 'V8.GCScavenger' || e.name === 'V8.GCFinalizeMC') && e.ph === 'X' && inside(e))
    .reduce((sum, e) => sum + (e.dur ?? 0) / 1000, 0);
  return { drawIntervals: stats(drawIntervals), animationFrames: stats(animationFrames), gcMs };
}

async function heapAfterGc(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? Number.NaN;
}

async function heapNow(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? Number.NaN;
}

/** Samples JS heap every 500 ms until stopped. */
function sampleHeap(cdp: CDPSession) {
  const samples: number[] = [];
  const state = { running: true };
  const loop = (async () => {
    while (state.running) {
      samples.push(await heapNow(cdp));
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();
  return {
    async stop() {
      state.running = false;
      await loop;
      return samples;
    },
  };
}

interface SamplingNode {
  callFrame: { functionName: string };
  selfSize: number;
  children: SamplingNode[];
}

const STEADY_FRAMES = 2_000;

/**
 * Bytes allocated per paint in the steady state, from V8's sampling heap
 * profiler (32-byte sampling interval): everything allocated under the
 * controller's paintNow, after a warm-up pass over the same frames. The
 * JS heap size delta is not used here: it moves with JIT code and
 * feedback, not with what the paint loop allocates.
 */
async function steadyState(page: Page, cdp: CDPSession, scroll: boolean) {
  await page.evaluate((s) => window.__gridBench.paintLoop(600, s), scroll);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32 });
  const msPerPaint = await page.evaluate(([frames, s]) => window.__gridBench.paintLoop(frames, s), [STEADY_FRAMES, scroll] as const);
  const { profile } = (await cdp.send('HeapProfiler.stopSampling')) as unknown as { profile: { head: SamplingNode } };
  let paintBytes = 0;
  const walk = (node: SamplingNode, inPaint: boolean) => {
    const here = inPaint || node.callFrame.functionName === 'paintNow';
    if (here) paintBytes += node.selfSize;
    for (const child of node.children) walk(child, here);
  };
  walk(profile.head, false);
  return { frames: STEADY_FRAMES, msPerPaint, paintBytes, bytesPerFrame: paintBytes / STEADY_FRAMES };
}

interface ScenarioResult {
  rafFrames: Stats;
  paints: Stats;
  drawIntervals: Stats;
  animationFrames: Stats;
  gcMs: number;
  extra: Record<string, number | boolean | string>;
}

/** Records rAF deltas and paint durations around `body`, between user-timing marks for the trace. */
async function scenario(page: Page, name: string, body: () => Promise<Record<string, number | boolean | string>>): Promise<ScenarioResult> {
  await page.evaluate((mark) => {
    window.__gridBench.startRecording();
    performance.mark(`${mark}-start`);
  }, name);
  const extra = await body();
  const recorded = await page.evaluate((mark) => {
    performance.mark(`${mark}-end`);
    return window.__gridBench.stopRecording();
  }, name);
  // Trace figures are filled in once the trace is collected.
  return { rafFrames: stats(recorded.frames), paints: stats(recorded.paints), drawIntervals: stats([]), animationFrames: stats([]), gcMs: 0, extra };
}

async function runOnce(url: string, executablePath: string, run: number) {
  const browser = await chromium.launch({
    executablePath,
    headless: !flag('headed'),
    args: [
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      ...(process.env['GLASSGRID_CHROMIUM_ARGS'] ?? '').split(' ').filter(Boolean),
    ],
  });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');

    const navigationStart = Date.now();
    await page.goto(`${url}?rows=${ROWS}&cols=${COLS}&latency=${LATENCY}`);
    await page.waitForFunction(() => window.__gridBench.firstRowsAt !== null, undefined, { timeout: 30_000 });
    const firstRowsMs = await page.evaluate(() => window.__gridBench.firstRowsAt ?? Number.NaN);
    const wallFirstRows = Date.now() - navigationStart;
    await page.evaluate(() => window.__gridBench.waitLoaded());
    await page.waitForTimeout(500);

    const heapInitial = await heapAfterGc(cdp);
    const heapSampler = sampleHeap(cdp);
    // Warm-up sweep, top to bottom in 20 landings, fills the 50-page LRU; the heap is compared against this point.
    const sweep = async () => {
      for (let step = 1; step <= 20; step += 1) {
        await page.evaluate((to) => window.__gridBench.thumbFling(to, 120), step / 20);
        await page.evaluate(() => window.__gridBench.waitLoaded());
      }
      await page.evaluate(() => window.__gridBench.reset());
    };
    await sweep();
    const heapBefore = await heapAfterGc(cdp);
    await startTrace(cdp);

    const box = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
    const results: Record<string, ScenarioResult> = {};

    results['wheelFling'] = await scenario(page, 'wheel-fling', async () => {
      // A fast mouse-wheel fling: 40,000 px at 12,000 px/s, wheel ticks as Chromium synthesizes them.
      await cdp.send('Input.synthesizeScrollGesture', {
        x: box.x,
        y: box.y,
        yDistance: -40_000,
        speed: 12_000,
        gestureSourceType: 'mouse',
        preventFling: false,
      });
      const landed = await page.evaluate(() => window.__gridBench.window?.firstRow ?? -1);
      const loadMs = await page.evaluate(() => window.__gridBench.waitLoaded());
      return { landedRow: landed, landingLoadMs: loadMs };
    });

    results['thumbFling'] = await scenario(page, 'thumb-fling', async () => {
      await page.evaluate(() => window.__gridBench.thumbFling(0.6, 1_500));
      const landed = await page.evaluate(() => window.__gridBench.window?.firstRow ?? -1);
      const loadMs = await page.evaluate(() => window.__gridBench.waitLoaded());
      return { landedRow: landed, landingLoadMs: loadMs };
    });

    results['jumpToEnd'] = await scenario(page, 'jump-to-end', async () => {
      await page.mouse.click(box.x, box.y);
      const start = Date.now();
      await page.keyboard.press('Control+End');
      const loadMs = await page.evaluate(() => window.__gridBench.waitLoaded());
      const elapsed = Date.now() - start;
      await page.waitForTimeout(300);
      const state = await page.evaluate(() => {
        const bench = window.__gridBench;
        const last = bench.rowCount - 1;
        return { lastVisibleRow: bench.window?.lastRow ?? -1, lastCell: bench.source.getCell(last, 0) ?? 'unloaded', expected: String(bench.rowCount) };
      });
      return {
        lastVisibleRow: state.lastVisibleRow,
        lastRowReached: state.lastCell === state.expected && state.lastVisibleRow === ROWS - 1,
        landingLoadMs: loadMs,
        keyToRowsMs: elapsed,
      };
    });

    const events = await stopTrace(cdp);
    const heapSamples = await heapSampler.stop();
    for (const [key, mark] of [
      ['wheelFling', 'wheel-fling'],
      ['thumbFling', 'thumb-fling'],
      ['jumpToEnd', 'jump-to-end'],
    ] as const) {
      const result = results[key];
      if (!result) continue;
      const trace = traceFrames(events, `${mark}-start`, `${mark}-end`);
      result.drawIntervals = trace.drawIntervals;
      result.animationFrames = trace.animationFrames;
      result.gcMs = trace.gcMs;
    }

    // A second full sweep: memory must come back to where the first left it.
    await sweep();

    // Steady state: repaint with nothing changing, and scrolling 1px per paint through loaded rows.
    await page.evaluate(() => window.__gridBench.reset());
    const steadyStatic = await steadyState(page, cdp, false);
    const steadyScroll = await steadyState(page, cdp, true);

    const heapAfter = await heapAfterGc(cdp);
    const pages = await page.evaluate(() => ({ served: window.__gridBench.source.pagesServed, cached: window.__gridBench.source.cachedPages.length }));
    await context.close();
    return {
      run,
      firstRowsMs,
      wallFirstRows,
      heapInitial,
      heapBefore,
      heapAfter,
      heapSamplesMax: Math.max(...heapSamples),
      heapSamplesMin: Math.min(...heapSamples),
      heapSamples: heapSamples.length,
      steadyStatic,
      steadyScroll,
      pages,
      errors,
      results,
    };
  } finally {
    await browser.close();
  }
}

const fmt = (value: number, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : '–');
const mb = (bytes: number) => `${fmt(bytes / 1024 / 1024, 2)} MB`;

async function main() {
  const executablePath = findChromium();
  const outDir = join(here, '.out');
  await build({ configFile: join(here, 'vite.config.ts'), logLevel: 'warn', build: { outDir, emptyOutDir: true } });
  const server = await preview({ configFile: join(here, 'vite.config.ts'), logLevel: 'warn', build: { outDir }, preview: { port: 0, host: '127.0.0.1' } });
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('preview server has no URL');
  const runs: Awaited<ReturnType<typeof runOnce>>[] = [];
  try {
    for (let run = 1; run <= RUNS; run += 1) {
      process.stdout.write(`run ${run}/${RUNS}…\n`);
      runs.push(await runOnce(url, executablePath, run));
    }
  } finally {
    await server.close();
  }

  const scenarios = ['wheelFling', 'thumbFling', 'jumpToEnd'] as const;
  const summary = Object.fromEntries(
    scenarios.map((name) => {
      const pick = (field: 'rafFrames' | 'paints' | 'drawIntervals' | 'animationFrames', stat: 'p50' | 'p95' | 'p99' | 'max') =>
        median(runs.map((r) => r.results[name]?.[field][stat] ?? Number.NaN));
      return [
        name,
        {
          rafFrames: {
            p50: pick('rafFrames', 'p50'),
            p95: pick('rafFrames', 'p95'),
            p99: pick('rafFrames', 'p99'),
            max: pick('rafFrames', 'max'),
            dropped: median(runs.map((r) => r.results[name]?.rafFrames.dropped ?? Number.NaN)),
          },
          drawIntervals: { p50: pick('drawIntervals', 'p50'), p95: pick('drawIntervals', 'p95'), p99: pick('drawIntervals', 'p99') },
          paints: { p50: pick('paints', 'p50'), p95: pick('paints', 'p95'), p99: pick('paints', 'p99'), max: pick('paints', 'max') },
          animationFrames: { p50: pick('animationFrames', 'p50'), p95: pick('animationFrames', 'p95'), p99: pick('animationFrames', 'p99') },
        },
      ];
    }),
  );

  const machine = { cpus: cpus().length, cpuModel: cpus()[0]?.model ?? 'unknown', memoryGb: Math.round(totalmem() / 1024 ** 3), chromium: executablePath };
  const report = {
    date: new Date().toISOString(),
    machine,
    config: { rows: ROWS, cols: COLS, latencyMs: LATENCY, viewport: VIEWPORT, runs: RUNS },
    summary,
    runs,
  };
  const resultsDir = join(here, 'results');
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, 'grid-latest.json'), `${JSON.stringify(report, null, 2)}\n`);

  console.info(`\nCanvasGrid benchmark · ${ROWS.toLocaleString('en-US')} rows × ${COLS} columns · ${VIEWPORT.width}×${VIEWPORT.height} · ${RUNS} run(s), medians`);
  console.info(`machine: ${machine.cpus} vCPU ${machine.cpuModel}, ${machine.memoryGb} GB · ${executablePath}\n`);
  console.info('scenario       frame interval (rAF Δ) p50/p95/p99 ms, dropped   presented (DrawFrame Δ) p50/p95/p99   rAF work (trace) p50/p95/p99   paint() p50/p95/p99/max ms');
  for (const name of scenarios) {
    const s = summary[name];
    if (!s) continue;
    console.info(
      `${name.padEnd(14)} ${`${fmt(s.rafFrames.p50)} / ${fmt(s.rafFrames.p95)} / ${fmt(s.rafFrames.p99)}, ${fmt(s.rafFrames.dropped * 100)}%`.padEnd(49)} ${`${fmt(s.drawIntervals.p50)} / ${fmt(s.drawIntervals.p95)} / ${fmt(s.drawIntervals.p99)}`.padEnd(37)} ${`${fmt(s.animationFrames.p50, 2)} / ${fmt(s.animationFrames.p95, 2)} / ${fmt(s.animationFrames.p99, 2)}`.padEnd(30)} ${fmt(s.paints.p50, 2)} / ${fmt(s.paints.p95, 2)} / ${fmt(s.paints.p99, 2)} / ${fmt(s.paints.max, 2)}`,
    );
  }
  console.info('');
  for (const r of runs) {
    const jump = r.results['jumpToEnd']?.extra ?? {};
    console.info(
      `run ${r.run}: first rows ${fmt(r.firstRowsMs, 0)} ms after navigation start · JS heap after GC: ${mb(r.heapInitial)} at first rows, ${mb(r.heapBefore)} with the page cache full, ${mb(r.heapAfter)} after all scenarios and a second full sweep (Δ ${mb(r.heapAfter - r.heapBefore)}) · sampled while scrolling ${mb(r.heapSamplesMin)}–${mb(r.heapSamplesMax)} · steady-state paint allocations ${fmt(r.steadyStatic.bytesPerFrame, 1)} B/frame static, ${fmt(r.steadyScroll.bytesPerFrame, 1)} B/frame scrolling loaded rows (${fmt(r.steadyStatic.msPerPaint, 2)} / ${fmt(r.steadyScroll.msPerPaint, 2)} ms per paint) · last row reached: ${String(jump['lastRowReached'])} (${String(jump['keyToRowsMs'])} ms) · pages served ${r.pages.served}, cached ${r.pages.cached}${r.errors.length ? ` · page errors: ${r.errors.join('; ')}` : ''}`,
    );
  }
  // rAF intervals are vsync-quantized (16.67 ms at 60 Hz plus timer jitter), so "p95 < 16.7 ms"
  // is read as: p95 interval within one vsync (+1 ms jitter) and p95 frame work under 16.7 ms.
  const worstP95 = Math.max(...scenarios.map((name) => summary[name]?.rafFrames.p95 ?? Number.NaN));
  const worstWork = Math.max(...scenarios.map((name) => summary[name]?.animationFrames.p95 ?? Number.NaN));
  const met = worstP95 <= BUDGET_MS + 1 && worstWork < BUDGET_MS;
  console.info(
    `\np95 frame interval (worst scenario): ${fmt(worstP95, 2)} ms; p95 rAF work: ${fmt(worstWork, 2)} ms — budget p95 < ${BUDGET_MS} ms (one vsync): ${met ? 'met' : 'NOT met'}`,
  );
  console.info(`results: ${join(resultsDir, 'grid-latest.json')}`);
}

await main();
