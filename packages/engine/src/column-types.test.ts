import { describe, expect, it } from 'vitest';
import { simpleColumnType } from './column-types';

describe('simpleColumnType', () => {
  it.each([
    ['TINYINT', 'integer'],
    ['BIGINT', 'integer'],
    ['UHUGEINT', 'integer'],
    ['FLOAT', 'float'],
    ['DOUBLE', 'float'],
    ['DECIMAL(18,3)', 'decimal'],
    ['BOOLEAN', 'boolean'],
    ['DATE', 'date'],
    ['TIMESTAMP', 'timestamp'],
    ['TIMESTAMP WITH TIME ZONE', 'timestamp'],
    ['TIMESTAMP_NS', 'timestamp'],
    ['VARCHAR', 'text'],
    ['TIME', 'text'],
    ['INTERVAL', 'text'],
    ['VARCHAR[]', 'text'],
  ] as const)('%s -> %s', (duckdbType, expected) => {
    expect(simpleColumnType(duckdbType)).toBe(expected);
  });
});
