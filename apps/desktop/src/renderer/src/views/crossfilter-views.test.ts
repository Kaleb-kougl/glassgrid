import { describe, expect, it, vi } from 'vitest';
import type { Selection } from '@glassgrid/core';
import { OTHER_BAR_KEY, type BarDatum } from '@glassgrid/ui';
import { chartPixelWidth, viewKeys } from '../App';
import { CROSSFILTER_MEASURE, type CrossfilterMeasureDetail } from '../perf';
import { chartRequestKey } from './chart-data';
import { CrossfilterTracker } from './crossfilter-tracker';
import { buildFilter, operatorsFor, valueFields } from './filter-editor-model';
import { brushInputOf, intervalOf, intervalSummary, selectedBarKeys, toggleBar } from './selection';

const bars: BarDatum[] = [
  { key: '"Cash"', label: 'Cash', value: 10, filterValue: 'Cash' },
  { key: '"Card"', label: 'Card', value: 8, filterValue: 'Card' },
  { key: 'null', label: 'null', isNull: true, value: 2, filterValue: null },
  { key: OTHER_BAR_KEY, label: 'Other', isOther: true, value: 30, filterValue: null },
];

describe('selections between the store and the charts', () => {
  it('draws a chart’s own range clauses as an interval (x, and y for 2-D brushes)', () => {
    const brushed: Selection = {
      source: 'brush',
      clauses: [
        { channel: 'x', filter: { kind: 'range', column: 'd', min: 2, max: 6, minInclusive: true, maxInclusive: false } },
        { channel: 'y', filter: { kind: 'range', column: 'f', min: '2024-03-01', max: '2024-03-02', minInclusive: true, maxInclusive: false } },
      ],
    };
    expect(intervalOf(brushed)).toEqual({ x: [2, 6], y: ['2024-03-01', '2024-03-02'] });
    expect(intervalOf(undefined)).toBeNull();
    // An open-ended range (e.g. set by an agent) has no extent to draw.
    expect(intervalOf({ source: 'filter', clauses: [{ channel: 'x', filter: { kind: 'range', column: 'd', min: 2, minInclusive: true, maxInclusive: true } }] })).toBeNull();
    expect(brushInputOf({ x: [1, 2], y: [3, 4] })).toEqual({ type: 'interval', x: { min: 1, max: 2 }, y: { min: 3, max: 4 } });
    expect(brushInputOf({ x: ['2024-03-01', '2024-03-02 12:00:00'] })).toEqual({ type: 'interval', x: { min: '2024-03-01', max: '2024-03-02 12:00:00' } });
  });

  it('toggles bars, the "Other" bar as notIn of the other named bars', () => {
    const none = new Set<string>();
    expect(toggleBar(none, bars, bars[0] as BarDatum)).toEqual({ type: 'points', values: ['Cash'] });
    expect(toggleBar(new Set(['"Cash"']), bars, bars[0] as BarDatum)).toBeNull();
    expect(toggleBar(new Set(['"Cash"']), bars, bars[2] as BarDatum)).toEqual({ type: 'points', values: ['Cash', null] });
    expect(toggleBar(new Set(['"Cash"']), bars, bars[3] as BarDatum)).toEqual({ type: 'points', values: ['Cash'], other: { shown: ['Cash', 'Card', null] } });

    const clicked: Selection = { source: 'click', clauses: [{ channel: 'x', filter: { kind: 'in', column: 'p', values: ['Cash', null] } }] };
    expect([...selectedBarKeys(clicked, 'p', bars)]).toEqual(['"Cash"', 'null']);
    // Other plus Cash: notIn of the named bars not clicked.
    const withOther: Selection = { source: 'click', clauses: [{ channel: 'x', filter: { kind: 'notIn', column: 'p', values: ['Card', null] } }] };
    expect([...selectedBarKeys(withOther, 'p', bars)].sort()).toEqual(['"Cash"', OTHER_BAR_KEY].sort());
    expect(selectedBarKeys(undefined, 'p', bars).size).toBe(0);
  });

  it('words a brush being dragged by column type', () => {
    expect(intervalSummary({ x: [2, 6] }, 'float', null)).toBe('2.00 – 6.00');
    expect(intervalSummary({ x: ['2024-03-03 00:00:00', '2024-03-06 12:30:00'] }, 'timestamp', null)).toBe('2024-03-03 – 2024-03-06 12:30');
    expect(intervalSummary({ x: [1, 3], y: [10, 20] }, 'integer', 'integer')).toBe('1 – 3 × 10 – 20');
  });
});

describe('the "+ Filter" editor', () => {
  it('offers operators by column type', () => {
    expect(operatorsFor('float')[0]).toBe('between');
    expect(operatorsFor('timestamp')).toContain('atLeast');
    expect(operatorsFor('text')).toEqual(['oneOf', 'noneOf', 'isNull', 'notNull']);
    expect(valueFields('between')).toBe(2);
    expect(valueFields('oneOf')).toBe('list');
    expect(valueFields('notNull')).toBe(0);
  });

  it('builds filters and names the field that is wrong', () => {
    const empty = { min: '', max: '', value: '' };
    expect(buildFilter('d', 'float', 'between', { ...empty, min: '2', max: '6.5' })).toEqual({ ok: true, filter: { kind: 'range', column: 'd', min: 2, max: 6.5 } });
    expect(buildFilter('d', 'float', 'between', { ...empty, min: '6', max: '2' })).toEqual({ ok: false, field: 'max', message: 'The upper bound is below the lower bound' });
    expect(buildFilter('d', 'float', 'between', { ...empty, min: 'two', max: '2' })).toMatchObject({ ok: false, field: 'min' });
    expect(buildFilter('n', 'integer', 'atLeast', { ...empty, value: '2.5' })).toEqual({ ok: false, field: 'value', message: 'Use a whole number' });
    expect(buildFilter('n', 'integer', 'equals', { ...empty, value: '3' })).toEqual({ ok: true, filter: { kind: 'in', column: 'n', values: [3] } });
    expect(buildFilter('t', 'timestamp', 'atMost', { ...empty, value: '2024-03-01T08:00' })).toEqual({ ok: true, filter: { kind: 'range', column: 't', max: '2024-03-01 08:00' } });
    expect(buildFilter('t', 'date', 'atLeast', { ...empty, value: 'March 1' })).toMatchObject({ ok: false, field: 'value', message: 'Use a date like 2024-03-01' });
    expect(buildFilter('p', 'text', 'oneOf', { ...empty, value: 'Cash, Card, Cash' })).toEqual({ ok: true, filter: { kind: 'in', column: 'p', values: ['Cash', 'Card'] } });
    expect(buildFilter('p', 'text', 'noneOf', { ...empty, value: ' , ' })).toEqual({ ok: false, field: 'value', message: 'Enter at least one value' });
    expect(buildFilter('b', 'boolean', 'oneOf', { ...empty, value: 'TRUE' })).toEqual({ ok: true, filter: { kind: 'in', column: 'b', values: [true] } });
    expect(buildFilter('p', 'text', 'isNull', empty)).toEqual({ ok: true, filter: { kind: 'isNull', column: 'p' } });
  });
});

describe('cross-filter timing', () => {
  it('measures brush end to the last changed view painted with its new key', () => {
    let now = 0;
    const tracker = new CrossfilterTracker(() => now);
    const before = new Map([
      ['chart:a', 'a1'],
      ['chart:b', 'b1'],
      ['grid:count', 'g1'],
      ['grid:rows', 'g1'],
    ]);
    const measured = vi.spyOn(performance, 'measure');
    tracker.begin('a', before);
    tracker.arm(new Map([...before, ['chart:b', 'b2'], ['grid:count', 'g2'], ['grid:rows', 'g2']]), [{ kind: 'in', column: 'p', values: ['Cash'] }]);
    const info = { engineMs: 1, fromCube: true, cached: false };
    now = 10;
    tracker.painted('chart:b', 'b1', info); // stale result: ignored
    tracker.painted('chart:a', 'a1', info); // unchanged view: not waited for
    tracker.painted('chart:b', 'b2', info);
    now = 30;
    tracker.painted('grid:count', 'g2', info, 42);
    expect(measured).not.toHaveBeenCalledWith(CROSSFILTER_MEASURE, expect.anything());
    now = 55;
    tracker.painted('grid:rows', 'g2', { ...info, fromCube: false });
    expect(measured).toHaveBeenCalledWith(CROSSFILTER_MEASURE, expect.objectContaining({ start: expect.stringContaining(CROSSFILTER_MEASURE) as unknown }));
    const detail = (measured.mock.lastCall?.[1] as { detail: CrossfilterMeasureDetail }).detail;
    expect(detail).toMatchObject({ source: 'a', rowCount: 42, filters: [{ kind: 'in', column: 'p', values: ['Cash'] }] });
    expect(detail.views.map((view) => [view.view, view.ms])).toEqual([
      ['chart:b', 10],
      ['grid:count', 30],
      ['grid:rows', 55],
    ]);
    expect(tracker.active).toBe(false);
    measured.mockRestore();
  });

  it('drops an update that changed nothing (the snapped brush equals the last one)', () => {
    const tracker = new CrossfilterTracker(() => 0);
    const keys = new Map([['chart:b', 'b1']]);
    tracker.begin('a', keys);
    tracker.arm(keys, []);
    expect(tracker.active).toBe(false);
  });

  it('keys every view and sizes line aggregates to the plot in device pixels', () => {
    const keys = viewKeys({
      grid: { viewId: 'grid', engineViewId: 'grid', filters: [], crossfilter: null, key: 'g' },
      charts: [{ viewId: 'c1', chartId: 'c1', engineViewId: 'chart:c1', filters: [], crossfilter: null, key: 'k1', spec: { mark: 'bar', x: { column: 'p' }, filters: [] } }],
    });
    expect([...keys]).toEqual([
      ['grid:count', 'g'],
      ['grid:rows', 'g'],
      ['chart:c1', 'k1'],
    ]);
    expect(chartPixelWidth(380, 1)).toBe(300);
    expect(chartPixelWidth(380, 2)).toBe(600);
    expect(chartPixelWidth(0, 1)).toBe(100);
    // Only lines and areas re-query when the width changes.
    const bar = { key: 'k', spec: { mark: 'bar' as const, x: { column: 'p' }, filters: [] } };
    const line = { key: 'k', spec: { mark: 'line' as const, x: { column: 't' }, filters: [] } };
    expect(chartRequestKey(null, bar, 300, 0)).toBe(chartRequestKey(null, bar, 600, 0));
    expect(chartRequestKey(null, line, 300, 0)).not.toBe(chartRequestKey(null, line, 600, 0));
  });
});
