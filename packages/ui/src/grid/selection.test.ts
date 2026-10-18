import { describe, expect, it } from 'vitest';
import {
  cellSelection,
  clampSelection,
  copyRowCount,
  keyToMove,
  MAX_COPY_ROWS,
  moveSelection,
  normalizeSelection,
  rangeToTsv,
  sameSelection,
  selectionContains,
  tsvField,
  type KeyLike,
  type MoveContext,
} from './selection.js';
import type { GridCell } from './types.js';
import { moveItem, reorderedIndex, reorderSelection } from './useCanvasGridState.js';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe('selection normalization', () => {
  it('turns anchor/focus into a rectangle whichever way it was dragged', () => {
    expect(normalizeSelection(null)).toBeNull();
    expect(normalizeSelection({ anchor: { row: 9, col: 3 }, focus: { row: 2, col: 1 } })).toEqual({ top: 2, bottom: 9, left: 1, right: 3 });
    expect(normalizeSelection(cellSelection(4, 2))).toEqual({ top: 4, bottom: 4, left: 2, right: 2 });
  });

  it('clamps into the grid and drops selections of an empty grid', () => {
    const selection = { anchor: { row: 50, col: 1 }, focus: { row: 80, col: 9 } };
    expect(clampSelection(selection, 60, 4)).toEqual({ anchor: { row: 50, col: 1 }, focus: { row: 59, col: 3 } });
    expect(clampSelection(selection, 0, 4)).toBeNull();
    const inside = cellSelection(1, 1);
    expect(clampSelection(inside, 10, 10)).toBe(inside);
  });

  it('compares and tests membership', () => {
    expect(sameSelection(cellSelection(1, 2), cellSelection(1, 2))).toBe(true);
    expect(sameSelection(cellSelection(1, 2), null)).toBe(false);
    const range = normalizeSelection({ anchor: { row: 1, col: 1 }, focus: { row: 3, col: 2 } });
    expect(selectionContains(range, 2, 2)).toBe(true);
    expect(selectionContains(range, 4, 2)).toBe(false);
  });
});

describe('keyboard moves', () => {
  it('maps keys to moves', () => {
    expect(keyToMove(key('ArrowDown'))).toEqual({ move: 'down', extend: false });
    expect(keyToMove(key('ArrowDown', { shiftKey: true }))).toEqual({ move: 'down', extend: true });
    expect(keyToMove(key('ArrowDown', { metaKey: true }))?.move).toBe('bottom');
    expect(keyToMove(key('ArrowLeft', { ctrlKey: true }))?.move).toBe('firstColumn');
    expect(keyToMove(key('Home'))?.move).toBe('rowStart');
    expect(keyToMove(key('End', { ctrlKey: true }))?.move).toBe('gridEnd');
    expect(keyToMove(key('Home', { metaKey: true, shiftKey: true }))).toEqual({ move: 'gridStart', extend: true });
    expect(keyToMove(key('PageDown'))?.move).toBe('pageDown');
    expect(keyToMove(key('a'))).toBeNull();
    expect(keyToMove(key('ArrowDown', { altKey: true }))).toBeNull();
  });

  const context: MoveContext = { rowCount: 50_000_000, colCount: 12, pageRows: 27, fallback: { row: 100, col: 0 } };

  it('starts at the fallback cell without moving', () => {
    expect(moveSelection(null, 'down', false, context)).toEqual(cellSelection(100, 0));
  });

  it('moves, pages and jumps, clamped to the grid', () => {
    const at = cellSelection(10, 5);
    expect(moveSelection(at, 'down', false, context)).toEqual(cellSelection(11, 5));
    expect(moveSelection(at, 'up', false, context)).toEqual(cellSelection(9, 5));
    expect(moveSelection(at, 'left', false, context)).toEqual(cellSelection(10, 4));
    expect(moveSelection(at, 'right', false, context)).toEqual(cellSelection(10, 6));
    expect(moveSelection(at, 'pageDown', false, context)).toEqual(cellSelection(37, 5));
    expect(moveSelection(at, 'pageUp', false, context)).toEqual(cellSelection(0, 5));
    expect(moveSelection(at, 'rowStart', false, context)).toEqual(cellSelection(10, 0));
    expect(moveSelection(at, 'rowEnd', false, context)).toEqual(cellSelection(10, 11));
    expect(moveSelection(at, 'gridStart', false, context)).toEqual(cellSelection(0, 0));
    expect(moveSelection(at, 'gridEnd', false, context)).toEqual(cellSelection(49_999_999, 11));
    expect(moveSelection(at, 'bottom', false, context)).toEqual(cellSelection(49_999_999, 5));
    expect(moveSelection(cellSelection(0, 0), 'up', false, context)).toEqual(cellSelection(0, 0));
    expect(moveSelection(cellSelection(0, 11), 'right', false, context)).toEqual(cellSelection(0, 11));
  });

  it('extends from the anchor with shift', () => {
    const start = cellSelection(10, 5);
    const once = moveSelection(start, 'down', true, context);
    const twice = moveSelection(once, 'right', true, context);
    expect(twice).toEqual({ anchor: { row: 10, col: 5 }, focus: { row: 11, col: 6 } });
    // A plain move collapses the range at the new focus.
    expect(moveSelection(twice, 'down', false, context)).toEqual(cellSelection(12, 6));
  });

  it('does nothing on an empty grid', () => {
    expect(moveSelection(null, 'down', false, { ...context, rowCount: 0 })).toBeNull();
  });
});

describe('TSV', () => {
  it('quotes fields with tabs, newlines, carriage returns and quotes', () => {
    expect(tsvField('plain')).toBe('plain');
    expect(tsvField('a\tb')).toBe('"a\tb"');
    expect(tsvField('line 1\nline 2')).toBe('"line 1\nline 2"');
    expect(tsvField('cr\r')).toBe('"cr\r"');
    expect(tsvField('say "hi"')).toBe('"say ""hi"""');
    expect(tsvField('it\'s')).toBe("it's");
    expect(tsvField(null)).toBe('');
    expect(tsvField(undefined)).toBe('');
    expect(tsvField('')).toBe('');
  });

  it('copies a range row by row', () => {
    const data: GridCell[][] = [
      ['1', 'alpha', null],
      ['2', 'tab\there', '"quoted"'],
      ['3', 'two\nlines', 'x'],
    ];
    const result = rangeToTsv({ top: 0, bottom: 2, left: 1, right: 2 }, (r, c) => data[r]?.[c]);
    expect(result.text).toBe('alpha\t\n"tab\there"\t"""quoted"""\n"two\nlines"\tx');
    expect(result).toMatchObject({ rows: 3, columns: 2, selectedRows: 3, truncated: false });
  });

  it('stops at the row and cell limits and says so', () => {
    const range = { top: 0, bottom: 49_999_999, left: 0, right: 0 };
    expect(copyRowCount(range)).toBe(MAX_COPY_ROWS);
    const result = rangeToTsv(range, (r) => String(r), { maxRows: 5 });
    expect(result.text.split('\n')).toEqual(['0', '1', '2', '3', '4']);
    expect(result).toMatchObject({ rows: 5, selectedRows: 50_000_000, truncated: true });
    // 12 columns × at most 30 cells → 2 rows.
    const wide = rangeToTsv({ top: 0, bottom: 9, left: 0, right: 11 }, () => 'v', { maxCells: 30 });
    expect(wide.rows).toBe(2);
    expect(wide.truncated).toBe(true);
  });
});

describe('column reorder helpers', () => {
  it('moves items and remaps indexes and selections', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect([0, 1, 2, 3].map((i) => reorderedIndex(i, 0, 2))).toEqual([2, 0, 1, 3]);
    expect([0, 1, 2, 3].map((i) => reorderedIndex(i, 3, 1))).toEqual([0, 2, 3, 1]);
    expect(reorderSelection({ anchor: { row: 1, col: 0 }, focus: { row: 4, col: 3 } }, 0, 3)).toEqual({
      anchor: { row: 1, col: 3 },
      focus: { row: 4, col: 2 },
    });
    expect(reorderSelection(null, 0, 1)).toBeNull();
  });
});
