import { describe, expect, it } from 'vitest';
import { axisExpression, defaultChartTitle, describeEntry, filterCondition, yExpression } from './describe';

describe('words for state', () => {
  it('keeps the aggregate in the Y expression', () => {
    expect(yExpression(undefined)).toBe('count(*)');
    expect(yExpression({ column: 'fare_amount', aggregate: 'sum' })).toBe('sum(fare_amount)');
    expect(defaultChartTitle({ x: { column: 'payment_type' } })).toBe('Rows by payment_type');
    expect(defaultChartTitle({ x: { column: 'category' }, y: { column: 'amount', aggregate: 'avg' } })).toBe('Average of amount by category');
    expect(defaultChartTitle({ mark: 'line', x: { column: 'pickup_at' } })).toBe('Rows over pickup_at');
    expect(defaultChartTitle({ mark: 'area', x: { column: 'pickup_at' }, y: { column: 'fare', aggregate: 'sum' } })).toBe('Sum of fare over pickup_at');
    expect(defaultChartTitle({ mark: 'histogram', x: { column: 'trip_distance' } })).toBe('Distribution of trip_distance');
    expect(defaultChartTitle({ mark: 'heatmap', x: { column: 'trip_distance' }, y: { column: 'fare' } })).toBe('Rows by trip_distance and fare');
    expect(defaultChartTitle({ mark: 'scatter', x: { column: 'trip_distance' }, y: { column: 'fare' } })).toBe('fare against trip_distance');
  });

  it('shows positional fields as drawn: automatic time units and bin widths resolved from the profile', () => {
    const columns = [
      { name: 'pickup_at', type: 'timestamp' as const, min: '2024-03-01 00:00:00', max: '2024-03-31 23:59:00', distinctCount: 1000 },
      { name: 'trip_distance', type: 'float' as const, min: 0, max: 20.7, distinctCount: 2000 },
    ];
    expect(axisExpression({ mark: 'line', x: { column: 'pickup_at' }, filters: [] }, 'x', columns)).toBe('hour(pickup_at)');
    expect(axisExpression({ mark: 'histogram', x: { column: 'trip_distance', bin: 'auto' }, filters: [] }, 'x', columns)).toBe('bin(trip_distance, 0.5)');
    expect(axisExpression({ mark: 'histogram', x: { column: 'trip_distance', bin: 2 }, filters: [] }, 'x', columns)).toBe('bin(trip_distance, 2)');
    // Without a profile the field reads as it is in the spec (not the compiler's width-1 fallback, which would flash before the real width).
    expect(axisExpression({ mark: 'histogram', x: { column: 'trip_distance', bin: 'auto' }, filters: [] }, 'x', [{ name: 'trip_distance', type: 'float' }])).toBe(
      'bin(trip_distance, auto)',
    );
    // A profiled column without values (min and max null) draws with the fallback width.
    expect(axisExpression({ mark: 'histogram', x: { column: 'trip_distance', bin: 'auto' }, filters: [] }, 'x', [{ name: 'trip_distance', type: 'float', min: null, max: null }])).toBe(
      'bin(trip_distance, 1)',
    );
  });

  it('states filter conditions in words', () => {
    expect(filterCondition({ kind: 'in', column: 'p', values: ['Cash'] })).toBe('= Cash');
    expect(filterCondition({ kind: 'in', column: 'p', values: ['a', null] })).toBe('in a, null');
    expect(filterCondition({ kind: 'in', column: 'p', values: [1, 2, 3, 4] })).toBe('in 4 values');
    expect(filterCondition({ kind: 'range', column: 'd', min: 2, max: 6, minInclusive: true, maxInclusive: false })).toBe('2 – 6');
    expect(filterCondition({ kind: 'isNull', column: 'd' })).toBe('is null');
    expect(filterCondition({ kind: 'notIn', column: 'p', values: ['Cash'] })).toBe('≠ Cash');
    expect(filterCondition({ kind: 'notIn', column: 'p', values: ['a', 'b'] })).toBe('not in a, b');
  });

  it('labels history entries', () => {
    expect(describeEntry({ name: 'setFilter', input: { viewId: 'c1', filter: { kind: 'in', column: 'payment_type', values: ['Cash'] } } })).toBe(
      'Selected payment_type = Cash',
    );
    expect(describeEntry({ name: 'resizeColumn', input: { column: 'amount', width: 180 } })).toBe('Resized amount to 180 px');
    expect(describeEntry({ name: 'reorderColumn', input: { column: 'amount', toIndex: 0 } })).toBe('Moved amount to position 1');
    expect(describeEntry({ name: 'sortGrid', input: { sort: [{ column: 'id', direction: 'desc' }] } })).toBe('Sorted by id ↓');
    expect(describeEntry({ name: 'addChart', input: { spec: { mark: 'bar', x: { column: 'category' } } } })).toBe('Added chart “Rows by category”');
    expect(describeEntry({ name: 'clearFilter', input: { viewId: 'c1' } }, { charts: [{ id: 'c1', spec: { mark: 'bar', x: { column: 'a' }, filters: [] } }] })).toBe(
      'Cleared the selection on “Rows by a”',
    );
    const charts = { charts: [{ id: 'c1', spec: { mark: 'histogram' as const, x: { column: 'trip_distance' }, filters: [] } }] };
    expect(describeEntry({ name: 'brush', input: { viewId: 'c1', selection: { type: 'interval', x: { min: 1, max: 2 } } } }, charts)).toBe(
      'Brushed “Distribution of trip_distance”',
    );
    expect(describeEntry({ name: 'brush', input: { viewId: 'grid', selection: { type: 'points', column: 'a', values: [1] } } })).toBe('Selected on the grid');
    expect(describeEntry({ name: 'brush', input: { viewId: 'c1', selection: null } }, charts)).toBe('Cleared the selection on “Distribution of trip_distance”');
    expect(describeEntry({ name: 'addFilter', input: { filter: { kind: 'notNull', column: 'fare' } } })).toBe('Filtered fare is not null');
    expect(describeEntry({ name: 'clearFilter', input: { filterId: 'filter_1' } })).toBe('Removed a filter');
    expect(describeEntry({ name: 'setMark', input: { chartId: 'c1', mark: 'line' } }, charts)).toBe('Changed “Distribution of trip_distance” to a line chart');
    expect(describeEntry({ name: 'addChart', input: { columns: ['trip_distance', 'fare'] } })).toBe('Added a chart of trip_distance and fare');
  });
});
