import { describe, expect, it } from 'vitest';
import { ChartSpecSchema } from './chart.js';
import { ColumnProfileSchema } from './column.js';
import { FilterSchema } from './filter.js';
import { RowQuerySchema } from './rows.js';

describe('spec schemas', () => {
  it('fills defaults', () => {
    expect(ChartSpecSchema.parse({ mark: 'bar', x: { column: 'a' } })).toEqual({ mark: 'bar', x: { column: 'a' }, filters: [] });
    expect(FilterSchema.parse({ kind: 'range', column: 'a', min: 1 })).toEqual({
      kind: 'range',
      column: 'a',
      min: 1,
      minInclusive: true,
      maxInclusive: true,
    });
    expect(RowQuerySchema.parse({ offset: 0, limit: 10, sort: [{ column: 'a' }] })).toEqual({
      offset: 0,
      limit: 10,
      sort: [{ column: 'a', direction: 'asc' }],
      filters: [],
    });
  });

  it('is strict about unknown keys, so model output typos are caught', () => {
    expect(ChartSpecSchema.safeParse({ mark: 'bar', x: { column: 'a' }, colour: { column: 'b' } }).success).toBe(false);
    expect(FilterSchema.safeParse({ kind: 'in', column: 'a', values: [], negate: true }).success).toBe(false);
  });

  it('rejects non-finite numbers and out-of-range options', () => {
    expect(FilterSchema.safeParse({ kind: 'range', column: 'a', max: Infinity }).success).toBe(false);
    expect(FilterSchema.safeParse({ kind: 'in', column: 'a', values: [NaN] }).success).toBe(false);
    expect(ChartSpecSchema.safeParse({ mark: 'histogram', x: { column: 'a', bin: 0 } }).success).toBe(false);
    expect(ChartSpecSchema.safeParse({ mark: 'bar', x: { column: 'a', timeUnit: 'week' } }).success).toBe(false);
    expect(ChartSpecSchema.safeParse({ mark: 'scatter', x: { column: 'a' }, limit: 50_001 }).success).toBe(false);
    expect(RowQuerySchema.safeParse({ offset: 0, limit: 1001 }).success).toBe(false);
    expect(RowQuerySchema.safeParse({ offset: 1.5, limit: 10 }).success).toBe(false);
  });

  it('validates column profiles', () => {
    const profile = { name: 'a', type: 'date', nullFraction: 0.1, distinctCount: 3, min: '2024-01-01', max: '2024-02-01' };
    expect(ColumnProfileSchema.parse(profile)).toEqual(profile);
    expect(ColumnProfileSchema.safeParse({ ...profile, type: 'uuid' }).success).toBe(false);
    expect(ColumnProfileSchema.safeParse({ ...profile, nullFraction: 2 }).success).toBe(false);
  });
});
