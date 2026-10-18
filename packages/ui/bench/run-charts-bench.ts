/*
 * Chart benchmark in plain Chromium (no Electron).
 *
 *   pnpm --filter @glassgrid/ui bench:charts [-- --runs 3 --dpr 1 --scenarios line,heatmap --headed]
 *
 * Builds bench/charts (production React), serves it, and per scenario and
 * run loads the page at a 1,000 px plot width and records:
 *   - first render: page start → first chart layers drawn (includes React mount);
 *   - adapter: Arrow result → typed columns;
 *   - redraw: 15 forced full redraws (React render, model and hit index,
 *     background and marks layers, composite), synchronous, ms each;
 *   - brush drag: a scripted pointer drag (create, then move) with rAF
 *     intervals and the per-frame composite time ChartFrame reports;
 *   - scatter-webgl: overlay frames finished on the GPU (readPixels), and
 *     the WebGL renderer string (SwiftShader on a GPU-less VM).
 * Budgets: canvas redraw < 8 ms; 1M-point WebGL scatter at 60 fps.
 * Results: bench/results/charts-latest.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { build, preview } from 'vite';
import { findChromium, percentile } from './chromium.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? Number(args[index + 1]) : Number.NaN;
  return Number.isFinite(value) ? value : fallback;
};
const listOption = (name: string, fallback: readonly string[]) => {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value ? value.split(',') : [...fallback];
};

const ALL = ['line', 'histogram', 'heatmap', 'bar', 'scatter-canvas', 'scatter-webgl'] as const;
const SCENARIOS = listOption('scenarios', ALL);
const RUNS = option('runs', 3);
const DPR = option('dpr', 1);
const WIDTH = 1000;
const REDRAW_BUDGET_MS = 8;
const FRAME_BUDGET_MS = 1000 / 60;

interface Summary {
  p50: number;
  p95: number;
  max: number;
  count: number;
}

function summary(values: readonly number[]): Summary {
  return { p50: percentile(values, 50), p95: percentile(values, 95), max: values.length ? Math.max(...values) : Number.NaN, count: values.length };
}

const median = (values: readonly number[]) => percentile(values, 50);

/** Drags across the plot: create a brush over the middle, then move it right and back. */
async function brushDrag(page: Page, mark: string): Promise<void> {
  const rect = await page.evaluate(() => window.__chartBench.plotRect());
  const y0 = rect.top + rect.height * 0.3;
  const y1 = rect.top + rect.height * (mark.startsWith('scatter') || mark === 'heatmap' ? 0.7 : 0.3);
  const x = (f: number) => rect.left + rect.width * f;
  await page.mouse.move(x(0.3), y0);
  await page.mouse.down();
  await page.mouse.move(x(0.5), y1, { steps: 40 });
  await page.mouse.up();
  // Grab the middle of the brush and move it.
  await page.mouse.move(x(0.4), (y0 + y1) / 2);
  await page.mouse.down();
  await page.mouse.move(x(0.75), (y0 + y1) / 2, { steps: 60 });
  await page.mouse.move(x(0.35), (y0 + y1) / 2, { steps: 60 });
  await page.mouse.up();
}

async function runScenario(url: string, executablePath: string, scenario: string) {
  const browser = await chromium.launch({
    executablePath,
    headless: !flag('headed'),
    args: [
      '--no-first-run',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      // Software WebGL where there is no GPU (the shared VM): SwiftShader through ANGLE.
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      ...(process.env['GLASSGRID_CHROMIUM_ARGS'] ?? '').split(' ').filter(Boolean),
    ],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: DPR });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${url}?scenario=${scenario}&width=${WIDTH}`);
    await page.waitForFunction(() => window.__chartBench.firstRenderMs !== null, undefined, { timeout: 60_000 });
    await page.evaluate(() => window.__chartBench.settle(20));
    const info = await page.evaluate(() => ({
      rows: window.__chartBench.rows,
      generateMs: window.__chartBench.generateMs,
      adapterMs: window.__chartBench.adapterMs,
      firstRenderMs: window.__chartBench.firstRenderMs ?? Number.NaN,
      webgl: window.__chartBench.webgl(),
    }));

    // Full redraws after a warm-up: same result (resize, theme, formatter) and a new result (adapter included).
    const { redraws, fresh } = await page.evaluate((large) => {
      const bench = window.__chartBench;
      for (let i = 0; i < 3; i += 1) bench.rerender();
      const same: number[] = [];
      for (let i = 0; i < 15; i += 1) same.push(bench.rerender());
      const renewed: number[] = [];
      for (let i = 0; i < (large ? 3 : 15); i += 1) renewed.push(bench.rerender(true));
      return { redraws: same, fresh: renewed };
    }, scenario === 'scatter-webgl');
    await page.evaluate(() => window.__chartBench.settle(5));

    // Brush drag (bars do not brush: hover across them instead).
    await page.evaluate(() => window.__chartBench.startRecording());
    if (scenario === 'bar') {
      const rect = await page.evaluate(() => window.__chartBench.plotRect());
      await page.mouse.move(rect.left + 50, rect.top + 2);
      await page.mouse.move(rect.left + 50, rect.top + rect.height - 2, { steps: 80 });
    } else {
      await brushDrag(page, scenario);
    }
    await page.evaluate(() => window.__chartBench.settle(3));
    const recorded = await page.evaluate(() => window.__chartBench.stopRecording());
    const webglAfter = await page.evaluate(() => window.__chartBench.webgl());
    // GPU-finished overlay frames per strategy (instanced quads are very slow on software renderers: few frames).
    const glFrames = scenario === 'scatter-webgl' ? await page.evaluate(() => window.__chartBench.glFrames(10, 'points')) : [];
    const glInstanced = scenario === 'scatter-webgl' && !flag('skip-instanced') ? await page.evaluate(() => window.__chartBench.glFrames(2, 'instanced')) : [];
    await context.close();
    return { scenario, ...info, redraws, fresh, drag: recorded, glFrames, glInstanced, webglAfter, errors };
  } finally {
    await browser.close();
  }
}

const fmt = (value: number, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '–');

async function main() {
  const executablePath = findChromium();
  const outDir = join(here, '.out-charts');
  const config = join(here, 'vite.charts.config.ts');
  await build({ configFile: config, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
  const server = await preview({ configFile: config, logLevel: 'warn', build: { outDir }, preview: { port: 0, host: '127.0.0.1' } });
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('preview server has no URL');
  const results: Awaited<ReturnType<typeof runScenario>>[] = [];
  try {
    for (const scenario of SCENARIOS) {
      for (let run = 1; run <= RUNS; run += 1) {
        process.stdout.write(`${scenario} run ${run}/${RUNS}…\n`);
        results.push(await runScenario(url, executablePath, scenario));
      }
    }
  } finally {
    await server.close();
  }

  const table = SCENARIOS.map((scenario) => {
    const runs = results.filter((r) => r.scenario === scenario);
    const pick = (f: (r: (typeof runs)[number]) => number) => median(runs.map(f));
    const redraw = summary(runs.flatMap((r) => r.redraws));
    const newResult = summary(runs.flatMap((r) => r.fresh));
    const paint = summary(runs.flatMap((r) => r.drag.paints));
    const frames = summary(runs.flatMap((r) => r.drag.frames));
    const gl = summary(runs.flatMap((r) => r.glFrames));
    const glInstanced = summary(runs.flatMap((r) => r.glInstanced));
    return {
      scenario,
      rows: runs[0]?.rows ?? 0,
      adapterMs: pick((r) => r.adapterMs),
      firstRenderMs: pick((r) => r.firstRenderMs),
      redraw,
      newResult,
      dragComposite: paint,
      dragFrameInterval: frames,
      glFrame: gl,
      glFrameInstanced: glInstanced,
      webgl: runs[0]?.webgl,
      errors: runs.flatMap((r) => r.errors),
    };
  });

  const machine = { cpus: cpus().length, cpuModel: cpus()[0]?.model ?? 'unknown', memoryGb: Math.round(totalmem() / 1024 ** 3), chromium: executablePath };
  const report = { date: new Date().toISOString(), machine, config: { runs: RUNS, dpr: DPR, plotWidth: WIDTH }, summary: table, results };
  const resultsDir = join(here, 'results');
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, 'charts-latest.json'), `${JSON.stringify(report, null, 2)}\n`);

  console.info(`\nChart benchmark · plot ${WIDTH} CSS px at DPR ${DPR} · ${RUNS} run(s) per scenario, pooled samples`);
  console.info(`machine: ${machine.cpus} vCPU ${machine.cpuModel}, ${machine.memoryGb} GB · ${executablePath}`);
  const renderer = table.find((t) => t.scenario === 'scatter-webgl')?.webgl?.renderer;
  if (renderer) console.info(`WebGL renderer: ${renderer} (dense scatter strategy: ${table.find((t) => t.scenario === 'scatter-webgl')?.webgl?.strategy ?? '–'})`);
  console.info('\nscenario         rows        adapter  first render  redraw p50/p95/max ms   new result p50/p95 ms  drag composite p50/p95 ms  drag frame interval p50/p95 ms  GL frame (GPU-finished) p50/p95 ms');
  for (const t of table) {
    console.info(
      `${t.scenario.padEnd(16)} ${t.rows.toLocaleString('en-US').padStart(9)}  ${fmt(t.adapterMs).padStart(7)}  ${fmt(t.firstRenderMs, 0).padStart(12)}  ${`${fmt(t.redraw.p50)} / ${fmt(t.redraw.p95)} / ${fmt(t.redraw.max)}`.padEnd(22)}  ${`${fmt(t.newResult.p50)} / ${fmt(t.newResult.p95)}`.padEnd(21)}  ${`${fmt(t.dragComposite.p50)} / ${fmt(t.dragComposite.p95)}`.padEnd(25)}  ${`${fmt(t.dragFrameInterval.p50, 1)} / ${fmt(t.dragFrameInterval.p95, 1)}`.padEnd(30)}  ${t.glFrame.count ? `${fmt(t.glFrame.p50, 1)} / ${fmt(t.glFrame.p95, 1)}` : '–'}`,
    );
  }
  const canvas = table.filter((t) => t.scenario !== 'scatter-webgl');
  const worstRedraw = Math.max(...canvas.map((t) => t.redraw.p95));
  console.info(`\ncanvas redraw p95 (worst scenario): ${fmt(worstRedraw)} ms — budget < ${REDRAW_BUDGET_MS} ms: ${worstRedraw < REDRAW_BUDGET_MS ? 'met' : 'NOT met'}`);
  const webgl = table.find((t) => t.scenario === 'scatter-webgl');
  if (webgl) {
    const fps = 1000 / webgl.dragFrameInterval.p50;
    console.info(
      `scatter 1M WebGL: drag frame interval p50 ${fmt(webgl.dragFrameInterval.p50, 1)} ms (${fmt(fps, 0)} fps); GPU-finished frame p50 ${fmt(webgl.glFrame.p50, 1)} ms as points, ${fmt(webgl.glFrameInstanced.p50, 1)} ms as instanced quads — budget 60 fps (${fmt(FRAME_BUDGET_MS, 1)} ms): ${webgl.dragFrameInterval.p50 <= FRAME_BUDGET_MS + 1 ? 'met' : 'NOT met'} on this renderer`,
    );
  }
  const errors = table.flatMap((t) => t.errors);
  if (errors.length > 0) console.info(`page errors: ${errors.join('; ')}`);
  console.info(`results: ${join(resultsDir, 'charts-latest.json')}`);
}

await main();
