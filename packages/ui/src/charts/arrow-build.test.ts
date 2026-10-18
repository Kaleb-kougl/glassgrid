import { describe, expect, it, vi } from 'vitest';
import { Bool, DateDay, Float64, Int32, TimestampMillisecond, Utf8, vectorFromArray } from 'apache-arrow';
import { vectorFromValues } from './arrow-build';

describe('vectorFromValues', () => {
  it('builds the same vectors as vectorFromArray, NULLs included', () => {
    const cases = [
      [['a', null, 'c', undefined], new Utf8()],
      [[true, null, false], new Bool()],
      [[1.5, null, Number.NaN], new Float64()],
      [[1, null, -3], new Int32()],
      [[Date.UTC(2024, 2, 1), null], new TimestampMillisecond()],
      [[Date.UTC(2024, 2, 1), null], new DateDay()],
    ] as const;
    for (const [values, type] of cases) {
      const built = vectorFromValues(values, type);
      const reference = vectorFromArray([...values].map((value) => value ?? null), type);
      expect(String(built.type)).toBe(String(reference.type));
      expect(built.nullCount).toBe(reference.nullCount);
      expect([...built].map(String)).toEqual([...reference].map(String));
    }
  });

  it('never compiles code (CSP without unsafe-eval)', () => {
    const compile = vi.spyOn(globalThis, 'Function');
    vectorFromValues(['a', null], new Utf8());
    expect(compile).not.toHaveBeenCalled();
    vectorFromArray(['a', null], new Utf8());
    expect(compile).toHaveBeenCalled();
    compile.mockRestore();
  });
});
