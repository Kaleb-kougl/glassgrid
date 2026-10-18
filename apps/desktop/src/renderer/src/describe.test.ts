import { describe, expect, it } from 'vitest';
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
    expect(describeEntry({ name: 'resizeColumn', input: { column: 'amount', width: 180 } })).toBe('Resized amount to 180 px');
    expect(describeEntry({ name: 'reorderColumn', input: { column: 'amount', toIndex: 0 } })).toBe('Moved amount to position 1');
    expect(describeEntry({ name: 'sortGrid', input: { sort: [{ column: 'id', direction: 'desc' }] } })).toBe('Sorted by id ↓');
    expect(describeEntry({ name: 'addChart', input: { spec: { mark: 'bar', x: { column: 'category' } } } })).toBe('Added chart “Rows by category”');
    expect(describeEntry({ name: 'clearFilter', input: { viewId: 'c1' } }, { charts: [{ id: 'c1', spec: { mark: 'bar', x: { column: 'a' }, filters: [] } }] })).toBe(
      'Cleared the selection on “Rows by a”',
    );
  });
});
