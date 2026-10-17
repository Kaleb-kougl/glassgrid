/*
 * Property tests: compile random specs over random small tables, run the SQL
 * in real DuckDB, and compare with the JS reference in ./support/reference.ts.
 */
import { type DuckDBConnection } from '@duckdb/node-api';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compileChartQuery,
  compileCountQuery,
  compileRowsQuery,
  compileScatterCountQuery,
  compileWhere,
  scatterPointLimit,
  type ChartSpecInput,
  type CompiledQuery,
} from '../src/index.js';
import {
  barSpecArb,
  filtersArb,
  heatmapSpecArb,
  histogramSpecArb,
  lineSpecArb,
  rowQueryArb,
  scatterSpecArb,
  tableArb,
} from './support/arbitraries.js';
import { loadTable, openConnection, runQuery, runRowsQuery, TABLE, type ResultRow } from './support/db.js';
import { compareNullsLast, profileOf, type Cell, type TestTable } from './support/model.js';
import {
  refBar,
  refCount,
  refHeatmap,
  refHistogram,
  refLine,
  refRows,
  refScatter,
} from './support/reference.js';

const SEED = 20261017;
const NUM_RUNS = 200;
const TIMEOUT_MS = 120_000;
const RUN = { seed: SEED, numRuns: NUM_RUNS, endOnFailure: true } as const;

let connection: DuckDBConnection;

beforeAll(async () => {
  connection = await openConnection();
});

afterAll(() => {
  connection.closeSync();
});

function close(a: Cell, b: Cell): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return Object.is(a, b);
}

function describeFailure(query: CompiledQuery, actual: unknown, expected: unknown): string {
  return [
    'SQL:',
    query.sql,
    `params: ${JSON.stringify(query.params)}`,
    `actual:   ${JSON.stringify(actual)}`,
    `expected: ${JSON.stringify(expected)}`,
  ].join('\n');
}

/** Same rows in the same order, same keys, numbers equal within 1e-9 relative. */
function expectRowsClose(query: CompiledQuery, actual: readonly ResultRow[], expected: readonly ResultRow[]): void {
  const ok =
    actual.length === expected.length &&
    actual.every((row, i) => {
      const other = expected[i];
      if (!other) return false;
      const keys = Object.keys(other);
      return Object.keys(row).length === keys.length && keys.every((key) => close(row[key] ?? null, other[key] ?? null));
    });
  if (!ok) expect.fail(describeFailure(query, actual, expected));
}

function compareResultRows(a: ResultRow, b: ResultRow): number {
  for (const key of Object.keys(a).sort()) {
    const order = compareNullsLast(a[key] ?? null, b[key] ?? null);
    if (order !== 0) return order;
  }
  return 0;
}

async function withTable(table: TestTable): Promise<void> {
  await loadTable(connection, table);
}

describe('compiler property tests (DuckDB vs JS reference)', () => {
  it('filters: compileWhere and compileCountQuery count the same rows as the reference', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb.chain((table) => fc.tuple(fc.constant(table), filtersArb(table))),
        async ([table, filters]) => {
          await withTable(table);
          const profile = profileOf(table);
          const expected = refCount(table, filters);

          const count = compileCountQuery(TABLE, filters, profile);
          const [countRow] = await runQuery(connection, count);
          if (countRow?.['row_count'] !== expected) expect.fail(describeFailure(count, countRow, expected));

          const where = compileWhere(filters, profile);
          const direct: CompiledQuery = { sql: `SELECT count(*) AS n FROM ${TABLE} WHERE ${where.sql}`, params: where.params };
          const [directRow] = await runQuery(connection, direct);
          if (directRow?.['n'] !== expected) expect.fail(describeFailure(direct, directRow, expected));
        },
      ),
      RUN,
    );
  }, TIMEOUT_MS);

  it('rows: paging, sorting (NULLs last, every column as tiebreak) and filters match the reference', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb.chain((table) => fc.tuple(fc.constant(table), rowQueryArb(table))),
        async ([table, query]) => {
          await withTable(table);
          const compiled = compileRowsQuery(TABLE, query, profileOf(table));
          const actual = await runRowsQuery(connection, compiled);
          const expected = refRows(table, query);
          if (JSON.stringify(actual) !== JSON.stringify(expected)) expect.fail(describeFailure(compiled, actual, expected));
        },
      ),
      RUN,
    );
  }, TIMEOUT_MS);

  it('bar: top-N groups (NULL is a group; ties by x ascending, NULLs last) with colour folding', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb.chain((table) => fc.tuple(fc.constant(table), barSpecArb(table))),
        async ([table, spec]) => {
          await withTable(table);
          const compiled = compileChartQuery(TABLE, spec, profileOf(table));
          expectRowsClose(compiled, await runQuery(connection, compiled), refBar(table, spec));
        },
      ),
      RUN,
    );
  }, TIMEOUT_MS);

  it('histogram: numeric bins (explicit and auto width) and time buckets', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb.chain((table) => fc.tuple(fc.constant(table), histogramSpecArb(table))),
        async ([table, spec]) => {
          await withTable(table);
          const profile = profileOf(table);
          const compiled = compileChartQuery(TABLE, spec, profile);
          expectRowsClose(compiled, await runQuery(connection, compiled), refHistogram(table, profile, spec));
        },
      ),
      RUN,
    );
  }, TIMEOUT_MS);

  it('heatmap: 2-D binning counts rows per cell', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb.chain((table) => fc.tuple(fc.constant(table), heatmapSpecArb(table))),
        async ([table, spec]) => {
          await withTable(table);
          const profile = profileOf(table);
          const compiled = compileChartQuery(TABLE, spec, profile);
          expectRowsClose(compiled, await runQuery(connection, compiled), refHeatmap(table, profile, spec));
        },
      ),
      RUN,
    );
  }, TIMEOUT_MS);

  it('line/area: time buckets plus M4 keep first, last, min and max per pixel column and series', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb.chain((table) => fc.tuple(fc.constant(table), lineSpecArb(table))),
        async ([table, { spec, pixelWidth }]) => {
          await withTable(table);
          const profile = profileOf(table);
          const compiled = compileChartQuery(TABLE, spec, profile, { pixelWidth });
          expectRowsClose(compiled, await runQuery(connection, compiled), refLine(table, profile, spec, pixelWidth));
        },
      ),
      RUN,
    );
  }, TIMEOUT_MS);

  it('scatter: raw points under the cap, a capped subset above it, and the point count', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb.chain((table) => fc.tuple(fc.constant(table), scatterSpecArb(table))),
        async ([table, spec]: [TestTable, ChartSpecInput]) => {
          await withTable(table);
          const profile = profileOf(table);
          const expected = refScatter(table, spec);

          const count = compileScatterCountQuery(TABLE, spec, profile);
          const [countRow] = await runQuery(connection, count);
          if (countRow?.['row_count'] !== expected.length) expect.fail(describeFailure(count, countRow, expected.length));

          const compiled = compileChartQuery(TABLE, spec, profile);
          const actual = [...(await runQuery(connection, compiled))].sort(compareResultRows);
          const sortedExpected = [...expected].sort(compareResultRows);
          const limit = scatterPointLimit(spec);
          if (expected.length <= limit) {
            expectRowsClose(compiled, actual, sortedExpected);
            return;
          }
          // Over the cap the engine falls back to a heatmap; the raw query must still be a capped subset.
          const remaining = [...sortedExpected];
          const ok =
            actual.length === limit &&
            actual.every((row) => {
              const at = remaining.findIndex((candidate) => compareResultRows(candidate, row) === 0);
              if (at < 0) return false;
              remaining.splice(at, 1);
              return true;
            });
          if (!ok) expect.fail(describeFailure(compiled, actual, sortedExpected));
        },
      ),
      RUN,
    );
  }, TIMEOUT_MS);
});
