import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SortKey } from '@glassgrid/core';
import { tokensFor } from '../tokens.js';
import { CanvasGrid, type CanvasGridHandle, type CanvasGridProps } from './CanvasGrid.js';
import type { GridCell, GridColumn, GridDataSource, GridSelection, GridSourceListener } from './types.js';

// ---------------------------------------------------------------------------
// A recording 2D context: every call and style assignment, in order.

type Call = [string, ...unknown[]];

class RecordingContext {
  calls: Call[] = [];
  private state = { fillStyle: '#000', font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', globalAlpha: 1, fontKerning: 'auto' };
  readonly canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }
  get fillStyle() {
    return this.state.fillStyle;
  }
  set fillStyle(value: string) {
    this.state.fillStyle = value;
    this.calls.push(['fillStyle', value]);
  }
  get font() {
    return this.state.font;
  }
  set font(value: string) {
    this.state.font = value;
    this.calls.push(['font', value]);
  }
  get textAlign() {
    return this.state.textAlign;
  }
  set textAlign(value: string) {
    this.state.textAlign = value;
    this.calls.push(['textAlign', value]);
  }
  get textBaseline() {
    return this.state.textBaseline;
  }
  set textBaseline(value: string) {
    this.state.textBaseline = value;
  }
  get globalAlpha() {
    return this.state.globalAlpha;
  }
  set globalAlpha(value: number) {
    this.state.globalAlpha = value;
  }
  get fontKerning() {
    return this.state.fontKerning;
  }
  set fontKerning(value: string) {
    this.state.fontKerning = value;
  }
  fillRect(...args: number[]) {
    this.calls.push(['fillRect', ...args, this.state.fillStyle]);
  }
  fillText(text: string, x: number, y: number) {
    this.calls.push(['fillText', text, x, y, this.state.fillStyle, this.state.font, this.state.textAlign]);
  }
  measureText(text: string) {
    return { width: text.length * 7 };
  }
  setTransform(...args: number[]) {
    this.calls.push(['setTransform', ...args]);
  }
  save() {
    this.calls.push(['save']);
  }
  restore() {
    this.calls.push(['restore']);
  }
  beginPath() {}
  rect() {}
  clip() {}
  reset() {
    this.calls = [];
  }
  texts(): string[] {
    return this.calls.filter((c) => c[0] === 'fillText').map((c) => c[1] as string);
  }
  textCall(text: string): Call | undefined {
    return this.calls.find((c) => c[0] === 'fillText' && c[1] === text);
  }
}

const contexts = new Map<HTMLCanvasElement, RecordingContext>();
let frames: FrameRequestCallback[] = [];

/** Runs queued animation frames (paints). */
function flushFrames() {
  act(() => {
    for (let i = 0; i < 5 && frames.length > 0; i += 1) {
      const queued = frames;
      frames = [];
      for (const callback of queued) callback(performance.now());
    }
  });
}

beforeEach(() => {
  contexts.clear();
  frames = [];
  const getContext = function (this: HTMLCanvasElement) {
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = new RecordingContext(this);
      contexts.set(this, ctx);
    }
    return ctx;
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(getContext as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  // jsdom does no layout: give the scroller a 600×400 viewport.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('gg-cgrid__scroller') ? 600 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('gg-cgrid__scroller') ? 400 : 0;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const attr = (element: Element | null | undefined, name: string) => element?.getAttribute(name) ?? null;
const text = (element: Element | null | undefined) => element?.textContent ?? '';

// ---------------------------------------------------------------------------
// An in-memory source.

class StaticSource implements GridDataSource {
  readonly columns: readonly GridColumn[];
  rowCount: number;
  readonly rows: (GridCell | undefined)[][];
  readonly listeners = new Set<GridSourceListener>();
  readonly ensured: [number, number][] = [];
  loaded = true;
  constructor(columns: readonly GridColumn[], rows: (GridCell | undefined)[][], rowCount = rows.length) {
    this.columns = columns;
    this.rows = rows;
    this.rowCount = rowCount;
  }
  getCell(row: number, col: number) {
    if (!this.loaded) return undefined;
    const values = this.rows[row];
    return values ? values[col] : `r${row}c${col}`;
  }
  ensureRange(first: number, last: number) {
    this.ensured.push([first, last]);
  }
  loadRange() {
    this.loaded = true;
    return Promise.resolve();
  }
  subscribe(listener: GridSourceListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const columns: GridColumn[] = [
  { name: 'id', type: 'integer', width: 100 },
  { name: 'category', type: 'text', width: 120 },
  { name: 'created_on', type: 'date', width: 120 },
];

function makeSource(rowCount = 3) {
  return new StaticSource(
    columns,
    [
      ['1', 'alpha', '2026-01-01'],
      ['2', null, '2026-02-02'],
      ['3', 'a "quoted"\tvalue', '2026-03-03'],
    ],
    rowCount,
  );
}

interface HarnessProps extends Partial<CanvasGridProps> {
  source: GridDataSource;
  initialSelection?: GridSelection | null;
  initialSort?: SortKey[];
}

function Harness({ source, initialSelection = null, initialSort = [], ...rest }: HarnessProps) {
  const [selection, setSelection] = useState<GridSelection | null>(initialSelection);
  return (
    <CanvasGrid
      source={source}
      tokens={tokensFor('dark')}
      selection={selection}
      onSelectionChange={setSelection}
      sort={initialSort}
      label="Rows"
      testId="grid"
      {...rest}
    />
  );
}

function setup(props: Partial<HarnessProps> = {}) {
  const source = props.source ?? makeSource();
  const callbacks = {
    onSortRequest: vi.fn(),
    onColumnResize: vi.fn(),
    onColumnReorder: vi.fn(),
    onCopy: vi.fn(),
    onFirstRowsPainted: vi.fn(),
  };
  const utils = render(<Harness source={source} {...callbacks} {...props} />);
  flushFrames();
  const canvas = screen.getByTestId<HTMLCanvasElement>('grid-canvas');
  const ctx = contexts.get(canvas) as RecordingContext;
  const scroller = screen.getByTestId('grid-scroller');
  const mirror = screen.getByRole('grid', { name: 'Rows' });
  return { ...utils, source, ctx, canvas, scroller, mirror, ...callbacks };
}

/** Lets the throttled mirror window update. */
function settleMirror() {
  act(() => {
    vi.advanceTimersByTime(200);
  });
  flushFrames();
}

describe('CanvasGrid painting', () => {
  it('draws the header, row numbers, values and nulls of a small grid', () => {
    const { ctx, canvas } = setup();
    const dark = tokensFor('dark');
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(400);
    expect(ctx.calls[0]).toEqual(['setTransform', 1, 0, 0, 1, 0, 0]);
    // Background first, in the grid colour.
    expect(ctx.calls.find((c) => c[0] === 'fillRect')).toEqual(['fillRect', 0, 0, 600, 400, dark.color.gridBg]);
    expect(ctx.texts()).toEqual(
      expect.arrayContaining(['id', 'category', 'created_on', '1', '2', '3', 'alpha', 'null', '2026-01-01']),
    );
    // Numbers right-aligned in Plex Mono, text left-aligned in Plex Sans, null muted italic.
    const number = ctx.textCall('2') as Call;
    expect(number[6]).toBe('right');
    expect(number[5]).toContain('IBM Plex Mono');
    expect(number[4]).toBe(dark.color.textPrimary);
    const text = ctx.textCall('alpha') as Call;
    expect(text[6]).toBe('left');
    expect(text[5]).toContain('IBM Plex Sans');
    const nullCall = ctx.textCall('null') as Call;
    expect(nullCall[5]).toMatch(/^italic/);
    expect(nullCall[4]).toBe(dark.grid.null);
    // Header row on top: text drawn in the header band.
    const header = ctx.textCall('category') as Call;
    expect(header[3]).toBe(16);
    expect(header[4]).toBe(dark.color.textSecondary);
  });

  it('truncates long text with an ellipsis to the column width', () => {
    const source = makeSource();
    source.rows[0] = ['1', 'a value that is far too long for a narrow column', '2026-01-01'];
    const { ctx } = setup({ source });
    const fitted = ctx.texts().find((t) => t.startsWith('a value'));
    expect(fitted).toMatch(/…$/);
    // 120px column − 2×10px padding at 7px per character (ellipsis included).
    expect((fitted ?? '').length * 7).toBeLessThanOrEqual(100);
  });

  it('draws placeholder bars for rows that are not loaded and asks the source for them', () => {
    const source = makeSource(500);
    source.loaded = false;
    const { ctx } = setup({ source });
    const skeleton = tokensFor('dark').chart.skeleton;
    const bars = ctx.calls.filter((c) => c[0] === 'fillRect' && c[5] === skeleton && c[4] === 10);
    // 12 visible rows + 1 overscan, 3 columns.
    expect(bars.length).toBe(13 * 3);
    expect(source.ensured[0]).toEqual([0, 12]);
  });

  it('repaints only when something changed, and with the other theme on switch', () => {
    const source = makeSource();
    const { ctx, rerender } = setup({ source });
    ctx.reset();
    flushFrames();
    expect(ctx.calls).toEqual([]);
    rerender(<Harness source={source} tokens={tokensFor('light')} />);
    flushFrames();
    expect(ctx.calls.find((c) => c[0] === 'fillRect')).toEqual(['fillRect', 0, 0, 600, 400, tokensFor('light').color.gridBg]);
  });

  it('repaints when a page arrives for the visible rows', () => {
    const source = makeSource(100);
    source.loaded = false;
    const { ctx } = setup({ source });
    expect(ctx.texts()).not.toContain('alpha');
    source.loaded = true;
    ctx.reset();
    act(() => {
      for (const listener of source.listeners) listener({ kind: 'rows', firstRow: 0, lastRow: 99 });
    });
    flushFrames();
    expect(ctx.texts()).toContain('alpha');
  });

  it('reports the first frame with rows once', () => {
    const source = makeSource(100);
    source.loaded = false;
    const { onFirstRowsPainted, ctx } = setup({ source });
    expect(onFirstRowsPainted).not.toHaveBeenCalled();
    source.loaded = true;
    act(() => {
      for (const listener of source.listeners) listener({ kind: 'rows', firstRow: 0, lastRow: 99 });
    });
    flushFrames();
    ctx.reset();
    act(() => {
      for (const listener of source.listeners) listener({ kind: 'rows', firstRow: 0, lastRow: 99 });
    });
    flushFrames();
    expect(onFirstRowsPainted).toHaveBeenCalledTimes(1);
  });

  it('draws the sort arrow and the selection', () => {
    const selection = { anchor: { row: 0, col: 0 }, focus: { row: 1, col: 1 } };
    const { ctx } = setup({ initialSort: [{ column: 'id', direction: 'desc' }], initialSelection: selection });
    const dark = tokensFor('dark');
    expect(ctx.textCall('↓')?.[4]).toBe(dark.color.accentText);
    expect(ctx.calls.some((c) => c[0] === 'fillRect' && c[5] === dark.grid.selFill)).toBe(true);
    expect(ctx.calls.some((c) => c[0] === 'fillRect' && c[5] === dark.color.focus)).toBe(true);
    // Selected rows' numbers in the accent colour.
    expect(ctx.textCall('1')).toBeDefined();
    const rowNumbers = ctx.calls.filter((c) => c[0] === 'fillText' && (c[1] === '1' || c[1] === '2') && c[6] === 'right' && (c[2] as number) < 60);
    expect(rowNumbers.every((c) => c[4] === dark.color.accentText)).toBe(true);
  });
});

describe('CanvasGrid accessibility mirror', () => {
  it('mirrors the visible window with ARIA grid attributes', () => {
    vi.useFakeTimers();
    try {
      const { mirror } = setup({ source: makeSource(1_000), initialSort: [{ column: 'id', direction: 'asc' }] });
      settleMirror();
      expect(attr(mirror, 'aria-rowcount')).toBe('1001');
      expect(attr(mirror, 'aria-colcount')).toBe('4');
      expect(attr(mirror, 'aria-multiselectable')).toBe('true');
      const rows = within(mirror).getAllByRole('row');
      expect(attr(rows[0], 'aria-rowindex')).toBe('1');
      expect(attr(rows[1], 'aria-rowindex')).toBe('2');
      // 400px − 32px header = 11.5 rows → rows 0..11 visible, plus the header.
      expect(rows).toHaveLength(13);
      const header = within(mirror).getByRole('columnheader', { name: /^id/ });
      expect(attr(header, 'aria-sort')).toBe('ascending');
      expect(attr(header, 'aria-colindex')).toBe('2');
      expect(text(header)).toBe('id, sorted ascending');
      const cells = within(rows[2] as HTMLElement).getAllByRole('gridcell');
      expect(cells.map((c) => c.getAttribute('aria-colindex'))).toEqual(['2', '3', '4']);
      expect(text(cells[1])).toBe('null (empty value)');
      expect(text(within(rows[2] as HTMLElement).getByRole('rowheader'))).toBe('2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('has one tab stop and selects the cell it lands on', () => {
    const { mirror } = setup();
    const tabbable = mirror.querySelectorAll('[tabindex="0"]');
    expect(tabbable).toHaveLength(1);
    act(() => {
      (tabbable[0] as HTMLElement).focus();
    });
    flushFrames();
    expect(attr(within(mirror).getAllByRole('gridcell')[0], 'aria-selected')).toBe('true');
  });
});

describe('CanvasGrid keyboard', () => {
  function focusGrid(mirror: HTMLElement) {
    act(() => {
      (mirror.querySelector('[tabindex="0"]') as HTMLElement).focus();
    });
    flushFrames();
  }
  const selected = (mirror: HTMLElement) =>
    within(mirror)
      .getAllByRole('gridcell')
      .filter((cell) => cell.getAttribute('aria-selected') === 'true')
      .map((cell) => `${cell.dataset['row']}:${cell.dataset['col']}`);

  it('moves and extends with arrows, and focus follows', () => {
    const { mirror } = setup({ source: makeSource(1_000) });
    focusGrid(mirror);
    expect(selected(mirror)).toEqual(['0:0']);
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(selected(mirror)).toEqual(['1:1']);
    expect(attr(document.activeElement, 'data-row')).toBe('1');
    expect(attr(document.activeElement, 'data-col')).toBe('1');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight', shiftKey: true });
    expect(selected(mirror)).toEqual(['1:1', '1:2', '2:1', '2:2']);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(selected(mirror)).toEqual(['2:2']);
  });

  it('pages and jumps to the ends, scrolling the focused row into view', () => {
    const { mirror, ctx } = setup({ source: makeSource(1_000) });
    focusGrid(mirror);
    fireEvent.keyDown(document.activeElement as Element, { key: 'PageDown' });
    // 368px body / 32px = 11 rows per page.
    expect(attr(document.activeElement, 'data-row')).toBe('11');
    fireEvent.keyDown(document.activeElement as Element, { key: 'End', ctrlKey: true });
    expect(attr(document.activeElement, 'data-row')).toBe('999');
    expect(attr(document.activeElement, 'data-col')).toBe('2');
    ctx.reset();
    flushFrames();
    expect(ctx.texts()).toContain('1000');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home', metaKey: true });
    expect(attr(document.activeElement, 'data-row')).toBe('0');
    expect(attr(document.activeElement, 'data-col')).toBe('0');
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(attr(document.activeElement, 'data-col')).toBe('2');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(attr(document.activeElement, 'data-col')).toBe('0');
  });

  it('moves into the header with ArrowUp and sorts with Enter', () => {
    const { mirror, onSortRequest, onColumnReorder, onColumnResize } = setup();
    focusGrid(mirror);
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    expect(attr(document.activeElement, 'role')).toBe('columnheader');
    expect(text(document.activeElement)).toBe('category');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' });
    expect(onSortRequest).toHaveBeenCalledWith('category');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight', altKey: true });
    expect(onColumnReorder).toHaveBeenCalledWith(1, 2);
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft', altKey: true, shiftKey: true });
    expect(onColumnResize).toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(attr(document.activeElement, 'role')).toBe('gridcell');
  });

  it('copies the selection as TSV through onCopy', async () => {
    const { mirror, onCopy } = setup({ initialSelection: { anchor: { row: 0, col: 1 }, focus: { row: 2, col: 2 } } });
    focusGrid(mirror);
    await act(async () => {
      fireEvent.keyDown(document.activeElement as Element, { key: 'c', ctrlKey: true });
      await Promise.resolve();
    });
    expect(onCopy).toHaveBeenCalledTimes(1);
    const [tsv, info] = onCopy.mock.calls[0] as [string, { rows: number; truncated: boolean; message: string }];
    expect(tsv).toBe('alpha\t2026-01-01\n\t2026-02-02\n"a ""quoted""\tvalue"\t2026-03-03');
    expect(info).toMatchObject({ rows: 3, truncated: false });
    expect(text(screen.getByRole('status'))).toBe('Copied 3 rows × 2 columns.');
  });

  it('caps large copies and says so', async () => {
    const { mirror, onCopy } = setup({
      source: makeSource(50_000),
      initialSelection: { anchor: { row: 0, col: 0 }, focus: { row: 49_999, col: 0 } },
      copyLimits: { maxRows: 100 },
    });
    focusGrid(mirror);
    await act(async () => {
      fireEvent.keyDown(document.activeElement as Element, { key: 'c', metaKey: true });
      await Promise.resolve();
    });
    const [tsv, info] = onCopy.mock.calls[0] as [string, { rows: number; truncated: boolean; message: string }];
    expect(tsv.split('\n')).toHaveLength(100);
    expect(info.truncated).toBe(true);
    expect(info.message).toBe('Copied the first 100 rows of 50,000 selected (copy is limited to 100 rows or 250,000 cells).');
  });

  it('selects everything with Cmd/Ctrl+A', () => {
    const { mirror } = setup();
    focusGrid(mirror);
    fireEvent.keyDown(document.activeElement as Element, { key: 'a', ctrlKey: true });
    expect(selected(mirror)).toHaveLength(9);
  });
});

describe('CanvasGrid pointer', () => {
  // Gutter is 52px wide; columns start at x = 52, 152, 272; rows at y = 32 + 32·row.
  it('selects on click, extends on shift-click and drag', () => {
    const { scroller, mirror } = setup();
    fireEvent.pointerDown(scroller, { button: 0, clientX: 160, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(scroller, { button: 0, clientX: 160, clientY: 40, pointerId: 1 });
    flushFrames();
    expect(attr(document.activeElement, 'data-row')).toBe('0');
    expect(attr(document.activeElement, 'data-col')).toBe('1');
    fireEvent.pointerDown(scroller, { button: 0, clientX: 300, clientY: 100, pointerId: 1, shiftKey: true });
    fireEvent.pointerUp(scroller, { button: 0, clientX: 300, clientY: 100, pointerId: 1 });
    const selectedCells = () => within(mirror).getAllByRole('gridcell').filter((c) => c.getAttribute('aria-selected') === 'true').length;
    expect(selectedCells()).toBe(6);
    fireEvent.pointerDown(scroller, { button: 0, clientX: 60, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(scroller, { clientX: 160, clientY: 72, pointerId: 1 });
    fireEvent.pointerUp(scroller, { clientX: 160, clientY: 72, pointerId: 1 });
    expect(selectedCells()).toBe(4);
  });

  it('selects whole rows from the gutter', () => {
    const { scroller, mirror } = setup();
    fireEvent.pointerDown(scroller, { button: 0, clientX: 20, clientY: 72, pointerId: 1 });
    fireEvent.pointerUp(scroller, { button: 0, clientX: 20, clientY: 72, pointerId: 1 });
    const row = within(mirror).getAllByRole('row')[2] as HTMLElement;
    expect(within(row).getAllByRole('gridcell').every((c) => c.getAttribute('aria-selected') === 'true')).toBe(true);
  });

  it('requests a sort on header click', () => {
    const { scroller, onSortRequest } = setup();
    fireEvent.pointerDown(scroller, { button: 0, clientX: 200, clientY: 16, pointerId: 1 });
    fireEvent.pointerUp(scroller, { button: 0, clientX: 200, clientY: 16, pointerId: 1 });
    expect(onSortRequest).toHaveBeenCalledWith('category');
  });

  it('resizes a column by dragging its header edge', () => {
    const { scroller, ctx, onColumnResize, onSortRequest } = setup();
    fireEvent.pointerMove(scroller, { clientX: 151, clientY: 16, pointerId: 1 });
    expect(scroller.style.cursor).toBe('col-resize');
    fireEvent.pointerDown(scroller, { button: 0, clientX: 151, clientY: 16, pointerId: 1 });
    fireEvent.pointerMove(scroller, { clientX: 191, clientY: 16, pointerId: 1 });
    ctx.reset();
    flushFrames();
    // Live preview: the resize guide in the accent colour, full height.
    expect(ctx.calls).toContainEqual(['fillRect', 191, 0, 2, 400, tokensFor('dark').color.accent]);
    fireEvent.pointerUp(scroller, { clientX: 191, clientY: 16, pointerId: 1 });
    expect(onColumnResize).toHaveBeenCalledWith('id', 140);
    expect(onSortRequest).not.toHaveBeenCalled();
  });

  it('reorders a column by dragging its header', () => {
    const { scroller, ctx, onColumnReorder, onSortRequest } = setup();
    fireEvent.pointerDown(scroller, { button: 0, clientX: 80, clientY: 16, pointerId: 1 });
    fireEvent.pointerMove(scroller, { clientX: 250, clientY: 16, pointerId: 1 });
    ctx.reset();
    flushFrames();
    // The ghost header follows the pointer.
    expect(ctx.texts()).toContain('id');
    fireEvent.pointerMove(scroller, { clientX: 340, clientY: 16, pointerId: 1 });
    fireEvent.pointerUp(scroller, { clientX: 340, clientY: 16, pointerId: 1 });
    expect(onColumnReorder).toHaveBeenCalledWith(0, 2);
    expect(onSortRequest).not.toHaveBeenCalled();
  });

  it('cancels a reorder with Escape', () => {
    const { scroller, mirror, onColumnReorder } = setup();
    act(() => {
      (mirror.querySelector('[tabindex="0"]') as HTMLElement).focus();
    });
    fireEvent.pointerDown(scroller, { button: 0, clientX: 80, clientY: 16, pointerId: 1 });
    fireEvent.pointerMove(scroller, { clientX: 250, clientY: 16, pointerId: 1 });
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    fireEvent.pointerUp(scroller, { clientX: 250, clientY: 16, pointerId: 1 });
    expect(onColumnReorder).not.toHaveBeenCalled();
  });
});

describe('CanvasGrid scrolling', () => {
  it('scales the spacer past the limit and reaches the last row', () => {
    const source = makeSource(50_000_000);
    const handle: { current: CanvasGridHandle | null } = { current: null };
    const { ctx, scroller } = setup({ source, handleRef: handle });
    const spacer = scroller.firstElementChild as HTMLElement;
    expect(spacer.style.height).toBe(`${32 + 16_000_000}px`);
    const controller = handle.current?.controller;
    expect(controller?.scrollMapping.scaled).toBe(true);
    // Native scroll to the bottom of the spacer maps onto the last row.
    act(() => {
      scroller.scrollTop = 16_000_000 - 368;
      fireEvent.scroll(scroller);
    });
    ctx.reset();
    flushFrames();
    expect(ctx.texts()).toContain('50000000');
    // Wheel deltas apply 1:1 in virtual pixels in the scaled range.
    const before = controller?.virtualTop ?? 0;
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -64, cancelable: true, bubbles: true }));
    });
    expect(controller?.virtualTop).toBe(before - 64);
  });

  it('scrolls back to the top when the source resets', () => {
    const source = makeSource(10_000);
    const onSelectionChange = vi.fn();
    const handle: { current: CanvasGridHandle | null } = { current: null };
    setup({ source, handleRef: handle, onSelectionChange, initialSelection: { anchor: { row: 5, col: 0 }, focus: { row: 5, col: 0 } } });
    act(() => handle.current?.scrollToRow(5_000));
    expect(handle.current?.controller?.virtualTop).toBe(160_000);
    act(() => {
      for (const listener of source.listeners) listener({ kind: 'reset' });
    });
    expect(handle.current?.controller?.virtualTop).toBe(0);
    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });
});
