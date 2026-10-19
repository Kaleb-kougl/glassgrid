import { DataType, type Table } from 'apache-arrow';
import type { ColumnType } from '@glassgrid/core';
import { alignDecimals, formatterFor, kindForType, valueKind } from './format.js';
import { PagedGridSource, type PageColumns, type PagedSourceOptions } from './PagedGridSource.js';
import type { GridCell } from './types.js';

/**
 * Fetches rows `offset..offset+limit-1` of the current view as an Arrow
 * table. Must stop work (or at least settle) when `signal` aborts; the
 * source ignores whatever arrives after that.
 */
export type FetchArrowPage = (offset: number, limit: number, signal: AbortSignal) => Promise<Table>;

export interface ArrowPagedSourceOptions extends PagedSourceOptions {
  readonly fetchPage: FetchArrowPage;
}

/**
 * Grid rows from an engine that returns Arrow tables (the desktop's
 * `QueryService.rows()`, DuckDB-WASM in the web demo). Columns are matched
 * by name (falling back to position); values are formatted once on arrival
 * so painting only looks strings up.
 */
export class ArrowPagedSource extends PagedGridSource {
  private readonly fetchPage: FetchArrowPage;

  constructor(options: ArrowPagedSourceOptions) {
    super(options);
    this.fetchPage = options.fetchPage;
  }

  protected async loadPage(offset: number, limit: number, signal: AbortSignal): Promise<PageColumns> {
    const table = await this.fetchPage(offset, limit, signal);
    return tableToColumns(table, this.columns, limit);
  }
}

/** Formats the first `limit` rows of `table` into display columns in the order of `columns`. */
export function tableToColumns(table: Table, columns: readonly { readonly name: string; readonly type: ColumnType }[], limit: number): PageColumns {
  const rows = Math.min(limit, table.numRows);
  const fields = table.schema.fields;
  const names = fields.map((field) => field.name);
  return columns.map((column, position) => {
    let index = names.indexOf(column.name);
    // Unnamed or renamed result columns: fall back to position when the shapes agree.
    if (index < 0 && names.length === columns.length) index = position;
    const out: GridCell[] = new Array<GridCell>(rows);
    const vector = index >= 0 ? table.getChildAt(index) : null;
    if (!vector) {
      out.fill(null);
      return out;
    }
    // The Arrow type decides (Decimal128, Time64, Interval, Date, Timestamp); the logical type is the fallback.
    const format = formatterFor(valueKind(fields[index], kindForType(column.type)));
    for (let r = 0; r < rows; r += 1) out[r] = format(vector.get(r));
    // FLOAT/DOUBLE: the page's numbers share one number of decimals, so the digits line up.
    return DataType.isFloat(fields[index]?.type) ? alignDecimals(out) : out;
  });
}
