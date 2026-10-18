import { Bool, Float64, Int64, Table, TimestampMicrosecond, Utf8, vectorFromArray } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import { BAR_ROW_HEIGHT, barDataFromArrow, drawBars, layoutBars } from '../components/BarChart.js';
import { resolvedTokens } from '../tokens.js';
import { chartColumnsFromArrow } from './arrow.js';
import { chartFonts } from './canvas.js';
import { HEATMAP_STEPS, buildHeatmapModel } from './marks/heatmap.js';
import { buildHistogramModel } from './marks/histogram.js';
import { buildLineModel } from './marks/line.js';
import { CANVAS_CIRCLE_LIMIT, buildScatterModel } from './marks/scatter.js';
import type { DrawContext } from './model.js';
import { recordingContext } from './test-utils.js';

const tokens = resolvedTokens.light;
const fonts = chartFonts(tokens);
const dc: DrawContext = { tokens, fonts, dpr: 2 };
const [blue, orange] = tokens.chart.categorical;

const f64 = (values: (number | null)[]) => vectorFromArray(values, new Float64());

describe('line / area', () => {
  // Two series; A has a NULL measure at x=2 (a gap).
  const table = new Table({
    x: f64([0, 1, 2, 3, 4, 0, 1, 2, 3, 4]),
    y: f64([1, 2, null, 4, 5, 9, 8, 7, 6, 5]),
    color: vectorFromArray(['a', 'a', 'a', 'a', 'a', 'b', 'b', 'b', 'b', 'b'], new Utf8()),
    color_other: vectorFromArray(Array.from({ length: 10 }, () => false), new Bool()),
  });
  const data = chartColumnsFromArrow(table, 'line');
  const colors = [blue ?? '', orange ?? ''];

  it('draws one polyline per series in its colour, breaking at NULL', () => {
    const model = buildLineModel(data, 400, 160, fonts, { mark: 'line', yLabel: 'sum(v)', colors });
    const ctx = recordingContext();
    model.drawMarks(ctx, dc);
    const strokes = ctx.named('stroke');
    expect(strokes).toHaveLength(2);
    // Series order: b (total 35) before a (total 12).
    const strokeIndexes = ctx.calls.flatMap((c, i) => (c[0] === 'stroke' ? [i] : []));
    expect(ctx.styleAt('strokeStyle', strokeIndexes[0] ?? 0)).toBe(blue);
    expect(ctx.styleAt('strokeStyle', strokeIndexes[1] ?? 0)).toBe(orange);
    expect(ctx.styleAt('lineWidth', strokeIndexes[0] ?? 0)).toBe(tokens.chart.lineW);
    const between = (from: number, to: number, name: string) => ctx.calls.slice(from, to).filter((c) => c[0] === name).length;
    const firstStart = ctx.calls.findIndex((c) => c[0] === 'moveTo');
    expect(between(firstStart, strokeIndexes[0] ?? 0, 'moveTo')).toBe(1);
    expect(between(firstStart, strokeIndexes[0] ?? 0, 'lineTo')).toBe(4);
    // Series a: two segments (0–1 and 3–4).
    expect(between(strokeIndexes[0] ?? 0, strokeIndexes[1] ?? 0, 'moveTo')).toBe(2);
    expect(between(strokeIndexes[0] ?? 0, strokeIndexes[1] ?? 0, 'lineTo')).toBe(2);
  });

  it('keeps fractional pixel positions (no rounding)', () => {
    const model = buildLineModel(data, 333, 160, fonts, { mark: 'line', yLabel: 'v', colors });
    const ctx = recordingContext();
    model.drawMarks(ctx, dc);
    const first = ctx.named('moveTo')[0];
    expect(first?.[1]).toBe(model.axes.x.toPx(0));
    expect(first?.[2]).toBe(model.axes.y.toPx(9));
    const lineTo = ctx.named('lineTo')[0];
    expect(lineTo?.[1]).toBe(model.axes.x.toPx(1));
  });

  it('draws M4 output as is: every row is a vertex', () => {
    // Four rows in one pixel column: first, min, max, last.
    const m4 = chartColumnsFromArrow(new Table({ x: f64([0, 0.1, 0.2, 0.3, 100]), y: f64([5, 1, 9, 4, 6]) }), 'line');
    const model = buildLineModel(m4, 300, 160, fonts, { mark: 'line', yLabel: 'v', colors });
    const ctx = recordingContext();
    model.drawMarks(ctx, dc);
    expect(ctx.named('moveTo')).toHaveLength(1);
    expect(ctx.named('lineTo').map((c) => c[2])).toEqual([1, 9, 4, 6].map((v) => model.axes.y.toPx(v)));
  });

  it('fills areas down to zero under the stroke', () => {
    const model = buildLineModel(data, 400, 160, fonts, { mark: 'area', yLabel: 'v', colors });
    const ctx = recordingContext();
    model.drawMarks(ctx, dc);
    expect(ctx.named('fill').length).toBe(2);
    expect(ctx.named('stroke').length).toBe(2);
    const firstFill = ctx.calls.findIndex((c) => c[0] === 'fill');
    expect(ctx.styleAt('globalAlpha', firstFill)).toBeLessThan(1);
  });

  it('hit-tests with a binary search: exact values per series, – for NULL', () => {
    const model = buildLineModel(data, 400, 160, fonts, { mark: 'line', yLabel: 'sum(v)', colors });
    const at = (value: number) => model.hitTest(model.axes.x.toPx(value) + 3, 60);
    expect(at(3)?.rows).toEqual([
      { label: 'b', value: '6' },
      { label: 'a', value: '4' },
    ]);
    expect(at(2)?.rows).toEqual([
      { label: 'b', value: '7' },
      { label: 'a', value: '–' },
    ]);
    expect(at(3)?.title).toBe('3 · sum(v)');
    expect(model.hitTest(5, 400)).toBeNull();
  });

  it('titles time buckets at their resolution', () => {
    const days = chartColumnsFromArrow(
      new Table({ x: vectorFromArray([Date.UTC(2023, 0, 19), Date.UTC(2023, 0, 20)], new TimestampMicrosecond()), y: f64([22_481, 26_778]) }),
      'line',
    );
    const model = buildLineModel(days, 400, 160, fonts, { mark: 'line', yLabel: 'count(*)', colors });
    const hit = model.hitTest(model.axes.x.toPx(Date.UTC(2023, 0, 20)), 50);
    expect(hit?.title).toBe('Fri, Jan 20, 2023');
    expect(hit?.rows).toEqual([{ label: 'count(*)', value: '26,778' }]);
  });
});

describe('histogram', () => {
  const table = new Table({
    x: f64([0, 1, 1, 3]),
    x_end: f64([1, 2, 2, 4]),
    y: f64([10, 20, 5, 7]),
    color: vectorFromArray(['p', 'p', 'q', 'p'], new Utf8()),
    color_other: vectorFromArray([false, false, false, false], new Bool()),
  });
  const data = chartColumnsFromArrow(table, 'histogram');

  it('draws each series once, one rect per bin segment, stacked', () => {
    const model = buildHistogramModel(data, 400, 160, fonts, { yLabel: 'count(*)', colors: [blue ?? '', orange ?? ''] });
    const ctx = recordingContext();
    model.drawMarks(ctx, dc);
    expect(ctx.named('fill')).toHaveLength(2);
    const rects = ctx.named('rect');
    expect(rects).toHaveLength(4);
    // q's segment in bin [1,2) sits on top of p's 20.
    const q = rects[3];
    expect(q?.[2]).toBeCloseTo(model.axes.y.toPx(25), 9);
    expect(Number(q?.[2]) + Number(q?.[4])).toBeCloseTo(model.axes.y.toPx(20), 9);
  });

  it('hit-tests bins with exact values and a total, nothing over empty bins', () => {
    const model = buildHistogramModel(data, 400, 160, fonts, { yLabel: 'count(*)', colors: [blue ?? '', orange ?? ''] });
    const hit = model.hitTest(model.axes.x.toPx(1.5), 100);
    expect(hit?.title).toBe('1 – 2');
    expect(hit?.rows).toEqual([
      { label: 'p', value: '20' },
      { label: 'q', value: '5' },
      { label: 'total count(*)', value: '25' },
    ]);
    expect(model.hitTest(model.axes.x.toPx(2.5), 100)).toBeNull();
    expect(model.snapX?.ceil(1.2)).toBe(2);
  });
});

describe('heatmap', () => {
  const table = new Table({
    x: f64([0, 1, 0, 1]),
    x_end: f64([1, 2, 1, 2]),
    y: f64([0, 0, 10, 10]),
    y_end: f64([10, 10, 20, 20]),
    count: vectorFromArray([1n, 100n, 50n, 100n], new Int64()),
  });
  const data = chartColumnsFromArrow(table, 'heatmap');

  it('fills cells in colour batches on the sequential ramp', () => {
    const model = buildHeatmapModel(data, 300, 200, fonts, { xLabel: 'a', yLabel: 'b', ramp: tokens.chart.sequential });
    const ctx = recordingContext();
    model.drawMarks(ctx, dc);
    expect(ctx.named('rect')).toHaveLength(4);
    const fills = ctx.calls.flatMap((c, i) => (c[0] === 'fill' ? [i] : []));
    expect(fills.length).toBe(3); // counts 1, 50, 100 → three ramp steps
    expect(fills.length).toBeLessThanOrEqual(HEATMAP_STEPS);
    // The largest count takes the ramp's last stop.
    expect(ctx.styleAt('fillStyle', fills[fills.length - 1] ?? 0)).toBe(tokens.chart.sequential[tokens.chart.sequential.length - 1]);
  });

  it('hit-tests cells by bin', () => {
    const model = buildHeatmapModel(data, 300, 200, fonts, { xLabel: 'a', yLabel: 'b', ramp: tokens.chart.sequential });
    const hit = model.hitTest(model.axes.x.toPx(0.5), model.axes.y.toPx(15));
    expect(hit?.title).toBe('a 0 – 1');
    expect(hit?.rows).toEqual([
      { label: 'b', value: '10 – 20' },
      { label: 'count(*)', value: '50' },
    ]);
    expect(model.brushDims).toBe('xy');
  });
});

describe('scatter (Canvas 2D)', () => {
  it('draws circles in one path per series up to the limit, squares above it', () => {
    const small = chartColumnsFromArrow(new Table({ x: f64([1, 2, 3]), y: f64([3, 2, 1]) }), 'scatter');
    const model = buildScatterModel(small, 300, 200, fonts, { xLabel: 'x', yLabel: 'y', colors: [blue ?? ''] });
    const ctx = recordingContext();
    model.drawMarks(ctx, dc);
    expect(ctx.named('arc')).toHaveLength(3);
    expect(ctx.named('fill')).toHaveLength(1);
    const n = CANVAS_CIRCLE_LIMIT + 1;
    const big = chartColumnsFromArrow(new Table({ x: f64(Array.from({ length: n }, (_, i) => i)), y: f64(Array.from({ length: n }, (_, i) => i % 7)) }), 'scatter');
    const bigModel = buildScatterModel(big, 300, 200, fonts, { xLabel: 'x', yLabel: 'y', colors: [blue ?? ''] });
    const bigCtx = recordingContext();
    bigModel.drawMarks(bigCtx, dc);
    expect(bigCtx.named('arc')).toHaveLength(0);
    expect(bigCtx.named('fillRect')).toHaveLength(n);
  });

  it('hit-tests the nearest point with exact coordinates', () => {
    const data = chartColumnsFromArrow(new Table({ x: f64([1.25, 2, 3]), y: f64([3.5, 2, 1]) }), 'scatter');
    const model = buildScatterModel(data, 300, 200, fonts, { xLabel: 'trip_distance', yLabel: 'fare', colors: [blue ?? ''] });
    const hit = model.hitTest(model.axes.x.toPx(1.25) + 2, model.axes.y.toPx(3.5) - 1);
    expect(hit?.rows).toEqual([
      { label: 'trip_distance', value: '1.25' },
      { label: 'fare', value: '3.5' },
    ]);
  });
});

describe('bar', () => {
  it('draws labels, bars, the selection outline and exact values', () => {
    const rows = [
      { key: '"Credit card"', label: 'Credit card', value: 2_688_301 },
      { key: '"Cash"', label: 'Cash', value: 631_488 },
    ];
    const layout = layoutBars(rows, 400, 60);
    const ctx = recordingContext();
    drawBars(ctx, layout, rows, { selected: new Set(['"Cash"']), tokens, fonts, formatValue: (v) => v.toLocaleString('en-US') });
    expect(ctx.named('fillText').map((c) => c[1])).toEqual(['Credit card', '2,688,301', 'Cash', '631,488']);
    const outline = ctx.named('strokeRect');
    expect(outline).toHaveLength(1);
    expect(Number(outline[0]?.[2])).toBeGreaterThan(BAR_ROW_HEIGHT);
    // The unselected bar is faded.
    const fills = ctx.calls.flatMap((c, i) => (c[0] === 'fill' ? [i] : []));
    expect(ctx.styleAt('globalAlpha', fills[0] ?? 0)).toBe(tokens.chart.unselectedOpacity);
    expect(ctx.styleAt('globalAlpha', fills[1] ?? 0)).toBe(1);
  });

  it('splits bars by colour series from the Arrow result', () => {
    const table = new Table({
      x: vectorFromArray(['b', 'a', 'b', 'a'], new Utf8()),
      y: f64([1, 5, 4, 2]),
      color: vectorFromArray(['card', 'card', 'cash', null], new Utf8()),
      color_other: vectorFromArray([false, false, false, true], new Bool()),
    });
    const { rows, series } = barDataFromArrow(table);
    expect(series.map((s) => s.label)).toEqual(['card', 'cash', 'Other']);
    expect(rows.map((r) => [r.label, r.value, r.filterValue])).toEqual([
      ['a', 7, 'a'],
      ['b', 5, 'b'],
    ]);
    expect(rows[0]?.segments).toEqual([
      { series: 0, value: 5 },
      { series: 2, value: 2 },
    ]);
    const layout = layoutBars(rows, 400, 40);
    const ctx = recordingContext();
    drawBars(ctx, layout, rows, { selected: new Set(), tokens, fonts, formatValue: String, colors: [blue ?? '', orange ?? '', tokens.chart.other] });
    const fills = ctx.calls.flatMap((c, i) => (c[0] === 'fill' ? [i] : []));
    expect(fills.map((i) => ctx.styleAt('fillStyle', i))).toEqual([blue, tokens.chart.other, blue, orange]);
  });
});
