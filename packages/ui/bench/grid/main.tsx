/*
 * CanvasGrid benchmark page: the grid over a SyntheticSource filling the
 * viewport, plus hooks the runner (../run-grid-bench.ts) drives through
 * `window.__gridBench`. Query parameters: rows, cols, latency, theme.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/fonts.css';
import '../../tokens/glassgrid.css';
import '../../src/styles.css';
import './bench.css';
import { CanvasGrid, SyntheticSource, tokensFor, useCanvasGridState, type CanvasGridHandle, type GridController } from '../../src/index.js';

const params = new URLSearchParams(location.search);
const rowCount = Number(params.get('rows') ?? 10_000_000);
const columnCount = Number(params.get('cols') ?? 12);
const latencyMs = Number(params.get('latency') ?? 30);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';

const source = new SyntheticSource({ rowCount, columnCount, latencyMs });

/** rAF timestamps while recording (preallocated so recording does not allocate). */
const stamps = new Float64Array(1 << 16);
let stampCount = 0;
let recording = false;
/** Bumped per recording so a frame loop left over from the previous one stops. */
let recordingId = 0;
/** Duration of each grid paint (the controller's paintNow) while recording. */
const paintTimes = new Float64Array(1 << 16);
let paintCount = 0;

function frameLoop(id: number) {
  const onFrame = (time: number) => {
    if (!recording || id !== recordingId) return;
    if (stampCount < stamps.length) stamps[stampCount++] = time;
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
}

interface PerformanceMemory {
  usedJSHeapSize: number;
}

function usedHeap(): number {
  return (performance as Performance & { memory?: PerformanceMemory }).memory?.usedJSHeapSize ?? Number.NaN;
}

function collectGarbage() {
  (globalThis as { gc?: () => void }).gc?.();
}

let handle: CanvasGridHandle | null = null;
let firstRowsAt: number | null = null;
let instrumented: GridController | null = null;

function controller(): GridController {
  const current = handle?.controller;
  if (!current) throw new Error('grid not mounted');
  if (instrumented !== current) {
    instrumented = current;
    const paint = current.paintNow.bind(current);
    current.paintNow = () => {
      const start = performance.now();
      paint();
      if (recording && paintCount < paintTimes.length) paintTimes[paintCount++] = performance.now() - start;
    };
  }
  return current;
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

const bench = {
  rowCount,
  source,
  get firstRowsAt() {
    return firstRowsAt;
  },
  get window() {
    return handle?.window ?? null;
  },
  /** The scroll container (for native scrollTop flings). */
  scroller(): HTMLElement {
    const element = document.querySelector<HTMLElement>('.gg-cgrid__scroller');
    if (!element) throw new Error('no scroller');
    return element;
  },
  startRecording() {
    controller();
    stampCount = 0;
    paintCount = 0;
    recording = true;
    recordingId += 1;
    frameLoop(recordingId);
  },
  /** Stops recording; returns rAF deltas and paint durations in ms. */
  stopRecording(): { frames: number[]; paints: number[] } {
    recording = false;
    const frames: number[] = [];
    for (let i = 1; i < stampCount; i += 1) frames.push((stamps[i] ?? 0) - (stamps[i - 1] ?? 0));
    return { frames, paints: Array.from(paintTimes.subarray(0, paintCount)) };
  },
  /** Waits until every visible row has data; resolves with the wait in ms (or -1 on timeout). */
  async waitLoaded(timeoutMs = 10_000): Promise<number> {
    const start = performance.now();
    for (;;) {
      await nextFrame();
      const frame = controller().frame;
      if (frame.visibleRows > 0 && frame.loadedRows >= frame.visibleRows) return performance.now() - start;
      if (performance.now() - start > timeoutMs) return -1;
    }
  },
  /**
   * Flings the scrollbar thumb: moves scrollTop from where it is to
   * `toFraction` of the range over `ms`, easing out, one step per frame —
   * like a fast thumb drag, landing on new pages every frame.
   */
  async thumbFling(toFraction: number, ms: number): Promise<void> {
    const scroller = bench.scroller();
    const from = scroller.scrollTop;
    const to = (scroller.scrollHeight - scroller.clientHeight) * toFraction;
    const start = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - start) / ms);
      const eased = 1 - (1 - t) ** 3;
      scroller.scrollTop = from + (to - from) * eased;
      if (t >= 1) return;
      await nextFrame();
    }
  },
  /** Back to the top, rows loaded. */
  async reset(): Promise<void> {
    handle?.scrollToRow(0);
    await bench.waitLoaded();
  },
  /**
   * Paints `frames` times synchronously with nothing changing (`scroll`
   * false) or scrolling 1px per paint through rows that are already loaded.
   * The runner wraps this in V8's sampling heap profiler.
   */
  paintLoop(frames: number, scroll: boolean): number {
    const grid = controller();
    const top = grid.virtualTop;
    const start = performance.now();
    for (let i = 0; i < frames; i += 1) {
      if (scroll) grid.setVirtualTop(top + i);
      grid.paintNow();
    }
    const elapsed = performance.now() - start;
    if (scroll) grid.setVirtualTop(top);
    return elapsed / frames;
  },
  usedHeap,
  collectGarbage,
};

declare global {
  interface Window {
    __gridBench: typeof bench;
  }
}
window.__gridBench = bench;

function App() {
  const state = useCanvasGridState(source);
  return (
    <CanvasGrid
      source={source}
      tokens={tokensFor(theme)}
      label="Benchmark rows"
      testId="grid"
      handleRef={(value) => {
        handle = value;
      }}
      onFirstRowsPainted={() => {
        if (firstRowsAt === null) {
          firstRowsAt = performance.now();
          performance.mark('grid-first-rows');
        }
      }}
      onCopy={() => undefined}
      {...state}
    />
  );
}

document.documentElement.dataset['ggTheme'] = theme;
const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
