/*
 * Optional timing hook for benchmarks: off (null) in the app, so the only
 * cost is a null check per redraw.
 *
 * - `layers`: building a chart's background and marks layers (data, size or theme changed);
 * - `paint`: compositing a frame (brush or hover changed), the per-frame cost while brushing;
 * - `model`: building a chart's model (scales, layout, data indexes) for a new result or size, in render.
 */
export type ChartPerfEvent = 'layers' | 'paint' | 'model';

export type ChartPerfHook = (event: ChartPerfEvent, chart: string, ms: number) => void;

let hook: ChartPerfHook | null = null;

export function setChartPerfHook(next: ChartPerfHook | null): void {
  hook = next;
}

export function chartPerfHook(): ChartPerfHook | null {
  return hook;
}

/** Runs `work`, reporting its duration as `event` when a hook is set (just runs it otherwise). */
export function timedChartWork<T>(event: ChartPerfEvent, chart: string, work: () => T): T {
  const current = hook;
  if (!current) return work();
  const start = performance.now();
  const result = work();
  current(event, chart, performance.now() - start);
  return result;
}
