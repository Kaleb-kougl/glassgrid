import { Bool, DataType, DateDay, Decimal, Float64, Int64, Table, TimestampMicrosecond, TimestampSecond, Utf8, makeVector, tableFromArrays, tableFromIPC, tableToIPC, vectorFromArray } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import { OTHER_SERIES_KEY, chartColumnsFromArrow, fillNumbers, valueKey } from './arrow.js';
import { syntheticLineTable } from './synthetic.js';

const roundTrip = (table: Table) => tableFromIPC(tableToIPC(table));

describe('fillNumbers', () => {
  it('copies doubles with NULL as NaN, across chunks and slices', () => {
    const vector = vectorFromArray([1.5, null, 3, 4, null, 6], new Float64());
    const out = new Float64Array(4);
    fillNumbers(vector.slice(2), out);
    expect(Array.from(out)).toEqual([3, 4, NaN, 6]);
  });

  it('turns timestamps of any unit into epoch milliseconds', () => {
    const micros = vectorFromArray([Date.UTC(2023, 0, 20, 12) + 0.5, null], new TimestampMicrosecond());
    const out = new Float64Array(2);
    fillNumbers(micros, out);
    expect(out[0]).toBe(Date.UTC(2023, 0, 20, 12) + 0.5);
    expect(out[1]).toBeNaN();
    const seconds = vectorFromArray([Date.UTC(2023, 0, 1)], new TimestampSecond());
    fillNumbers(seconds, out);
    expect(out[0]).toBe(Date.UTC(2023, 0, 1));
  });

  it('reads DATE as midnight UTC, BIGINT and DECIMAL as numbers', () => {
    const out = new Float64Array(2);
    fillNumbers(vectorFromArray([Date.UTC(2024, 1, 29), null], new DateDay()), out);
    expect(out[0]).toBe(Date.UTC(2024, 1, 29));
    expect(out[1]).toBeNaN();
    fillNumbers(vectorFromArray([12n, null], new Int64()), out);
    expect(Array.from(out)).toEqual([12, NaN]);
    // DECIMAL(10,2): -0.05 and 123.40 as unscaled 128-bit words.
    const words = new Uint32Array([0xfffffffb, 0xffffffff, 0xffffffff, 0xffffffff, 12340, 0, 0, 0]);
    const decimal = makeVector({ type: new Decimal(2, 10, 128), data: words, length: 2 } as never);
    fillNumbers(decimal, out);
    expect(out[0]).toBeCloseTo(-0.05, 12);
    expect(out[1]).toBeCloseTo(123.4, 12);
  });
});

describe('chartColumnsFromArrow', () => {
  it('reads a line result into typed arrays with time x and NULL gaps', () => {
    const table = roundTrip(
      new Table({
        x: vectorFromArray([Date.UTC(2023, 0, 3), Date.UTC(2023, 0, 1), Date.UTC(2023, 0, 2)], new TimestampMicrosecond()),
        y: vectorFromArray([3, 1, null], new Float64()),
      }),
    );
    const data = chartColumnsFromArrow(table, 'line');
    expect(data.xKind).toBe('time');
    expect(data.x).toBeInstanceOf(Float64Array);
    expect(Array.from(data.y)).toEqual([3, 1, NaN]);
    expect(data.series).toBeNull();
    // Rows sorted by x for drawing; the result order is kept in the columns.
    expect(Array.from(data.order)).toEqual([1, 2, 0]);
    expect(Array.from(data.seriesStart)).toEqual([0, 3]);
  });

  it('ranks colour series by total, folds Other last and keys them like filter values', () => {
    const table = roundTrip(
      new Table({
        x: vectorFromArray([1, 2, 1, 2, 1, 2, 1], new Float64()),
        y: vectorFromArray([1, 1, 10, 10, 5, 5, 2], new Float64()),
        color: vectorFromArray(['cash', 'cash', 'card', 'card', null, null, null], new Utf8()),
        color_other: vectorFromArray([false, false, false, false, true, true, false], new Bool()),
      }),
    );
    const data = chartColumnsFromArrow(table, 'line');
    expect(data.seriesList.map((s) => [s.label, s.key, s.total])).toEqual([
      ['card', valueKey('card'), 20],
      ['cash', valueKey('cash'), 2],
      ['null', valueKey(null), 2],
      ['Other', OTHER_SERIES_KEY, 10],
    ]);
    expect(data.seriesList.map((s) => [s.isOther, s.isNull])).toEqual([
      [false, false],
      [false, false],
      [false, true],
      [true, false],
    ]);
    expect(Array.from(data.series ?? [])).toEqual([1, 1, 0, 0, 3, 3, 2]);
    expect(Array.from(data.seriesStart)).toEqual([0, 2, 4, 5, 7]);
    expect(Array.from(data.order)).toEqual([2, 3, 0, 1, 6, 4, 5]);
  });

  it('handles dictionary-encoded and numeric colour columns', () => {
    const utf8 = chartColumnsFromArrow(syntheticLineTable({ points: 4, series: 3, other: true }), 'line');
    expect(utf8.seriesList.map((s) => s.label)).toEqual(['Credit card', 'Cash', 'Other']);
    expect(utf8.seriesList[2]?.isOther).toBe(true);
    const dictTable = roundTrip(tableFromArrays({ x: Float64Array.from([1, 2, 3]), y: Float64Array.from([1, 5, 1]), color: ['p', 'q', 'p'], color_other: [false, false, false] }));
    expect(DataType.isDictionary(dictTable.schema.fields[2]?.type)).toBe(true);
    const dict = chartColumnsFromArrow(dictTable, 'line');
    expect(dict.seriesList.map((s) => [s.label, s.total])).toEqual([
      ['q', 5],
      ['p', 2],
    ]);
    expect(Array.from(dict.series ?? [])).toEqual([1, 0, 1]);
    const numeric = chartColumnsFromArrow(
      new Table({
        x: vectorFromArray([1, 2, 3], new Float64()),
        y: vectorFromArray([1, 1, 1], new Float64()),
        color: vectorFromArray([7n, 8n, 7n], new Int64()),
        color_other: vectorFromArray([false, false, false], new Bool()),
      }),
      'scatter',
    );
    // Scatter ranks by rows.
    expect(numeric.seriesList.map((s) => [s.label, s.value, s.rows])).toEqual([
      ['7', 7, 2],
      ['8', 8, 1],
    ]);
  });

  it('reads bar categories with labels, NULL and filter values', () => {
    const table = new Table({ x: vectorFromArray(['b', null, 'a'], new Utf8()), y: vectorFromArray([5, 4, null], new Float64()) });
    const data = chartColumnsFromArrow(table, 'bar');
    expect(data.xKind).toBe('category');
    expect(data.categories).toEqual([
      { key: '"b"', label: 'b', isNull: false, value: 'b' },
      { key: 'null', label: 'null', isNull: true, value: null },
      { key: '"a"', label: 'a', isNull: false, value: 'a' },
    ]);
    expect(Array.from(data.y)).toEqual([5, 4, NaN]);
  });

  it('reads histogram and heatmap bin columns', () => {
    const histogram = chartColumnsFromArrow(
      new Table({ x: vectorFromArray([2, 0], new Float64()), x_end: vectorFromArray([3, 1], new Float64()), y: vectorFromArray([7, 9], new Float64()) }),
      'histogram',
    );
    expect(Array.from(histogram.xEnd ?? [])).toEqual([3, 1]);
    const heatmap = chartColumnsFromArrow(
      new Table({
        x: vectorFromArray([0], new Float64()),
        x_end: vectorFromArray([1], new Float64()),
        y: vectorFromArray([Date.UTC(2023, 0, 1)], new TimestampMicrosecond()),
        y_end: vectorFromArray([Date.UTC(2023, 0, 2)], new TimestampMicrosecond()),
        count: vectorFromArray([42n], new Int64()),
      }),
      'heatmap',
    );
    expect(heatmap.yKind).toBe('time');
    expect(heatmap.yEnd?.[0]).toBe(Date.UTC(2023, 0, 2));
    expect(heatmap.count?.[0]).toBe(42);
  });

  it('does not allocate per row for a large numeric result', () => {
    const n = 200_000;
    const x = new Float64Array(n).map((_, i) => i);
    const data = chartColumnsFromArrow(new Table({ x: makeVector(x), y: makeVector(x) }), 'scatter');
    expect(data.length).toBe(n);
    expect(data.x[n - 1]).toBe(n - 1);
  });
});
