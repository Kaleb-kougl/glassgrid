import { describe, expect, it } from 'vitest';
import { displayValue, filterValue, formatTimestamp } from './arrow-values';
import { defaultChartTitle, describeEntry, filterCondition, yExpression } from './describe';

describe('words for state', () => {
  it('keeps the aggregate in the Y expression', () => {
    expect(yExpression(undefined)).toBe('count(*)');
    expect(yExpression({ column: 'fare_amount', aggregate: 'sum' })).toBe('sum(fare_amount)');
    expect(defaultChartTitle({ x: { column: 'payment_type' } })).toBe('Rows by payment_type');
    expect(defaultChartTitle({ x: { column: 'category' }, y: { column: 'amount', aggregate: 'avg' } })).toBe('Average of amount by category');
  });

  it('states filter conditions in words', () => {
    expect(filterCondition({ kind: 'in', column: 'p', values: ['Cash'] })).toBe('= Cash');
    expect(filterCondition({ kind: 'in', column: 'p', values: ['a', null] })).toBe('in a, null');
    expect(filterCondition({ kind: 'in', column: 'p', values: [1, 2, 3, 4] })).toBe('in 4 values');
    expect(filterCondition({ kind: 'range', column: 'd', min: 2, max: 6, minInclusive: true, maxInclusive: false })).toBe('2 – 6');
    expect(filterCondition({ kind: 'isNull', column: 'd' })).toBe('is null');
  });

  it('labels history entries', () => {
    expect(describeEntry({ name: 'setFilter', input: { viewId: 'c1', filter: { kind: 'in', column: 'payment_type', values: ['Cash'] } } })).toBe(
      'Selected payment_type = Cash',
    );
    expect(describeEntry({ name: 'sortGrid', input: { sort: [{ column: 'id', direction: 'desc' }] } })).toBe('Sorted by id ↓');
    expect(describeEntry({ name: 'addChart', input: { spec: { mark: 'bar', x: { column: 'category' } } } })).toBe('Added chart “Rows by category”');
    expect(describeEntry({ name: 'clearFilter', input: { viewId: 'c1' } }, { charts: [{ id: 'c1', spec: { mark: 'bar', x: { column: 'a' }, filters: [] } }] })).toBe(
      'Cleared the selection on “Rows by a”',
    );
  });
});

describe('Arrow values', () => {
  it('formats dates, timestamps and big integers for the grid', () => {
    expect(displayValue(1_728_000_000_000, 'date')).toBe('2024-10-04');
    expect(formatTimestamp(1_700_000_000_123.456)).toBe('2023-11-14 22:13:20.123456');
    expect(displayValue(42n, 'other')).toBe('42');
    expect(displayValue(null, 'other')).toBeNull();
  });

  it('turns bar values into filter values the compiler accepts', () => {
    expect(filterValue(1_728_000_000_000, 'date')).toBe(1_728_000_000_000);
    expect(filterValue(1_700_000_000_123.5, 'timestamp')).toBe('2023-11-14 22:13:20.1235');
    expect(filterValue(7n, 'other')).toBe(7);
    expect(filterValue(undefined, 'other')).toBeNull();
  });
});
