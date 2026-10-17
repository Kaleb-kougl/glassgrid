import { describe, expect, it } from 'vitest';
import { FileHandleSchema, toFileHandle } from './ids.js';
import { formatBytes, formatDuration } from './format.js';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.00 KB'],
    [1536, '1.50 KB'],
    [5 * 1024 ** 3, '5.00 GB'],
    [123 * 1024 ** 2, '123 MB'],
  ])('formats %d as %s', (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });

  it('rejects negative input', () => {
    expect(() => formatBytes(-1)).toThrow(RangeError);
  });
});

describe('formatDuration', () => {
  it('switches units by magnitude', () => {
    expect(formatDuration(0.5)).toBe('0.50 ms');
    expect(formatDuration(42.4)).toBe('42 ms');
    expect(formatDuration(1530)).toBe('1.53 s');
  });
});

describe('FileHandle', () => {
  it('round-trips a generated handle', () => {
    const handle = toFileHandle('abcdef12-3456');
    expect(FileHandleSchema.parse(handle)).toBe(handle);
  });

  it('rejects handles with path characters', () => {
    expect(FileHandleSchema.safeParse('fh_../../etc').success).toBe(false);
  });
});
