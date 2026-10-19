import { describe, expect, it } from 'vitest';
import {
  COMPACT_LABEL_MIN,
  compactLabels,
  decimalsNeeded,
  formatCompact,
  formatFilterNumber,
  formatInteger,
  formatMeasure,
  formatNumber,
  formatNumericRange,
  labelFormatter,
  measureFormatter,
  measureMode,
  trimFloat,
} from './number-format.js';

describe('trimFloat', () => {
  it('drops binary noise and keeps real precision', () => {
    expect(trimFloat(0.1 + 0.2)).toBe(0.3);
    expect(trimFloat((39_015_093.43 - 1e-8))).toBe(39_015_093.43);
    expect(trimFloat(52.0213459)).toBe(52.0213459);
    expect(trimFloat(-0)).toBe(-0);
    expect(trimFloat(Number.NaN)).toBeNaN();
  });
});

describe('formatInteger', () => {
  it.each([
    [0, '0'],
    [-0, '0'],
    [7, '7'],
    [2_000_000, '2,000,000'],
    [-1_234, '-1,234'],
    [2.6, '3'],
    [-0.4, '0'],
    [Number.MAX_SAFE_INTEGER, '9,007,199,254,740,991'],
  ])('%d → %s', (input, expected) => {
    expect(formatInteger(input)).toBe(expected);
  });

  it('keeps every digit of a bigint (BIGINT, HUGEINT)', () => {
    expect(formatInteger(9_007_199_254_740_993n)).toBe('9,007,199,254,740,993');
    expect(formatInteger(-(2n ** 100n))).toBe('-1,267,650,600,228,229,401,496,703,205,376');
    expect(formatInteger(0n)).toBe('0');
  });

  it('prints missing and non-finite values', () => {
    expect(formatInteger(null)).toBe('–');
    expect(formatInteger(undefined)).toBe('–');
    expect(formatInteger(Number.NaN)).toBe('–');
    expect(formatInteger(Infinity)).toBe('∞');
    expect(formatInteger(-Infinity)).toBe('-∞');
    expect(formatInteger(1e22)).toBe('1.00e22');
  });
});

describe('formatNumber', () => {
  it.each([
    [0, '0'],
    [-0, '0'],
    [3, '3'],
    [1_234_567, '1,234,567'],
    [0.1 + 0.2, '0.3'],
    [52.0213459, '52.021346'],
    [-1234.5, '-1,234.5'],
    [(39_015_093.43 - 1e-8), '39,015,093.43'],
    [1e-5, '0.00001'],
    [1.234e-7, '1.23e-7'],
    [-1.234e-7, '-1.23e-7'],
    [-0.0000004, '-4.00e-7'],
    [1e21, '1.00e21'],
    [123_456_789_012_345.5, '123,456,789,012,346'],
  ])('%d → %s', (input, expected) => {
    expect(formatNumber(input)).toBe(expected);
  });

  it('caps decimals on request and handles bigint and missing values', () => {
    expect(formatNumber(3.14159, 2)).toBe('3.14');
    expect(formatNumber(-0.001, 2)).toBe('-1.00e-3');
    expect(formatNumber(12n)).toBe('12');
    expect(formatNumber(null)).toBe('–');
    expect(formatNumber(Number.NaN)).toBe('–');
    expect(formatNumber(-Infinity)).toBe('-∞');
  });
});

describe('formatMeasure', () => {
  it('counts and integer columns are exact integers', () => {
    expect(formatMeasure(85_076, { aggregate: 'count' })).toBe('85,076');
    expect(formatMeasure(1_209)).toBe('1,209');
    expect(formatMeasure(123_456, { aggregate: 'sum', type: 'integer' })).toBe('123,456');
    expect(formatMeasure(2n ** 70n, { aggregate: 'sum', type: 'integer' })).toBe('1,180,591,620,717,411,303,424');
  });

  it('sums of floats read like money: two decimals, grouped, no noise', () => {
    expect(formatMeasure((39_015_093.43 - 1e-8), { aggregate: 'sum', type: 'float' })).toBe('39,015,093.43');
    expect(formatMeasure(2_624_740.4, { aggregate: 'sum', type: 'float' })).toBe('2,624,740.40');
    expect(formatMeasure(-12.345, { aggregate: 'sum', type: 'float' })).toBe('-12.35');
    expect(formatMeasure(-0.001, { aggregate: 'sum', type: 'float' })).toBe('-0.00100');
    expect(formatMeasure(-0.0000001, { aggregate: 'sum', type: 'float' })).toBe('-1.00e-7');
  });

  it('averages have fixed decimals; below 1, three significant digits', () => {
    expect(formatMeasure(4.285_31, { aggregate: 'avg' })).toBe('4.29');
    expect(formatMeasure(3, { aggregate: 'avg', type: 'integer' })).toBe('3.00');
    expect(formatMeasure(0.5, { aggregate: 'avg' })).toBe('0.500');
    expect(formatMeasure(0.012_345, { aggregate: 'avg' })).toBe('0.0123');
    expect(formatMeasure(-0, { aggregate: 'avg' })).toBe('0.00');
  });

  it('DECIMAL results keep their scale (capped at 6)', () => {
    expect(formatMeasure(1234.5, { aggregate: 'sum', type: 'decimal', scale: 2 })).toBe('1,234.50');
    expect(formatMeasure(7, { aggregate: 'max', type: 'decimal', scale: 3 })).toBe('7.000');
    expect(formatMeasure(1.5, { aggregate: 'sum', type: 'decimal', scale: 0 })).toBe('1.50');
    expect(formatMeasure(1, { scale: 10 })).toBe('1.000000');
  });

  it('min and max of a float keep the column precision', () => {
    expect(formatMeasure(52.0213459, { aggregate: 'min', type: 'float' })).toBe('52.021346');
    expect(formatMeasure(4.2, { aggregate: 'max', type: 'float' })).toBe('4.2');
  });

  it('missing values', () => {
    expect(formatMeasure(null)).toBe('–');
    expect(formatMeasure(Number.NaN, { aggregate: 'sum' })).toBe('–');
    expect(formatMeasure(Infinity)).toBe('∞');
  });
});

describe('measureFormatter and measureMode', () => {
  it('one mode per result, so labels are consistent', () => {
    expect(measureMode({ aggregate: 'sum', type: 'float' }, [1, 2, 3])).toBe('integer');
    expect(measureMode({ aggregate: 'sum', type: 'float' }, [1, 2.5])).toBe('fixed2');
    expect(measureMode({ aggregate: 'sum', type: 'float' }, [Number.NaN])).toBe('fixed2');
    expect(measureMode({ aggregate: 'avg' }, [1, 2])).toBe('avg');
    expect(measureMode({ scale: 2 })).toBe('scale:2');
    const format = measureFormatter({ aggregate: 'sum', type: 'float' }, [5, 4.5]);
    expect(format(5)).toBe('5.00');
    expect(format(4.5)).toBe('4.50');
    expect(format(Number.NaN)).toBe('–');
    expect(measureFormatter({ aggregate: 'sum', type: 'float' }, [5, 6])(5)).toBe('5');
  });
});

describe('formatCompact and labelFormatter', () => {
  it.each([
    [0, '0'],
    [-0, '0'],
    [523.4, '523'],
    [0.5, '0.500'],
    [85_076, '85.1K'],
    [1_000, '1.00K'],
    [812_345, '812K'],
    [9_399_854.36, '9.40M'],
    [39_015_093.43, '39.0M'],
    [1.5e9, '1.50B'],
    [-2_500_000, '-2.50M'],
    [2e15, '2.00e15'],
    [1e-9, '1.00e-9'],
  ])('%d → %s', (input, expected) => {
    expect(formatCompact(input)).toBe(expected);
  });

  it('handles bigint and missing values', () => {
    expect(formatCompact(5_000_000n)).toBe('5.00M');
    expect(formatCompact(null)).toBe('–');
    expect(formatCompact(Number.NaN)).toBe('–');
  });

  it('labels go compact once the largest value reaches a million', () => {
    const sums = [(39_015_093.43 - 1e-8), 2_025_433.06];
    expect(labelFormatter({ aggregate: 'sum', type: 'float' }, sums)(sums[0] ?? 0)).toBe('39.0M');
    const counts = [85_076, 1_209];
    expect(labelFormatter({ aggregate: 'count' }, counts)(85_076)).toBe('85,076');
    // Whole numbers stay exact up to a billion; other values go compact from a million.
    expect(labelFormatter({ aggregate: 'count' }, [1_375_980, 4_092])(1_375_980)).toBe('1,375,980');
    expect(labelFormatter({ aggregate: 'count' }, [2e9])(2e9)).toBe('2.00B');
    expect(labelFormatter({}, [COMPACT_LABEL_MIN - 0.5])(COMPACT_LABEL_MIN - 0.5)).toBe('999,999.50');
    expect(labelFormatter({}, [-COMPACT_LABEL_MIN - 0.5])(-COMPACT_LABEL_MIN)).toBe('-1.00M');
    expect(compactLabels([Number.NaN])).toBe(false);
  });
});

describe('filter numbers and ranges', () => {
  it('decimalsNeeded', () => {
    expect(decimalsNeeded(2)).toBe(0);
    expect(decimalsNeeded(2.5)).toBe(1);
    expect(decimalsNeeded(0.125)).toBe(3);
    expect(decimalsNeeded(Math.PI)).toBe(6);
    expect(decimalsNeeded(Number.NaN)).toBe(0);
  });

  it('single values: floats with at least two decimals', () => {
    expect(formatFilterNumber(2, 'float')).toBe('2.00');
    expect(formatFilterNumber(1234.5, 'decimal')).toBe('1,234.50');
    expect(formatFilterNumber(3, 'integer')).toBe('3');
    expect(formatFilterNumber(0.125, null)).toBe('0.125');
    expect(formatFilterNumber(-0, 'float')).toBe('0.00');
    expect(formatFilterNumber(Number.NaN, 'float')).toBe('–');
  });

  it('ranges share decimals and do not print more than the span warrants', () => {
    expect(formatNumericRange(5, 16, 'float')).toEqual(['5.00', '16.00']);
    expect(formatNumericRange(5, 16, 'integer')).toEqual(['5', '16']);
    expect(formatNumericRange(0.125, 2, 'float')).toEqual(['0.125', '2.000']);
    expect(formatNumericRange(Math.PI, 7.2, 'float')).toEqual(['3.14', '7.20']);
    expect(formatNumericRange(52.021_345_9, 52.056_712, 'float')).toEqual(['52.0213', '52.0567']);
    expect(formatNumericRange(1000, 250_000, null)).toEqual(['1,000', '250,000']);
    expect(formatNumericRange(-0.5, 0.5, 'float')).toEqual(['-0.50', '0.50']);
    expect(formatNumericRange(3, 3, 'float')).toEqual(['3.00', '3.00']);
  });
});
