import { useCallback, useState } from 'react';
import type { SortKey } from '@glassgrid/core';
import type { GridColumn, GridDataSource, GridSelection } from './types.js';

export interface CanvasGridState {
  columns: readonly GridColumn[];
  selection: GridSelection | null;
  sort: readonly SortKey[];
  onSelectionChange: (selection: GridSelection | null) => void;
  onSortRequest: (column: string) => void;
  onColumnResize: (column: string, width: number) => void;
  onColumnReorder: (from: number, to: number) => void;
}

/** Moves the item at `from` to index `to` (indexes into the list as it ends up). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
  return next;
}

/** Where display index `index` ends up after moving the column at `from` to `to`. */
export function reorderedIndex(index: number, from: number, to: number): number {
  if (index === from) return to;
  if (from < to && index > from && index <= to) return index - 1;
  if (from > to && index >= to && index < from) return index + 1;
  return index;
}

/** A selection's corners after a column move, so it keeps pointing at the same columns' cells. */
export function reorderSelection(selection: GridSelection | null, from: number, to: number): GridSelection | null {
  if (!selection) return null;
  const { anchor, focus } = selection;
  return {
    anchor: { row: anchor.row, col: reorderedIndex(anchor.col, from, to) },
    focus: { row: focus.row, col: reorderedIndex(focus.col, from, to) },
  };
}

/**
 * Local state for a CanvasGrid (gallery, benchmark, tests): selection,
 * sort (asc → desc → none on header click), resize and reorder. The app
 * routes the same callbacks through its command registry instead.
 */
export function useCanvasGridState(source: GridDataSource): CanvasGridState {
  const [state, setState] = useState(() => ({ source, columns: source.columns }));
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const [sort, setSort] = useState<readonly SortKey[]>([]);
  let columns = state.columns;
  if (state.source !== source) {
    columns = source.columns;
    setState({ source, columns });
  }
  const onSortRequest = useCallback((column: string) => {
    setSort((current) => {
      const key = current.find((candidate) => candidate.column === column);
      if (!key) return [{ column, direction: 'asc' }];
      if (key.direction === 'asc') return [{ column, direction: 'desc' }];
      return [];
    });
  }, []);
  const onColumnResize = useCallback((column: string, width: number) => {
    setState((current) => ({ ...current, columns: current.columns.map((c) => (c.name === column ? { ...c, width } : c)) }));
  }, []);
  const onColumnReorder = useCallback((from: number, to: number) => {
    setState((current) => ({ ...current, columns: moveItem(current.columns, from, to) }));
    setSelection((current) => reorderSelection(current, from, to));
  }, []);
  return { columns, selection, sort, onSelectionChange: setSelection, onSortRequest, onColumnResize, onColumnReorder };
}
