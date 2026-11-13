import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import './map-support';
import { BENCHMARK_DIR } from './results';

/*
 * Map frame-time benchmark (milestone L3), in the style of the render-perf
 * harness (docs/render-perf-baseline.md): the production build with the
 * production headers, `?map-demo` with 183 synthetic aircraft (the
 * fixtures' measured peak in view), 5-minute trails, playing, and a
 * scripted ~10 s of drags and wheel zooms. Reports rAF frame intervals
 * (p50, p95, max) and the aircraft layer's CPU time per frame, for that
 * scenario and for the basemap alone (one stationary aircraft, paused) as
 * a control.
 *
 *   pnpm --filter @glassgrid/web e2e:map-perf     # builds, then runs only this spec
 *   GLASSGRID_E2E_MAP_PERF_RUNS=5                 # runs per scenario (default 3)
 *   GLASSGRID_E2E_MAP_PERF_SCENARIOS=basemap-only # a comma-separated subset
 *   GLASSGRID_E2E_MAP_PERF_VIEWPORT=640x400       # CSS px (default 1280x800), at DPR 1
 *
 * Writes e2e-results/map-perf-chromium-<os>-<arch>.json. Skipped in the
 * ordinary `pnpm e2e:web` (it measures; it does not check behaviour).
 */

const ENABLED = process.env['GLASSGRID_E2E_MAP_PERF'] === '1';
const RUNS = Math.max(1, Number(process.env['GLASSGRID_E2E_MAP_PERF_RUNS'] ?? 3) || 3);
const TARGET_P95_MS = 16.7;
const [VIEW_W, VIEW_H] = (process.env['GLASSGRID_E2E_MAP_PERF_VIEWPORT'] ?? '1280x800').split('x').map(Number) as [number, number];
const ONLY = (process.env['GLASSGRID_E2E_MAP_PERF_SCENARIOS'] ?? '').split(',').filter(Boolean);

test.skip(!ENABLED, 'benchmark: set GLASSGRID_E2E_MAP_PERF=1 (pnpm --filter @glassgrid/web e2e:map-perf)');
// The JSON is named and compared as Chromium's (and reads Chromium's renderer processes); other browsers are not benchmarked.
test.skip(({ browserName }) => browserName !== 'chromium', 'benchmark: Chromium only (its numbers are the recorded baseline)');

const SCENARIOS = [
  { id: 'aircraft-183-trails-playing', url: './?map-demo&n=183', note: '183 aircraft, 5-minute trails, playing (dead reckoning every frame), a synthetic poll every 10 s' },
  { id: 'aircraft-183-no-trails-playing', url: './?map-demo&n=183&trails=0', note: 'attribution: the same without trails' },
  { id: 'basemap-only', url: './?map-demo&n=1&paused', note: 'control: the basemap and one stationary aircraft, paused' },
] as const;

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
  p50: +percentile(values, 50).toFixed(2),
  p95: +percentile(values, 95).toFixed(2),
  max: values.length ? +Math.max(...values).toFixed(2) : Number.NaN,
});

/**
 * ~10 s of interaction, timed by the wall clock (a slow frame means fewer
 * moves, not a longer script): 5 drags and 4 wheel zooms, with moves sent
 * as fast as the page takes them (at most one per 16 ms).
 */
async function panAndZoom(page: Page): Promise<void> {
  const box = await page.locator('canvas.maplibregl-canvas').boundingBox();
  if (!box) throw new Error('no map canvas');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const drag = async (dx: number, dy: number, ms: number) => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const start = Date.now();
    for (let t = 0; t < ms; t = Date.now() - start) {
      const f = t / ms;
      await page.mouse.move(cx + dx * f, cy + dy * f);
      await page.waitForTimeout(16);
    }
    await page.mouse.move(cx + dx, cy + dy);
    await page.mouse.up();
  };
  const wheel = async (deltaY: number, ms: number) => {
    await page.mouse.move(cx, cy);
    const start = Date.now();
    while (Date.now() - start < ms) {
      await page.mouse.wheel(0, deltaY);
      await page.waitForTimeout(100);
    }
  };
  await wheel(-120, 1_000); // zoom in
  await drag(260, 120, 1_500);
  await drag(-420, -80, 1_500);
  await wheel(-120, 800);
  await drag(200, -200, 1_200);
  await wheel(120, 1_200); // zoom out
  await drag(-160, 220, 1_200);
  await wheel(120, 600);
  await drag(300, 0, 1_000);
}

interface Run {
  readonly frameIntervalsMs: number[];
  readonly layerCpuMs: number[];
  readonly durationMs: number;
  readonly glyphs: number;
  readonly segments: number;
}

async function measure(page: Page, url: string): Promise<Run> {
  await page.goto(url);
  await expect(page.getByTestId('map-view')).toHaveAttribute('data-state', 'ready');
  await expect.poll(() => page.evaluate(() => window.__ggMapDemo?.stats().frames ?? 0)).toBeGreaterThan(0);
  await page.waitForTimeout(1_500); // glyphs, first tiles and shaders warm
  await page.evaluate(() => {
    window.__ggMapDemo?.resetStats();
    const w = window as unknown as { __ggFrames: number[]; __ggStop: boolean };
    w.__ggFrames = [];
    w.__ggStop = false;
    const loop = (t: number) => {
      w.__ggFrames.push(t);
      if (!w.__ggStop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await panAndZoom(page);
  return page.evaluate(() => {
    const w = window as unknown as { __ggFrames: number[]; __ggStop: boolean };
    w.__ggStop = true;
    const frames = w.__ggFrames;
    const intervals = frames.slice(1).map((t, i) => t - (frames[i] as number));
    const stats = window.__ggMapDemo?.stats();
    return { frameIntervalsMs: intervals, layerCpuMs: [...(stats?.samples ?? [])], durationMs: (frames[frames.length - 1] ?? 0) - (frames[0] ?? 0), glyphs: stats?.glyphs ?? 0, segments: stats?.segments ?? 0 };
  });
}

test('map frame times: 183 aircraft with trails while panning and zooming', async ({ page, browser }) => {
  test.setTimeout(120_000 + RUNS * SCENARIOS.length * 90_000);
  await page.setViewportSize({ width: VIEW_W || 1280, height: VIEW_H || 800 });
  await page.goto('./?map-demo&n=1&paused');
  const conditions = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return { renderer: gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : gl ? String(gl.getParameter(gl.RENDERER)) : 'none', dpr: window.devicePixelRatio, viewport: `${window.innerWidth}x${window.innerHeight}` };
  });
  const results: Record<string, unknown> = {};
  for (const scenario of SCENARIOS.filter((s) => ONLY.length === 0 || ONLY.includes(s.id))) {
    const runs: Run[] = [];
    for (let i = 0; i < RUNS; i += 1) runs.push(await measure(page, scenario.url));
    const intervals = runs.flatMap((r) => r.frameIntervalsMs);
    const cpu = runs.flatMap((r) => r.layerCpuMs);
    results[scenario.id] = {
      note: scenario.note,
      glyphs: runs[0]?.glyphs,
      trailSegments: runs[0]?.segments,
      frameIntervalMs: summary(intervals),
      framesOver16_7ms: intervals.filter((v) => v > TARGET_P95_MS + 0.5).length,
      framesOver33_4ms: intervals.filter((v) => v > 33.4).length,
      aircraftLayerCpuMs: summary(cpu),
      perRun: runs.map((r) => ({ durationMs: +r.durationMs.toFixed(0), frameIntervalMs: summary(r.frameIntervalsMs), aircraftLayerCpuMs: summary(r.layerCpuMs) })),
    };
    console.info(`[map-perf] ${scenario.id}: frame interval ${JSON.stringify(summary(intervals))}, layer CPU ${JSON.stringify(summary(cpu))}`);
  }
  const out = {
    benchmark: 'map-perf',
    date: new Date().toISOString().slice(0, 10),
    runsPerScenario: RUNS,
    targetP95Ms: TARGET_P95_MS,
    conditions: {
      ...conditions,
      browser: `Chromium ${browser.version()} (headless)`,
      os: `${platform()} ${arch()}`,
      cpu: `${cpus().length} × ${cpus()[0]?.model ?? 'unknown'}`,
      memoryGb: +(totalmem() / 2 ** 30).toFixed(1),
      build: 'production build (vite build), served by e2e/serve.ts with the production headers',
      interaction: '10 s per run by the wall clock: 4 wheel zooms (one tick per 100 ms) and 5 mouse drags (a move per frame, at most one per 16 ms)',
    },
    scenarios: results,
  };
  const dir = BENCHMARK_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `map-perf-chromium-${platform()}-${arch()}${VIEW_W === 1280 && VIEW_H === 800 ? '' : `-${VIEW_W}x${VIEW_H}`}.json`);
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.info(`[map-perf] wrote ${file}`);
});
