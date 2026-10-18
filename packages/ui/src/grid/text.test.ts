import { describe, expect, it, vi } from 'vitest';
import { ELLIPSIS, FitCache, FontMetrics, RowLabels, type MeasureContext } from './text.js';

/** Every character 10px wide, the ellipsis 6px; counts measureText calls. */
function fakeContext() {
  const ctx = {
    font: '',
    measureText: vi.fn((text: string) => ({ width: text === ELLIPSIS ? 6 : 10 * text.length })),
  } satisfies MeasureContext;
  return ctx;
}

describe('FontMetrics', () => {
  it('measures each character once', () => {
    const ctx = fakeContext();
    const metrics = new FontMetrics('400 13px Plex', ctx);
    const before = ctx.measureText.mock.calls.length;
    expect(metrics.width('abcabc')).toBe(60);
    expect(metrics.width('cab')).toBe(30);
    expect(ctx.measureText.mock.calls.length - before).toBe(3);
    expect(metrics.width('ünï')).toBe(30);
    expect(ctx.font).toBe('');
  });

  it('keeps text that fits and cuts the rest with an ellipsis', () => {
    const metrics = new FontMetrics('f', fakeContext());
    expect(metrics.fit('hello', 50)).toBe('hello');
    expect(metrics.fit('hello world', 50)).toBe(`hell${ELLIPSIS}`);
    expect(metrics.fit('a b', 26)).toBe(`a${ELLIPSIS}`); // trailing space trimmed
    expect(metrics.fit('hello', 6)).toBe(ELLIPSIS);
    expect(metrics.fit('hello', 3)).toBe('');
    expect(metrics.fit('hello', 0)).toBe('');
  });

  it('does not split surrogate pairs', () => {
    const metrics = new FontMetrics('f', fakeContext());
    // Room for 2.6 code units: 'a' and half the emoji → back off to 'a'.
    expect(metrics.fit('a😀bcdef', 32)).toBe(`a${ELLIPSIS}`);
    expect(metrics.fit('a😀bcdef', 36)).toBe(`a😀${ELLIPSIS}`);
  });
});

describe('FitCache', () => {
  it('returns the same string object for repeated lookups', () => {
    const metrics = new FontMetrics('f', fakeContext());
    const cache = new FitCache();
    const first = cache.get('a long value', 50, metrics);
    expect(cache.get('a long value', 50, metrics)).toBe(first);
    expect(cache.size).toBe(1);
  });

  it('drops entries when the width or font changes and when full', () => {
    const metrics = new FontMetrics('f', fakeContext());
    const other = new FontMetrics('g', fakeContext());
    const cache = new FitCache(2);
    cache.get('one', 50, metrics);
    cache.get('two', 50, metrics);
    expect(cache.size).toBe(2);
    cache.get('three', 50, metrics);
    expect(cache.size).toBe(1);
    expect(cache.get('abcdefghij', 60, metrics)).toBe(`abcde${ELLIPSIS}`);
    expect(cache.size).toBe(1);
    cache.get('x', 60, other);
    expect(cache.size).toBe(1);
  });
});

describe('RowLabels', () => {
  it('labels rows from 1 and reuses labels for rows on screen', () => {
    const labels = new RowLabels(4);
    const label = labels.get(0);
    expect(label).toBe('1');
    expect(labels.get(0)).toBe(label);
    expect(labels.get(49_999_999)).toBe('50000000');
    expect(labels.get(4)).toBe('5'); // same slot as row 0 in a ring of 4
    expect(labels.get(0)).toBe('1');
  });
});
