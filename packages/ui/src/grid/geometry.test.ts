import { describe, expect, it } from 'vitest';
import {
  clampedColumnAtX,
  clampedRowAtY,
  columnAt,
  columnOffsets,
  createColWindow,
  createRowWindow,
  createScrollMapping,
  gutterWidthFor,
  hitTest,
  MAX_SCROLL_HEIGHT,
  reorderTarget,
  rowsPerPage,
  scrollLeftForColumn,
  scrollToVirtual,
  scrollTopForRow,
  virtualToScroll,
  visibleColumns,
  visibleRows,
  type HitLayout,
} from './geometry.js';

const ROW = 32;
const BODY = 868; // 900px viewport minus the 32px header

describe('scroll mapping', () => {
  it('is the identity below the spacer limit', () => {
    const mapping = createScrollMapping(10_000, ROW, BODY);
    expect(mapping.scaled).toBe(false);
    expect(mapping.spacerHeight).toBe(320_000);
    expect(mapping.scrollRange).toBe(320_000 - BODY);
    expect(scrollToVirtual(mapping, 1234)).toBe(1234);
    expect(virtualToScroll(mapping, 1234)).toBe(1234);
  });

  it('switches to scaled mapping exactly past the limit', () => {
    const rows = MAX_SCROLL_HEIGHT / ROW;
    expect(createScrollMapping(rows, ROW, BODY).scaled).toBe(false);
    expect(createScrollMapping(rows + 1, ROW, BODY).scaled).toBe(true);
  });

  it('keeps the spacer under the limit at 50M rows', () => {
    const mapping = createScrollMapping(50_000_000, ROW, BODY);
    expect(mapping.scaled).toBe(true);
    expect(mapping.spacerHeight).toBe(MAX_SCROLL_HEIGHT);
    expect(mapping.virtualHeight).toBe(1_600_000_000);
  });

  it('reaches the first and the last row at 50M rows', () => {
    const rows = 50_000_000;
    const mapping = createScrollMapping(rows, ROW, BODY);
    const window = createRowWindow();

    visibleRows(scrollToVirtual(mapping, 0), BODY, ROW, rows, 0, window);
    expect(window.firstVisible).toBe(0);

    const bottom = scrollToVirtual(mapping, mapping.scrollRange);
    expect(bottom).toBe(mapping.virtualRange);
    visibleRows(bottom, BODY, ROW, rows, 1, window);
    expect(window.lastVisible).toBe(rows - 1);
    expect(window.last).toBe(rows - 1);
    // The last row is fully inside the body.
    expect((rows - 1) * ROW + ROW).toBeLessThanOrEqual(bottom + BODY + 1e-6);
  });

  it('round-trips and clamps', () => {
    const mapping = createScrollMapping(50_000_000, ROW, BODY);
    for (const top of [0, 1, 999_999, 7_500_000, mapping.scrollRange]) {
      expect(virtualToScroll(mapping, scrollToVirtual(mapping, top))).toBeCloseTo(top, 6);
    }
    expect(scrollToVirtual(mapping, -50)).toBe(0);
    expect(scrollToVirtual(mapping, mapping.scrollRange + 1e6)).toBe(mapping.virtualRange);
    expect(virtualToScroll(mapping, 1e12)).toBe(mapping.scrollRange);
  });

  it('maps a row in the middle proportionally', () => {
    const mapping = createScrollMapping(50_000_000, ROW, BODY);
    const half = scrollToVirtual(mapping, mapping.scrollRange / 2);
    expect(Math.floor(half / ROW)).toBe(Math.floor(mapping.virtualRange / 2 / ROW));
  });

  it('handles empty tables and tiny viewports', () => {
    const empty = createScrollMapping(0, ROW, BODY);
    expect(empty.scaled).toBe(false);
    expect(empty.scrollRange).toBe(0);
    expect(scrollToVirtual(empty, 100)).toBe(0);
    const short = createScrollMapping(5, ROW, BODY);
    expect(short.virtualRange).toBe(0);
    expect(virtualToScroll(short, 500)).toBe(0);
  });
});

describe('visibleRows', () => {
  it('returns the visible window plus one row of overscan', () => {
    const window = visibleRows(0, BODY, ROW, 1_000, 1, createRowWindow());
    expect(window.firstVisible).toBe(0);
    expect(window.lastVisible).toBe(27); // 868 / 32 = 27.1 → rows 0..27
    expect(window.first).toBe(0); // no row above row 0
    expect(window.last).toBe(28);
  });

  it('counts partly visible rows at both edges', () => {
    const window = visibleRows(16, 64, ROW, 1_000, 1, createRowWindow());
    expect(window.firstVisible).toBe(0);
    expect(window.lastVisible).toBe(2);
    expect(window.first).toBe(0);
    expect(window.last).toBe(3);
    // A row starting exactly at the bottom edge is not visible.
    const exact = visibleRows(0, 64, ROW, 1_000, 0, createRowWindow());
    expect(exact.lastVisible).toBe(1);
  });

  it('clamps to the row count and handles no rows', () => {
    const window = visibleRows(0, BODY, ROW, 3, 1, createRowWindow());
    expect([window.first, window.last, window.lastVisible]).toEqual([0, 2, 2]);
    const empty = visibleRows(0, BODY, ROW, 0, 1, createRowWindow());
    expect(empty.last).toBeLessThan(empty.first);
  });

  it('reuses the out object', () => {
    const out = createRowWindow();
    expect(visibleRows(320, BODY, ROW, 1_000, 1, out)).toBe(out);
    expect(out.firstVisible).toBe(10);
    expect(out.first).toBe(9);
  });
});

describe('columns', () => {
  const offsets = columnOffsets([100, 200, 50, 150], 52);

  it('computes offsets from the gutter', () => {
    expect([...offsets]).toEqual([52, 152, 352, 402, 552]);
    expect(columnOffsets([], 52).length).toBe(1);
  });

  it('finds the column at a content x', () => {
    expect(columnAt(offsets, 51)).toBe(-1);
    expect(columnAt(offsets, 52)).toBe(0);
    expect(columnAt(offsets, 151.9)).toBe(0);
    expect(columnAt(offsets, 152)).toBe(1);
    expect(columnAt(offsets, 551)).toBe(3);
    expect(columnAt(offsets, 552)).toBe(-1);
  });

  it('returns visible columns plus overscan', () => {
    const window = createColWindow();
    visibleColumns(offsets, 0, 300, 52, 0, window);
    expect([window.first, window.last]).toEqual([0, 1]);
    visibleColumns(offsets, 0, 300, 52, 1, window);
    expect([window.first, window.last]).toEqual([0, 2]);
    // Scrolled so column 0 hides under the gutter: content x 162..410 shows columns 1..3.
    visibleColumns(offsets, 110, 300, 52, 0, window);
    expect([window.first, window.last]).toEqual([1, 3]);
    visibleColumns(offsets, 110, 290, 52, 0, window);
    expect([window.first, window.last]).toEqual([1, 2]);
    visibleColumns(offsets, 0, 10_000, 52, 1, window);
    expect([window.first, window.last]).toEqual([0, 3]);
  });
});

describe('hitTest', () => {
  const layout: HitLayout = {
    viewportWidth: 600,
    viewportHeight: 400,
    headerHeight: 32,
    rowHeight: 32,
    gutterWidth: 52,
    rowCount: 100,
    virtualTop: 0,
    scrollLeft: 0,
    offsets: columnOffsets([100, 100, 100], 52),
  };

  it('finds the corner, header, gutter and cells', () => {
    expect(hitTest(layout, 10, 10).area).toBe('corner');
    expect(hitTest(layout, 100, 10)).toMatchObject({ area: 'header', col: 0, resizeCol: -1 });
    expect(hitTest(layout, 10, 40)).toMatchObject({ area: 'gutter', row: 0 });
    expect(hitTest(layout, 160, 32 + 32 * 5 + 1)).toMatchObject({ area: 'cell', row: 5, col: 1 });
    expect(hitTest(layout, 500, 40).area).toBe('outside'); // right of the last column
    expect(hitTest(layout, 700, 40).area).toBe('outside');
  });

  it('detects the resize handle on either side of a header edge', () => {
    expect(hitTest(layout, 150, 10)).toMatchObject({ area: 'header', col: 0, resizeCol: 0 });
    expect(hitTest(layout, 154, 10)).toMatchObject({ area: 'header', col: 1, resizeCol: 0 });
    expect(hitTest(layout, 157, 10).resizeCol).toBe(-1);
    // The last column's right edge is a handle too, even past the content.
    expect(hitTest(layout, 353, 10)).toMatchObject({ area: 'header', resizeCol: 2 });
  });

  it('accounts for scrolling, including the scaled range', () => {
    const scrolled = { ...layout, virtualTop: 1_599_999_000, rowCount: 50_000_000, scrollLeft: 100 };
    const hit = hitTest(scrolled, 100, 33);
    expect(hit.area).toBe('cell');
    expect(hit.row).toBe(Math.floor((1 + 1_599_999_000) / 32));
    expect(hit.col).toBe(1);
  });

  it('ignores rows past the end', () => {
    expect(hitTest({ ...layout, rowCount: 2 }, 100, 32 + 64 + 1).area).toBe('outside');
  });

  it('clamps drag positions into the grid', () => {
    expect(clampedRowAtY(layout, -500)).toBe(0);
    expect(clampedRowAtY(layout, 1e6)).toBe(99);
    expect(clampedColumnAtX(layout.offsets, 0, 52, 0)).toBe(0);
    expect(clampedColumnAtX(layout.offsets, 0, 52, 5_000)).toBe(2);
  });
});

describe('scroll into view', () => {
  it('moves the least needed to show a row', () => {
    // Rows 0..9 fill 320px; row 10 needs one row of scrolling.
    expect(scrollTopForRow(9, 0, 320, 32)).toBe(0);
    expect(scrollTopForRow(10, 0, 320, 32)).toBe(32);
    expect(scrollTopForRow(2, 320, 320, 32)).toBe(64);
    expect(scrollTopForRow(49_999_999, 0, BODY, 32)).toBe(50_000_000 * 32 - BODY);
  });

  it('moves the least needed to show a column right of the gutter', () => {
    const offsets = columnOffsets([100, 100, 100, 100], 52);
    expect(scrollLeftForColumn(offsets, 0, 0, 300, 52)).toBe(0);
    expect(scrollLeftForColumn(offsets, 3, 0, 300, 52)).toBe(452 - 300);
    expect(scrollLeftForColumn(offsets, 0, 200, 300, 52)).toBe(0);
    expect(scrollLeftForColumn(offsets, 2, 200, 300, 52)).toBe(200);
  });

  it('pages by whole rows', () => {
    expect(rowsPerPage(BODY, 32)).toBe(27);
    expect(rowsPerPage(10, 32)).toBe(1);
  });
});

describe('gutter and reorder', () => {
  it('widens the gutter for long row numbers', () => {
    expect(gutterWidthFor(1_000, 6.6, 10, 52)).toBe(52);
    expect(gutterWidthFor(50_000_000, 6.6, 10, 52)).toBe(Math.ceil(8 * 6.6 + 20));
  });

  it('maps a drop position to the target index', () => {
    const offsets = columnOffsets([100, 100, 100, 100], 0);
    // Dragging column 0 right: past the middle of column 2 → index 2.
    expect(reorderTarget(offsets, 0, 260)).toBe(2);
    expect(reorderTarget(offsets, 0, 20)).toBe(0);
    expect(reorderTarget(offsets, 0, 1_000)).toBe(3);
    // Dragging column 3 left to the start.
    expect(reorderTarget(offsets, 3, 10)).toBe(0);
    expect(reorderTarget(offsets, 3, 140)).toBe(1);
  });
});
