/*
 * Optional timing hook for benchmarks: off (null) in the app, so the only
 * cost is a null check per redraw.
 *
 * - `layers`: building a chart's background and marks layers (data, size or theme changed);
 * - `paint`: compositing a frame (brush or hover changed), the per-frame cost while brushing.
 */
export type ChartPerfEvent = 'layers' | 'paint';

export type ChartPerfHook = (event: ChartPerfEvent, chart: string, ms: number) => void;

let hook: ChartPerfHook | null = null;

export function setChartPerfHook(next: ChartPerfHook | null): void {
  hook = next;
}

export function chartPerfHook(): ChartPerfHook | null {
  return hook;
}
