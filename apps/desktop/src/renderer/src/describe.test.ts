import { describe, expect, it } from 'vitest';
import { displayValue, filterValue, formatInterval, formatTime, formatTimestamp } from './arrow-values';
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

  it('formats decimals exactly, times and intervals like DuckDB', () => {
    // Decimal128 values arrive as four little-endian 32-bit words of the unscaled integer.
    const words = (unscaled: bigint) => {
      const u = BigInt.asUintN(128, unscaled);
      return new Uint32Array([0, 1, 2, 3].map((i) => Number((u >> BigInt(32 * i)) & 0xffffffffn)));
    };
    expect(displayValue(words(12_345n), 'decimal:2')).toBe('123.45');
    expect(displayValue(words(-5n), 'decimal:3')).toBe('-0.005');
    expect(displayValue(words(-(10n ** 37n) + 1n), 'decimal:0')).toBe('-9999999999999999999999999999999999999');
    expect(filterValue(words(150n), 'decimal:2')).toBe(1.5);
    expect(formatTime(45_296_789_000n)).toBe('12:34:56.789');
    expect(displayValue(45_296_000_000_001n, 'timeNs')).toBe('12:34:56.000000001');
    expect(formatInterval(new Int32Array([14, 3, 0, 0]))).toBe('1 year 2 months 3 days');
    expect(formatInterval(new Int32Array([-1, -1, -1_000_000_000, -1]))).toBe('-1 month -1 day -00:00:01');
    expect(formatInterval(new Int32Array([0, 0, 0, 0]))).toBe('00:00:00');
  });

  it('turns bar values into filter values the compiler accepts', () => {
    expect(filterValue(1_728_000_000_000, 'date')).toBe(1_728_000_000_000);
    expect(filterValue(1_700_000_000_123.5, 'timestamp')).toBe('2023-11-14 22:13:20.1235');
    expect(filterValue(7n, 'other')).toBe(7);
    expect(filterValue(undefined, 'other')).toBeNull();
  });
});
