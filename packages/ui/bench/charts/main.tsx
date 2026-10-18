/*
 * Chart benchmark page: one chart per load, chosen by `?scenario=`, plus
 * hooks the runner (../run-charts-bench.ts) drives through
 * `window.__chartBench`. Query parameters: scenario, width (plot CSS px),
 * height, theme.
 *
 *   line            LineChart, M4 shape: 4 series × 4,000 points (1,000 px × 4)
 *   histogram       Histogram, 50 bins
 *   heatmap         Heatmap, full 100 × 100 grid
 *   bar             BarChart, 20 bars
 *   scatter-canvas  ScatterChart, 10,000 points, Canvas 2D
 *   scatter-webgl   ScatterChart, 1,000,000 points on the shared WebGL overlay
 */
import { StrictMode, useEffect, useMemo, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '../../src/fonts.css';
import '../../tokens/glassgrid.css';
import '../../src/styles.css';
import './bench.css';
import {
  BarChart,
  Heatmap,
  Histogram,
  LineChart,
  ScatterChart,
  WebGLOverlayProvider,
  barDataFromArrow,
  chartColumnsFromArrow,
  setChartPerfHook,
  syntheticBarTable,
  syntheticHeatmapTable,
  syntheticHistogramTable,
  syntheticLineTable,
  syntheticScatterTable,
  tokensFor,
  type ChartMark,
  type IntervalSelection,
  type WebGLOverlayManager,
} from '../../src/index.js';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'line';
const width = Number(params.get('width') ?? 1000);
const height = Number(params.get('height') ?? 240);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
/** Points of the WebGL scatter (default 1,000,000). */
const glPoints = Number(params.get('points') ?? 1_000_000);
const tokens = tokensFor(theme);

interface Recorded {
  frames: number[];
  paints: number[];
  layers: number[];
}

let recording = false;
let recordingId = 0;
const stamps: number[] = [];
const paints: number[] = [];
const layers: number[] = [];
let firstRenderMs: number | null = null;
const mountStart = performance.now();

setChartPerfHook((event, _chart, ms) => {
  if (firstRenderMs === null) firstRenderMs = performance.now() - mountStart;
  if (!recording) return;
  if (event === 'paint') paints.push(ms);
  else if (event === 'layers') layers.push(ms);
});

function frameLoop(id: number) {
  const onFrame = (time: number) => {
    if (!recording || id !== recordingId) return;
    stamps.push(time);
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
}

// Data: built once, the adapter timed on its own (the app adapts once per result).
const dataStart = performance.now();
const table = (() => {
  switch (scenario) {
    case 'histogram':
      return syntheticHistogramTable({ bins: 50, width: 0.5 });
    case 'heatmap':
      return syntheticHeatmapTable({ bins: 100, dense: true });
    case 'bar':
      return syntheticBarTable({ categories: 20 });
    case 'scatter-canvas':
      return syntheticScatterTable({ points: 10_000, series: 4 });
    case 'scatter-webgl':
      return syntheticScatterTable({ points: glPoints, series: 4 });
    default:
      return syntheticLineTable({ points: 4_000, series: 4, stepMs: 60_000, nulls: 0.001 });
  }
})();
const generateMs = performance.now() - dataStart;
const mark: ChartMark = scenario === 'bar' ? 'bar' : scenario.startsWith('scatter') ? 'scatter' : (scenario as ChartMark);
const adaptStart = performance.now();
const columns = mark === 'bar' ? null : chartColumnsFromArrow(table, mark);
const bars = mark === 'bar' ? barDataFromArrow(table) : null;
const adapterMs = performance.now() - adaptStart;

let manager: WebGLOverlayManager | null = null;
/** Set from inside App once mounted, so the runner can force redraws. */
const control: {
  setVersion: ((v: number) => void) | null;
  setColumns: ((c: typeof columns) => void) | null;
  setBars: ((b: typeof bars) => void) | null;
} = { setVersion: null, setColumns: null, setBars: null };
let version = 0;

function App() {
  const [v, setVersion] = useState(0);
  const [selection, setSelection] = useState<IntervalSelection | null>(null);
  const [columnsNow, setColumns] = useState(columns);
  const [barsNow, setBars] = useState(bars);
  useEffect(() => {
    control.setVersion = setVersion;
    control.setColumns = setColumns;
    control.setBars = setBars;
  }, []);
  // A fresh tokens object per version (a theme change) forces every mark to rebuild its model and layers: the "redraw" measured.
  const themed = useMemo(() => ({ ...tokens, version: v }), [v]);
  const common = { tokens: themed, label: scenario, xLabel: 'x', yLabel: 'y', height, selection, onBrush: setSelection, testId: 'chart' } as const;
  let chart: ReactNode;
  if (barsNow) {
    chart = <BarChart data={barsNow.rows} selected={new Set(v % 2 === 1 ? [barsNow.rows[1]?.key ?? ''] : [])} tokens={themed} valueLabel="count(*)" label="bars" testId="chart" />;
  } else if (columnsNow && mark === 'line') {
    chart = <LineChart table={table} data={columnsNow} {...common} />;
  } else if (columnsNow && mark === 'histogram') {
    chart = <Histogram table={table} data={columnsNow} {...common} />;
  } else if (columnsNow && mark === 'heatmap') {
    chart = <Heatmap table={table} data={columnsNow} {...common} />;
  } else if (columnsNow) {
    chart = <ScatterChart table={table} data={columnsNow} {...common} radius={scenario === 'scatter-webgl' ? 1.5 : 2.5} />;
  }
  return (
    <WebGLOverlayProvider onManager={(m) => (manager = m)} className="bench-panel">
      <div className="bench-card" style={{ width: width + 24 }}>
        {chart}
      </div>
    </WebGLOverlayProvider>
  );
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

const bench = {
  scenario,
  rows: table.numRows,
  generateMs,
  adapterMs,
  get firstRenderMs() {
    return firstRenderMs;
  },
  /** Plot area in client px (where to drag). */
  plotRect(): { left: number; top: number; width: number; height: number } {
    const element = document.querySelector('[data-testid="chart-canvas"]') ?? document.querySelector('.gg-bar-chart canvas');
    if (!element) throw new Error('chart not mounted');
    const r = element.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  },
  /**
   * Full redraw, synchronously, in ms: React render, model (layout, hit
   * index), background and marks layers, composite. `fresh` also adapts the
   * Arrow result again, as a new query result would (no cached preparation).
   */
  rerender(fresh = false): number {
    version += 1;
    const start = performance.now();
    flushSync(() => {
      if (fresh && mark === 'bar') control.setBars?.(barDataFromArrow(table));
      else if (fresh) control.setColumns?.(chartColumnsFromArrow(table, mark));
      control.setVersion?.(version);
    });
    return performance.now() - start;
  },
  startRecording() {
    stamps.length = 0;
    paints.length = 0;
    layers.length = 0;
    recording = true;
    recordingId += 1;
    frameLoop(recordingId);
  },
  stopRecording(): Recorded {
    recording = false;
    const frames: number[] = [];
    for (let i = 1; i < stamps.length; i += 1) frames.push((stamps[i] ?? 0) - (stamps[i - 1] ?? 0));
    return { frames, paints: [...paints], layers: [...layers] };
  },
  webgl(): { available: boolean; renderer: string; strategy: string; lastFrameMs: number; drawn: number } {
    return {
      available: manager?.available ?? false,
      renderer: manager?.renderer ?? 'none',
      strategy: manager?.scatterStrategy ?? 'none',
      lastFrameMs: manager?.lastFrame.ms ?? Number.NaN,
      drawn: manager?.lastFrame.drawn ?? 0,
    };
  },
  /**
   * Renders the overlay `n` times back to back, each finished on the GPU
   * (a 1-pixel readPixels waits for it): GPU-inclusive frame times in ms.
   */
  glFrames(n: number, strategy?: 'instanced' | 'points'): number[] {
    const gl = manager?.context;
    if (!manager || !gl) return [];
    const previous = manager.scatterStrategyOption;
    if (strategy) {
      manager.scatterStrategyOption = strategy;
      // Warm-up: compile the program and upload the buffers for this strategy.
      manager.render();
    }
    const pixel = new Uint8Array(4);
    const out: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const start = performance.now();
      manager.render();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      out.push(performance.now() - start);
    }
    manager.scatterStrategyOption = previous;
    return out;
  },
  async settle(frames = 10): Promise<void> {
    for (let i = 0; i < frames; i += 1) await nextFrame();
  },
};

declare global {
  interface Window {
    __chartBench: typeof bench;
  }
}
window.__chartBench = bench;

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');
document.documentElement.dataset['ggTheme'] = theme;
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
