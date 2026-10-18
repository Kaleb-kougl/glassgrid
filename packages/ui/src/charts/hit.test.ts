import { describe, expect, it } from 'vitest';
import { binAt, buildBinIndex, buildGridIndex, buildPointGrid, gridCellAt, lowerBound, nearestPoint, nearestSorted, uniqueSorted } from './hit.js';

describe('hit-test indexes', () => {
  it('binary-searches sorted rows for the nearest x (line / area)', () => {
    const xs = [10, 0, 20, 30];
    const order = [1, 0, 2, 3]; // sorted by x: 0, 10, 20, 30
    expect(lowerBound(4, 15, (k) => xs[order[k] ?? 0] ?? 0)).toBe(2);
    expect(nearestSorted(xs, order, 0, 4, 14)).toBe(0);
    expect(nearestSorted(xs, order, 0, 4, 16)).toBe(2);
    expect(nearestSorted(xs, order, 0, 4, 15)).toBe(0); // tie → earlier
    expect(nearestSorted(xs, order, 0, 4, -50)).toBe(1);
    expect(nearestSorted(xs, order, 0, 4, 99)).toBe(3);
    expect(nearestSorted(xs, order, 2, 2, 5)).toBe(-1);
    // A sub-range (one series).
    expect(nearestSorted(xs, order, 2, 4, 0)).toBe(2);
  });

  it('looks up histogram bins, with gaps for empty bins and stacked rows per bin', () => {
    // Bins [0,1) (two series), [1,2), [3,4) — bin [2,3) is empty.
    const x = [1, 0, 3, 0];
    const xEnd = [2, 1, 4, 1];
    const index = buildBinIndex(x, xEnd, [1, 3, 0, 2]);
    expect(Array.from(index.starts)).toEqual([0, 1, 3]);
    expect(Array.from(index.ends)).toEqual([1, 2, 4]);
    expect(Array.from(index.rowStart)).toEqual([0, 2, 3, 4]);
    expect(Array.from(index.rows.subarray(0, 2))).toEqual([1, 3]); // order of `order` within the bin
    expect(binAt(index, 0)).toBe(0);
    expect(binAt(index, 0.999)).toBe(0);
    expect(binAt(index, 1)).toBe(1);
    expect(binAt(index, 2.5)).toBe(-1);
    expect(binAt(index, 3.2)).toBe(2);
    expect(binAt(index, 4)).toBe(-1);
    expect(binAt(index, -1)).toBe(-1);
  });

  it('looks up heatmap cells by bin on both axes', () => {
    const grid = buildGridIndex([0, 1, 1], [1, 2, 2], [0, 0, 10], [10, 10, 20]);
    expect(Array.from(grid.xStarts)).toEqual([0, 1]);
    expect(Array.from(grid.yStarts)).toEqual([0, 10]);
    expect(gridCellAt(grid, 0.5, 5)).toBe(0);
    expect(gridCellAt(grid, 1.5, 5)).toBe(1);
    expect(gridCellAt(grid, 1.5, 15)).toBe(2);
    expect(gridCellAt(grid, 0.5, 15)).toBe(-1); // empty cell
    expect(gridCellAt(grid, 2.5, 5)).toBe(-1);
  });

  it('finds the nearest scatter point through a pixel grid', () => {
    const px = [10, 12, 50, 200, Number.NaN];
    const py = [10, 11, 50, 90, 5];
    const grid = buildPointGrid(px.length, (i) => px[i] ?? 0, (i) => py[i] ?? 0, { left: 0, top: 0, width: 220, height: 100 }, 8);
    expect(grid.points.length).toBe(4); // NaN left out
    expect(nearestPoint(grid, 11.6, 10.8, 6)).toBe(1);
    expect(nearestPoint(grid, 9, 9, 6)).toBe(0);
    expect(nearestPoint(grid, 30, 30, 6)).toBe(-1);
    expect(nearestPoint(grid, 203, 92, 6)).toBe(3);
    // Coincident points: the later one (drawn on top) wins.
    const same = buildPointGrid(2, () => 5, () => 5, { left: 0, top: 0, width: 20, height: 20 });
    expect(nearestPoint(same, 5, 5, 3)).toBe(1);
  });

  it('collects unique sorted edges', () => {
    expect(Array.from(uniqueSorted([2, 0, 1, Number.NaN], [3, 1, 2]))).toEqual([0, 1, 2, 3]);
  });
});
