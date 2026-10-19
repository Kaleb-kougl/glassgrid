import { describe, expect, it } from 'vitest';
import { boundToNumber, formatAggregate, formatAxisValue, formatRange, formatTimeAt, numberToBound, parseTimeBound, timeResolution, toIsoTimestamp } from './format.js';
import { extent, makeScale, measureDomain, niceDomain, safeDomain, tickCount, timeTickFormat } from './scales.js';

describe('scales', () => {
  it('maps data to pixels without rounding, both ways', () => {
    const x = makeScale('number', [0, 3], [10, 110]);
    expect(x.toPx(1)).toBeCloseTo(43.3333333, 6);
    expect(x.fromPx(x.toPx(2.25))).toBeCloseTo(2.25, 12);
    const y = makeScale('number', [0, 10], [100, 0]);
    expect(y.toPx(10)).toBe(0);
    expect(y.fromPx(50)).toBe(5);
  });

  it('widens degenerate domains and finds extents of finite values', () => {
    expect(safeDomain([5, 5], 'number')).toEqual([2.5, 7.5]);
    expect(safeDomain([0, 0], 'number')).toEqual([-1, 1]);
    expect(safeDomain(null, 'number')).toEqual([0, 1]);
    const t = Date.UTC(2023, 0, 1);
    expect(safeDomain([t, t], 'time')).toEqual([t - 43_200_000, t + 43_200_000]);
    expect(extent(Float64Array.from([3, Number.NaN, -1]), [7])).toEqual([-1, 7]);
    expect(extent([Number.NaN])).toBeNull();
  });

  it('nices measure domains from zero', () => {
    expect(measureDomain([12, 27_481], 5)).toEqual([0, 30_000]);
    expect(measureDomain([-3, 8], 5)).toEqual([-4, 8]);
    expect(niceDomain('number', [0.13, 0.97], 5)).toEqual([0, 1]);
    expect(niceDomain('number', [43, 97], 5)).toEqual([40, 100]);
    expect(tickCount(140, 28)).toBe(5);
    expect(tickCount(10, 28)).toBe(2);
  });

  it('formats number ticks with grouping, and compact SI from 10,000', () => {
    const small = makeScale('number', [0, 1], [0, 100]);
    expect(small.ticks(5).map(small.tickFormat(5))).toEqual(['0.0', '0.2', '0.4', '0.6', '0.8', '1.0']);
    const thousands = makeScale('number', [0, 4000], [0, 100]);
    expect(thousands.ticks(4).map(thousands.tickFormat(4))).toEqual(['0', '1,000', '2,000', '3,000', '4,000']);
    const big = makeScale('number', [0, 3_000_000_000], [0, 100]);
    expect(big.ticks(3).map(big.tickFormat(3))).toEqual(['0', '1B', '2B', '3B']);
    const counts = makeScale('number', [0, 30_000], [0, 100]);
    expect(counts.ticks(3).map(counts.tickFormat(3))).toEqual(['0', '10K', '20K', '30K']);
  });

  it('places time ticks on UTC calendar boundaries with multi-scale labels', () => {
    const x = makeScale('time', [Date.UTC(2023, 0, 1), Date.UTC(2023, 0, 31)], [0, 400]);
    const ticks = x.ticks(4);
    expect(ticks.map(timeTickFormat)).toEqual(['2023', 'Jan 8', 'Jan 15', 'Jan 22', 'Jan 29']);
    expect(timeTickFormat(Date.UTC(2023, 1, 1))).toBe('Feb');
    expect(timeTickFormat(Date.UTC(2023, 1, 1, 14))).toBe('14:00');
    expect(timeTickFormat(Date.UTC(2023, 1, 1, 14, 0, 30))).toBe(':30');
    expect(timeTickFormat(Date.UTC(2023, 1, 1, 14, 0, 30, 250))).toBe('.250');
    const hours = makeScale('time', [Date.UTC(2023, 0, 1), Date.UTC(2023, 0, 1, 12)], [0, 400]);
    expect(hours.ticks(4).map(timeTickFormat)).toEqual(['2023', '03:00', '06:00', '09:00', '12:00']);
  });
});

describe('chart text', () => {
  it('prints aggregates through the shared number rules (integers exact, two decimals, small values significant)', () => {
    expect(formatAggregate(2_688_301)).toBe('2,688,301');
    expect(formatAggregate((39_015_093.43 - 1e-8))).toBe('39,015,093.43');
    expect(formatAggregate(3.14159265)).toBe('3.14');
    expect(formatAggregate(0.00001234)).toBe('0.0000123');
    expect(formatAggregate(Number.NaN)).toBe('–');
  });

  it('prints axis values at their own precision', () => {
    expect(formatAxisValue(3.14159265, 'number')).toBe('3.141593');
    expect(formatAxisValue(0.1 + 0.2, 'number')).toBe('0.3');
    expect(formatRange(52.016, 52.018, 'number')).toBe('52.016 – 52.018');
  });

  it('detects the bucket resolution of timestamps', () => {
    expect(timeResolution([Date.UTC(2023, 0, 1), Date.UTC(2024, 0, 1)])).toBe('year');
    expect(timeResolution([Date.UTC(2023, 0, 1), Date.UTC(2023, 1, 1)])).toBe('month');
    expect(timeResolution([Date.UTC(2023, 0, 1), Date.UTC(2023, 0, 20)])).toBe('day');
    expect(timeResolution([Date.UTC(2023, 0, 1, 5)])).toBe('hour');
    expect(timeResolution([Date.UTC(2023, 0, 1, 5, 3, 1, 5), Number.NaN])).toBe('millisecond');
  });

  it('titles time buckets at their resolution', () => {
    const t = Date.UTC(2023, 0, 20, 14);
    expect(formatTimeAt(Date.UTC(2023, 0, 20), 'day')).toBe('Fri, Jan 20, 2023');
    expect(formatTimeAt(Date.UTC(2023, 0, 1), 'month')).toBe('Jan 2023');
    expect(formatTimeAt(t, 'hour')).toBe('Fri, Jan 20, 2023 14:00');
    expect(formatAxisValue(t + 1500, 'time', 'millisecond')).toBe('2023-01-20 14:00:01.5');
    expect(formatRange(2, 6, 'number')).toBe('2 – 6');
  });

  it('converts brush bounds to ISO timestamps and back (UTC, sub-millisecond kept)', () => {
    expect(toIsoTimestamp(Date.UTC(2023, 0, 9))).toBe('2023-01-09');
    expect(toIsoTimestamp(Date.UTC(2023, 0, 9, 12, 30))).toBe('2023-01-09 12:30:00');
    expect(toIsoTimestamp(Date.UTC(2023, 0, 9, 12, 30) + 0.25)).toBe('2023-01-09 12:30:00.00025');
    for (const ms of [Date.UTC(2023, 0, 9), Date.UTC(1999, 11, 31, 23, 59, 59, 999), Date.UTC(2023, 0, 9, 12, 30) + 0.25]) {
      expect(parseTimeBound(toIsoTimestamp(ms))).toBeCloseTo(ms, 6);
    }
    expect(parseTimeBound('2023-01-09T12:30:00Z')).toBe(Date.UTC(2023, 0, 9, 12, 30));
    expect(parseTimeBound('next tuesday')).toBeNaN();
    expect(numberToBound(2.5, 'number')).toBe(2.5);
    expect(boundToNumber('2023-01-09', 'time')).toBe(Date.UTC(2023, 0, 9));
    expect(boundToNumber(Date.UTC(2023, 0, 9), 'time')).toBe(Date.UTC(2023, 0, 9));
  });
});
