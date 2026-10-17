import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';
import { quoteIdent, type CompiledQuery } from '../../src/index.js';
import { isoDate, isoTimestamp, numericScale, SQL_TYPE, type Cell, type TestTable } from './model.js';

/** A deliberately awkward relation name, quoted the way the engine would. */
export const TABLE = quoteIdent('glass "grid" table');

export type ResultRow = Record<string, Cell>;

export async function openConnection(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  return instance.connect();
}

function insertValue(type: TestTable['columns'][number]['type'], cell: Cell): DuckDBValue {
  if (cell === null) return null;
  switch (type) {
    case 'decimal':
      return (Math.round(Number(cell) * numericScale(type)) / numericScale(type)).toFixed(2);
    case 'date':
      return isoDate(Number(cell));
    case 'timestamp':
      return isoTimestamp(Number(cell));
    default:
      return cell;
  }
}

/** Replace the test relation with `table`'s schema and rows. */
export async function loadTable(connection: DuckDBConnection, table: TestTable): Promise<void> {
  const columnsSql = table.columns.map((c) => `${quoteIdent(c.name)} ${SQL_TYPE[c.type]}`).join(', ');
  await connection.run(`CREATE OR REPLACE TABLE ${TABLE} (${columnsSql})`);
  if (table.rows.length === 0) return;
  const params: DuckDBValue[] = [];
  const tuples = table.rows.map(
    (row) =>
      `(${table.columns
        .map((column, c) => {
          params.push(insertValue(column.type, row[c] ?? null));
          return `CAST($${params.length} AS ${SQL_TYPE[column.type]})`;
        })
        .join(', ')})`,
  );
  await connection.run(`INSERT INTO ${TABLE} VALUES ${tuples.join(', ')}`, params);
}

function normalize(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  throw new Error(`Unexpected DuckDB value of type ${typeof value}: ${JSON.stringify(value)}`);
}

/** Run a compiled query and return its rows with temporal values as epoch ms. */
export async function runQuery(connection: DuckDBConnection, query: CompiledQuery): Promise<ResultRow[]> {
  const reader = await connection.runAndReadAll(query.sql, query.params as DuckDBValue[]);
  return reader.getRowObjectsJS().map((row) => {
    const out: ResultRow = {};
    for (const [key, value] of Object.entries(row)) out[key] = normalize(value);
    return out;
  });
}

/** Run a compiled query whose result is rows of the table's columns, as positional cells. */
export async function runRowsQuery(connection: DuckDBConnection, query: CompiledQuery): Promise<Cell[][]> {
  const reader = await connection.runAndReadAll(query.sql, query.params as DuckDBValue[]);
  return reader.getRowsJS().map((row) => row.map(normalize));
}
