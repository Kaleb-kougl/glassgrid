import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Float64, Table, TimestampMicrosecond, vectorFromArray } from 'apache-arrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvedTokens } from '../tokens.js';
import { Histogram } from './Histogram.js';
import { LineChart } from './LineChart.js';
import { ScatterChart } from './ScatterChart.js';
import { installCanvasRecorder, mockClientSize } from './test-utils.js';
import type { IntervalSelection } from './types.js';
import { ViewData } from './ViewData.js';
import { chartColumnsFromArrow } from './arrow.js';

const tokens = resolvedTokens.dark;
const f64 = (values: (number | null)[]) => vectorFromArray(values, new Float64());
const lineTable = new Table({ x: f64([0, 1, 2, 3, 4]), y: f64([10, 20, null, 40, 50]) });
const histogramTable = new Table({ x: f64([0, 1, 2, 3]), x_end: f64([1, 2, 3, 4]), y: f64([5, 9, 4, 2]) });

let recorder: ReturnType<typeof installCanvasRecorder>;

beforeEach(() => {
  recorder = installCanvasRecorder();
  mockClientSize('.gg-chart__plot', 400, 160);
});

function canvases(testId: string) {
  return { base: screen.getByTestId(`${testId}-plot`).querySelector('.gg-chart__base'), top: screen.getByTestId(`${testId}-canvas`) };
}

function drag(target: Element, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(target, { clientX: from[0], clientY: from[1], button: 0, pointerId: 1 });
  fireEvent.pointerMove(target, { clientX: (from[0] + to[0]) / 2, clientY: to[1], pointerId: 1 });
  recorder.flushFrames();
  fireEvent.pointerMove(target, { clientX: to[0], clientY: to[1], pointerId: 1 });
  fireEvent.pointerUp(target, { clientX: to[0], clientY: to[1], pointerId: 1 });
}

describe('ChartFrame through LineChart', () => {
  it('is an image with an accessible summary and a hidden data table', () => {
    render(<LineChart table={lineTable} tokens={tokens} label="Fare over time" xLabel="x" yLabel="avg(fare)" testId="line" />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-label')).toBe('Fare over time. Line chart of avg(fare) by x, 5 rows. No selection.');
    expect(img.tabIndex).toBe(0);
    const table = screen.getByRole('table', { name: 'Fare over time data', hidden: true });
    expect(within(table).getAllByRole('row', { hidden: true })).toHaveLength(6);
    // No onBrush: no brush instructions.
    expect(img.getAttribute('aria-describedby')).toBeNull();
  });

  it('paints the chart before it renders the hidden data table (new chart, then new data)', () => {
    const rowsAtDraw: number[] = [];
    const onDrawn = () => rowsAtDraw.push(document.querySelectorAll('.gg-visually-hidden table tr').length);
    const { rerender } = render(<LineChart table={lineTable} tokens={tokens} label="L" xLabel="x" yLabel="y" onDrawn={onDrawn} testId="line" />);
    expect(rowsAtDraw).toEqual([0]);
    expect(within(screen.getByRole('table', { name: 'L data', hidden: true })).getAllByRole('row', { hidden: true })).toHaveLength(6);
    // New data: drawn while the table still lists the previous rows, then the table follows.
    rerender(<LineChart table={new Table({ x: f64([0, 1]), y: f64([1, 2]) })} tokens={tokens} label="L" xLabel="x" yLabel="y" onDrawn={onDrawn} testId="line" />);
    expect(rowsAtDraw).toEqual([0, 6]);
    expect(within(screen.getByRole('table', { name: 'L data', hidden: true })).getAllByRole('row', { hidden: true })).toHaveLength(3);
  });

  it('reports onDrawn once the layers are painted for new data, not for brush frames', () => {
    const onDrawn = vi.fn();
    const { rerender } = render(<LineChart table={lineTable} tokens={tokens} label="L" xLabel="x" yLabel="y" onBrush={() => undefined} onDrawn={onDrawn} testId="line" />);
    expect(onDrawn).toHaveBeenCalledTimes(1);
    rerender(<LineChart table={lineTable} tokens={tokens} label="L" xLabel="x" yLabel="y" selection={{ x: [1, 2] }} onBrush={() => undefined} onDrawn={onDrawn} testId="line" />);
    recorder.flushFrames();
    expect(onDrawn).toHaveBeenCalledTimes(1);
    const next = new Table({ x: f64([0, 1]), y: f64([1, 2]) });
    rerender(<LineChart table={next} tokens={tokens} label="L" xLabel="x" yLabel="y" onBrush={() => undefined} onDrawn={onDrawn} testId="line" />);
    expect(onDrawn).toHaveBeenCalledTimes(2);
  });

  it('composites marks dimmed outside the selection, with an outline and handles', () => {
    render(<LineChart table={lineTable} tokens={tokens} label="L" xLabel="x" yLabel="y" selection={{ x: [1, 3] }} onBrush={() => undefined} testId="line" />);
    recorder.flushFrames();
    const { base, top } = canvases('line');
    const ctx = recorder.contextOf(base);
    const images = ctx.calls.flatMap((c, i) => (c[0] === 'drawImage' ? [i] : []));
    expect(images.length).toBeGreaterThanOrEqual(3);
    const last3 = images.slice(-3);
    expect(ctx.styleAt('globalAlpha', last3[1] ?? 0)).toBe(tokens.chart.unselectedOpacity);
    expect(ctx.styleAt('globalAlpha', last3[2] ?? 0)).toBe(1);
    expect(ctx.calls.slice(last3[1], last3[2]).some((c) => c[0] === 'clip')).toBe(true);
    const overlay = recorder.contextOf(top);
    // The last frame: everything after the overlay's last clear.
    const frameStart = overlay.calls.map((c) => c[0]).lastIndexOf('clearRect');
    const fills = overlay.calls.flatMap((c, i) => (c[0] === 'fillRect' && i > frameStart ? [i] : []));
    expect(fills.map((i) => overlay.styleAt('fillStyle', i))).toEqual([tokens.chart.brushFill, tokens.chart.brushStroke, tokens.chart.brushStroke]);
    expect(overlay.calls.slice(frameStart).filter((c) => c[0] === 'strokeRect')).toHaveLength(1);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/Selected x 1 – 3\.$/);
  });

  it('brushes with the pointer: move fires per change and paints without waiting for props, end commits', () => {
    const onBrush = vi.fn();
    render(<LineChart table={lineTable} tokens={tokens} label="L" xLabel="x" yLabel="y" onBrush={onBrush} testId="line" />);
    recorder.flushFrames();
    const { top } = canvases('line');
    const overlay = recorder.contextOf(top);
    fireEvent.pointerDown(top, { clientX: 100, clientY: 50, button: 0, pointerId: 1 });
    fireEvent.pointerMove(top, { clientX: 200, clientY: 50, pointerId: 1 });
    overlay.reset();
    recorder.flushFrames();
    // The overlay shows the brush on the next frame, before any prop changes.
    expect(overlay.named('fillRect').length).toBeGreaterThan(0);
    expect(onBrush).toHaveBeenCalledTimes(1);
    const [selection, phase] = onBrush.mock.calls[0] as [IntervalSelection, string];
    expect(phase).toBe('move');
    expect(selection.x[0]).toBeLessThan(selection.x[1] as number);
    fireEvent.pointerMove(top, { clientX: 200, clientY: 50, pointerId: 1 }); // unchanged: no event
    expect(onBrush).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(top, { clientX: 250, clientY: 50, pointerId: 1 });
    expect(onBrush).toHaveBeenLastCalledWith(expect.objectContaining({ x: expect.any(Array) as unknown }), 'end');
    expect(screen.getByTestId('line-live').textContent).toMatch(/^Selected x /);
    // Double-click clears.
    fireEvent.doubleClick(top, { clientX: 220, clientY: 50 });
    expect(onBrush).toHaveBeenLastCalledWith(null, 'end');
  });

  it('emits ISO timestamps on a time axis', () => {
    const onBrush = vi.fn();
    const days = new Table({
      x: vectorFromArray([Date.UTC(2023, 0, 1), Date.UTC(2023, 0, 11), Date.UTC(2023, 0, 21)], new TimestampMicrosecond()),
      y: f64([1, 2, 3]),
    });
    render(<LineChart table={days} tokens={tokens} label="L" xLabel="day(t)" yLabel="count(*)" onBrush={onBrush} testId="days" />);
    drag(screen.getByTestId('days-canvas'), [100, 50], [300, 50]);
    const [selection] = onBrush.mock.lastCall as [IntervalSelection];
    expect(selection.x.every((v) => typeof v === 'string' && /^2023-01-\d\d/.test(v))).toBe(true);
  });

  it('shows exact values in a tooltip that flips at the container edge', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
      return this.closest('.gg-chart');
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('gg-tooltip') ? 120 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('gg-tooltip') ? 40 : 0;
    });
    mockClientSize('.gg-chart__plot, .gg-chart', 400, 160);
    render(<LineChart table={lineTable} tokens={tokens} label="L" xLabel="x" yLabel="avg(fare)" testId="line" />);
    const { top } = canvases('line');
    fireEvent.pointerMove(top, { clientX: 390, clientY: 40 });
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toBe('4avg(fare)50');
    expect(tooltip.getAttribute('data-flipped-x')).toBe('true');
    fireEvent.pointerMove(top, { clientX: 30, clientY: 40 });
    expect(screen.getByRole('tooltip').getAttribute('data-flipped-x')).toBe('false');
    fireEvent.pointerLeave(top);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('follows the selection prop once committed, replacing its draft', () => {
    const onBrush = vi.fn();
    const { rerender } = render(<LineChart table={lineTable} tokens={tokens} label="L" xLabel="x" yLabel="y" onBrush={onBrush} selection={null} testId="line" />);
    drag(screen.getByTestId('line-canvas'), [100, 50], [200, 50]);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/Selected x /);
    rerender(<LineChart table={lineTable} tokens={tokens} label="L" xLabel="x" yLabel="y" onBrush={onBrush} selection={{ x: [0, 1] }} testId="line" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/Selected x 0 – 1\.$/);
  });
});

describe('keyboard brushing', () => {
  it('creates, moves, resizes and clears a snapped histogram brush', () => {
    const onBrush = vi.fn();
    render(<Histogram table={histogramTable} tokens={tokens} label="H" xLabel="bin(d)" yLabel="count(*)" onBrush={onBrush} testId="hist" />);
    const img = screen.getByRole('img');
    expect(screen.getByText(/Left and Right move it/).id).toBe(img.getAttribute('aria-describedby'));
    act(() => img.focus());
    fireEvent.keyDown(img, { key: 'Enter' });
    expect(onBrush).toHaveBeenLastCalledWith({ x: [1, 3] }, 'end');
    fireEvent.keyDown(img, { key: 'ArrowRight' });
    expect(onBrush).toHaveBeenLastCalledWith({ x: [2, 4] }, 'end');
    fireEvent.keyDown(img, { key: 'ArrowLeft', shiftKey: true });
    expect(onBrush).toHaveBeenLastCalledWith({ x: [2, 3] }, 'end');
    expect(screen.getByTestId('hist-live').textContent).toBe('Selected bin(d) 2 – 3.');
    fireEvent.keyDown(img, { key: 'Escape' });
    expect(onBrush).toHaveBeenLastCalledWith(null, 'end');
    expect(screen.getByTestId('hist-live').textContent).toBe('Selection cleared.');
    // Escape with nothing to clear is left to the page.
    const event = fireEvent.keyDown(img, { key: 'Escape' });
    expect(event).toBe(true);
  });

  it('snaps pointer brushes to bin edges by default', () => {
    const onBrush = vi.fn();
    render(<Histogram table={histogramTable} tokens={tokens} label="H" xLabel="b" yLabel="c" onBrush={onBrush} testId="hist" />);
    drag(screen.getByTestId('hist-canvas'), [120, 60], [250, 60]);
    const [selection, phase] = onBrush.mock.lastCall as [IntervalSelection, string];
    expect(phase).toBe('end');
    expect(selection.x.every((v) => Number.isInteger(v))).toBe(true);
  });
});

describe('ScatterChart without a WebGL overlay', () => {
  it('draws its points with Canvas 2D and brushes a rectangle', () => {
    const onBrush = vi.fn();
    const table = new Table({ x: f64([1, 2, 3, 4]), y: f64([4, 3, 2, 1]) });
    render(<ScatterChart table={table} tokens={tokens} label="S" xLabel="a" yLabel="b" onBrush={onBrush} testId="scatter" />);
    const { top } = canvases('scatter');
    drag(top, [80, 30], [250, 120]);
    const [selection] = onBrush.mock.lastCall as [IntervalSelection];
    expect(selection.y).toBeDefined();
    expect(screen.getByText(/Drag to select a region/)).toBeTruthy();
  });
});

describe('ViewData', () => {
  it('lists aggregate rows through the shared formatter, capped with a note', () => {
    const days = new Table({
      x: vectorFromArray([Date.UTC(2023, 0, 2), Date.UTC(2023, 0, 1), Date.UTC(2023, 0, 3)], new TimestampMicrosecond()),
      y: f64([1234.5, null, 3]),
    });
    const data = chartColumnsFromArrow(days, 'line');
    render(<ViewData data={data} mark="line" label="Trips data" xLabel="day(t)" yLabel="sum(v)" maxRows={2} />);
    const table = screen.getByRole('table', { name: 'Trips data' });
    const rows = within(table).getAllByRole('row').map((row) => row.textContent);
    expect(rows).toEqual(['day(t)sum(v)', '2023-01-01 00:00:00–', '2023-01-02 00:00:001,234.50']);
    expect(table.querySelector('caption')?.textContent).toBe('First 2 of 3 rows');
  });

  it('shows bins and heatmap cells as ranges', () => {
    const data = chartColumnsFromArrow(histogramTable, 'histogram');
    render(<ViewData data={data} mark="histogram" label="H" xLabel="bin(d)" yLabel="count(*)" />);
    expect(screen.getAllByRole('row')[1]?.textContent).toBe('0 – 15');
  });
});
