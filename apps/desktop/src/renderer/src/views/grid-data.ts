import { useCallback, useEffect, useState } from 'react';
import { MAX_ROWS_PAGE, type Filter, type SortKey, type TableId } from '@glassgrid/core';
import type { Table } from 'apache-arrow';
import { formatterFor, valueKind } from '@glassgrid/ui';
import { isAbandoned, type EngineClient, type RowsResult } from '../engine-client';
import type { GridCellValue } from '../types';

function pageRows(table: Table, columns: readonly string[]): GridCellValue[][] {
  const vectors = columns.map((name) => {
    const index = table.schema.fields.findIndex((field) => field.name === name);
    return index < 0 ? null : { vector: table.getChildAt(index), format: formatterFor(valueKind(table.schema.fields[index])) };
  });
  const rows: GridCellValue[][] = [];
  for (let r = 0; r < table.numRows; r += 1) rows.push(vectors.map((column) => (column?.vector ? column.format(column.vector.get(r)) : null)));
  return rows;
}

export const PAGE_ROWS = MAX_ROWS_PAGE;
/** Pages kept per view (about 50K rows), least recently used first out. */
export const MAX_CACHED_PAGES = 50;

/** Grid pages of one view (table + sort + filters). Mutable; owned by `useGridRows`. */
export class PageCache {
  key = '';
  private readonly pages = new Map<number, GridCellValue[][]>();
  private readonly pending = new Set<number>();

  reset(key: string): void {
    this.key = key;
    this.pages.clear();
    this.pending.clear();
  }

  row(index: number): GridCellValue[] | undefined {
    const page = Math.floor(index / PAGE_ROWS);
    const rows = this.pages.get(page);
    if (!rows) return undefined;
    // Touch for LRU order.
    this.pages.delete(page);
    this.pages.set(page, rows);
    return rows[index - page * PAGE_ROWS];
  }

  needs(page: number): boolean {
    return !this.pages.has(page) && !this.pending.has(page);
  }

  begin(page: number): void {
    this.pending.add(page);
  }

  fail(page: number): void {
    this.pending.delete(page);
  }

  put(page: number, rows: GridCellValue[][]): void {
    this.pending.delete(page);
    this.pages.set(page, rows);
    while (this.pages.size > MAX_CACHED_PAGES) {
      const oldest = this.pages.keys().next().value;
      if (oldest === undefined) break;
      this.pages.delete(oldest);
    }
  }
}

export interface UseGridRowsOptions {
  engine: Pick<EngineClient, 'rows'>;
  tableId: TableId | null;
  /** Column names in display order. */
  columns: readonly string[];
  sort: readonly SortKey[];
  filters: readonly Filter[];
  /** Every page that arrives (page 0 drives the open-to-first-page measure). */
  onPage?: (page: number, result: RowsResult, viewKey: string) => void;
  onError?: (error: unknown) => void;
}

/**
 * Pages the grid's rows from the engine (`rows()`, 1,000 rows per page) for
 * the visible window. A new sort or filter set is a new view: the cache
 * resets and late pages of the old view are dropped.
 */
export function useGridRows({ engine, tableId, columns, sort, filters, onPage, onError }: UseGridRowsOptions) {
  const viewKey = tableId === null ? '' : JSON.stringify([tableId, sort, filters]);
  const [cache] = useState(() => new PageCache());
  const [, setVersion] = useState(0);
  if (cache.key !== viewKey) cache.reset(viewKey);

  const requestRange = useCallback(
    (first: number, last: number) => {
      if (tableId === null) return;
      const key = viewKey;
      for (let page = Math.floor(first / PAGE_ROWS); page <= Math.floor(last / PAGE_ROWS); page += 1) {
        if (!cache.needs(page)) continue;
        cache.begin(page);
        engine
          .rows(
            tableId,
            { offset: page * PAGE_ROWS, limit: PAGE_ROWS, sort: [...sort] },
            // Page 0 is "the grid" view, so a new view supersedes its predecessor's first page.
            { viewId: page === 0 ? 'grid' : `grid:page:${page}`, filters },
          )
          .then(
            (result) => {
              if (cache.key !== key) return;
              cache.put(page, pageRows(result.table, columns));
              onPage?.(page, result, key);
              setVersion((v) => v + 1);
            },
            (error: unknown) => {
              if (cache.key === key) cache.fail(page);
              if (!isAbandoned(error)) onError?.(error);
            },
          );
      }
    },
    [engine, tableId, viewKey, sort, filters, columns, cache, onPage, onError],
  );

  // Start the first page as soon as the view exists, before the grid measures itself.
  useEffect(() => {
    requestRange(0, 0);
  }, [requestRange]);

  const getRow = useCallback((index: number) => cache.row(index), [cache]);
  return { getRow, requestRange, viewKey };
}
