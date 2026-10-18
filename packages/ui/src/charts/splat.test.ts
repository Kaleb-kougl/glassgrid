import { describe, expect, it } from 'vitest';
import { discMask, splatDiscs } from './marks/scatter.js';

describe('scatter splat', () => {
  it('covers a disc with anti-aliased edges', () => {
    const { size, coverage } = discMask(2.5);
    expect(size).toBe(9);
    expect(coverage[4 * size + 4]).toBe(1); // centre
    expect(coverage[0]).toBe(0); // corner
    expect(coverage[4 * size + 1]).toBeCloseTo(0, 6); // 3 px from the centre: 2.5 + 0.5 − 3
    expect(coverage[4 * size + 2]).toBe(1);
  });

  it('blends overlapping points source-over and clips to the plot', () => {
    const pixels = splatDiscs(20, 10, 2, (i) => (i === 0 ? 5 : 6), () => 5, (i) => (i === 0 ? [255, 0, 0] : [0, 0, 255]), 1.5, 0.5, { left: 0, top: 0, right: 8, bottom: 10 });
    const at = (x: number, y: number) => Array.from(pixels.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 4));
    // Centre of the second disc: blue over red at 0.5 each → alpha 0.75, mostly blue.
    const [r, g, b, a] = at(6, 5);
    expect(a).toBeCloseTo(191, -1);
    expect(b).toBeGreaterThan(r ?? 0);
    expect(g).toBe(0);
    // Clipped at x = 8.
    expect(at(8, 5)[3]).toBe(0);
    expect(at(1, 5)[3]).toBe(0);
  });
});
