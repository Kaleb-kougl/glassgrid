import { z } from 'zod';
import { type CompileColumn } from '../spec/column.js';
import { FilterSchema, type FilterInput } from '../spec/filter.js';
import { RowQuerySchema, type RowQueryInput } from '../spec/rows.js';
import { ROW_COUNT_COLUMN } from '../sql.js';
import { Params, quoteIdent, type CompiledQuery } from './builder.js';
import { ColumnIndex } from './columns.js';
import { filterPredicates, parseOrThrow, whereClause } from './where.js';

/**
 * One page of grid rows: every column in `columns` order, filtered, sorted and
 * paged with `LIMIT $n OFFSET $m`.
 *
 * Ordering is fully deterministic when `sort` is non-empty: after the sort
 * keys, every remaining column breaks ties (ascending, NULLs last), so only
 * rows that are identical in every column can swap places, which is
 * invisible. NULLs sort last in both directions. Without sort keys there is
 * no ORDER BY and pages follow the relation's scan order, which DuckDB keeps
 * stable for a view over a file (`preserve_insertion_order`, on by default).
 */
export function compileRowsQuery(
  table: string,
  query: RowQueryInput,
  columns: readonly CompileColumn[],
): CompiledQuery {
  const parsed = parseOrThrow(RowQuerySchema, query, 'row query');
  const index = new ColumnIndex(columns);
  const params = new Params();
  const where = whereClause(filterPredicates(parsed.filters, index, params));

  const sorted = new Set<string>();
  const orderBy: string[] = [];
  parsed.sort.forEach((key, i) => {
    const column = index.get(key.column, `sort[${i}].column`);
    if (sorted.has(column.name)) return;
    sorted.add(column.name);
    orderBy.push(`${quoteIdent(column.name)} ${key.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`);
  });
  if (orderBy.length > 0) {
    for (const column of columns) {
      if (sorted.has(column.name)) continue;
      sorted.add(column.name);
      orderBy.push(`${quoteIdent(column.name)} ASC NULLS LAST`);
    }
  }

  const select = columns.length === 0 ? '*' : columns.map((c) => quoteIdent(c.name)).join(', ');
  const order = orderBy.length > 0 ? `\nORDER BY ${orderBy.join(', ')}` : '';
  const limit = params.bigint(parsed.limit);
  const offset = params.bigint(parsed.offset);
  return {
    sql: `SELECT ${select}\nFROM ${table}${where}${order}\nLIMIT ${limit} OFFSET ${offset}`,
    params: params.values,
  };
}

/** `SELECT count(*) AS row_count` over the filtered relation (a BIGINT). */
export function compileCountQuery(
  table: string,
  filters: readonly FilterInput[],
  columns: readonly CompileColumn[],
): CompiledQuery {
  const parsed = parseOrThrow(z.array(FilterSchema), filters, 'filters');
  const params = new Params();
  const where = whereClause(filterPredicates(parsed, new ColumnIndex(columns), params));
  return { sql: `SELECT count(*) AS ${ROW_COUNT_COLUMN}\nFROM ${table}${where}`, params: params.values };
}
