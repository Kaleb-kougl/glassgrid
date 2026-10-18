import { describe, expect, it } from 'vitest';
import { type ChartSpecInput } from '../spec/chart.js';
import { type CompileColumn } from '../spec/column.js';
import { autoTimeUnit, niceBinWidth, parseTemporal } from './bins.js';
import { quoteIdent } from './builder.js';
import { compileChartQuery, compileScatterCountQuery, scatterAsHeatmap, scatterPointLimit } from './chart.js';
import { CompileError, type CompileErrorCode } from './errors.js';
import { compileCountQuery, compileRowsQuery } from './rows.js';
import { compileWhere } from './where.js';

const TABLE = '"v_sales"';

const columns: CompileColumn[] = [
  { name: 'category', type: 'text', min: 'a', max: 'z' },
  { name: 'amount', type: 'float', min: 0, max: 1234.5 },
  { name: 'qty', type: 'integer', min: 1, max: 40 },
  { name: 'price', type: 'decimal', min: 0.5, max: 99.99 },
  { name: 'created_on', type: 'date', min: '2023-01-01', max: '2024-06-30' },
  { name: 'ts', type: 'timestamp', min: '2024-01-01 00:00:00', max: '2024-01-03 12:00:00' },
  { name: 'active', type: 'boolean', min: false, max: true },
  { name: 'we"ird name', type: 'text', min: null, max: null },
  { name: 'select', type: 'integer', min: -5, max: 5 },
  { name: '日付 😀', type: 'date', min: '2020-01-01', max: '2020-12-31' },
];

function compileError(fn: () => unknown): CompileError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CompileError) return error;
    throw error;
  }
  throw new Error('Expected a CompileError');
}

function expectCompileError(fn: () => unknown, code: CompileErrorCode, message: RegExp, path?: string): void {
  const error = compileError(fn);
  expect(error.code).toBe(code);
  expect(error.message).toMatch(message);
  if (path !== undefined) expect(error.path).toBe(path);
}

describe('quoteIdent', () => {
  it.each([
    ['plain', '"plain"'],
    ['a b', '"a b"'],
    ['quo"te', '"quo""te"'],
    ['"', '""""'],
    ['"; DROP TABLE t; --', '"""; DROP TABLE t; --"'],
    ["it's", `"it's"`],
    ['select', '"select"'],
    ['日付 😀', '"日付 😀"'],
    ['tab\there', '"tab\there"'],
  ])('quotes %j', (name, quoted) => {
    expect(quoteIdent(name)).toBe(quoted);
  });

  it('rejects empty names and NUL characters', () => {
    expectCompileError(() => quoteIdent(''), 'invalid_spec', /empty/);
    expectCompileError(() => quoteIdent('a\u0000b'), 'invalid_spec', /NUL/);
  });
});

describe('compileWhere', () => {
  it('is TRUE with no filters', () => {
    expect(compileWhere([], columns)).toEqual({ sql: 'TRUE', params: [] });
  });

  it('compiles every filter kind with bound, cast parameters', () => {
    const compiled = compileWhere(
      [
        { kind: 'range', column: 'amount', min: 10, max: 20, maxInclusive: false },
        { kind: 'range', column: 'ts', min: '2024-01-01', minInclusive: false },
        { kind: 'range', column: 'created_on', max: 1_700_000_000_000 },
        { kind: 'in', column: 'category', values: ['a', "O'Brien", null] },
        { kind: 'in', column: 'active', values: [true] },
        { kind: 'in', column: 'qty', values: [] },
        { kind: 'in', column: 'we"ird name', values: [null] },
        { kind: 'isNull', column: 'price' },
        { kind: 'notNull', column: 'select' },
      ],
      columns,
    );
    expect(compiled.sql).toMatchSnapshot();
    expect(compiled.params).toEqual([10, 20, '2024-01-01', 1_700_000_000_000, 'a', "O'Brien", true]);
  });

  it('never writes values into SQL text', () => {
    const evil = "x'); DROP TABLE t; --";
    const compiled = compileWhere([{ kind: 'in', column: 'category', values: [evil] }], columns);
    expect(compiled.sql).not.toContain('DROP');
    expect(compiled.params).toEqual([evil]);
  });

  it('reports unknown columns with the available names', () => {
    expectCompileError(
      () => compileWhere([{ kind: 'isNull', column: 'nope' }], columns),
      'unknown_column',
      /Unknown column "nope" at filters\[0\]\.column\. Available columns: "category", "amount"/,
      'filters[0].column',
    );
  });

  it('rejects filters that do not fit the column type', () => {
    expectCompileError(
      () => compileWhere([{ kind: 'range', column: 'category', min: 'a' }], columns),
      'type_mismatch',
      /Range filters need a numeric, date or timestamp column/,
    );
    expectCompileError(
      () => compileWhere([{ kind: 'range', column: 'amount', min: '10' }], columns),
      'type_mismatch',
      /filters\[0\]\.min must be a number/,
      'filters[0].min',
    );
    expectCompileError(
      () => compileWhere([{ kind: 'range', column: 'ts', max: 'yesterday' }], columns),
      'type_mismatch',
      /ISO date or timestamp/,
    );
    expectCompileError(
      () => compileWhere([{ kind: 'range', column: 'ts', max: 1.5 }], columns),
      'type_mismatch',
      /integer epoch milliseconds/,
    );
    expectCompileError(
      () => compileWhere([{ kind: 'in', column: 'qty', values: [1, 'two'] }], columns),
      'type_mismatch',
      /filters\[0\]\.values\[1\] must be a number/,
      'filters[0].values[1]',
    );
    expectCompileError(
      () => compileWhere([{ kind: 'in', column: 'active', values: ['true'] }], columns),
      'type_mismatch',
      /true or false/,
    );
  });

  it('turns schema violations into invalid_spec errors', () => {
    expectCompileError(
      () => compileWhere([{ kind: 'range', column: 'amount' }], columns),
      'invalid_spec',
      /needs min, max or both/,
    );
    expectCompileError(
      () => compileWhere([{ kind: 'like', column: 'amount' } as never], columns),
      'invalid_spec',
      /Invalid filters/,
    );
  });
});

describe('compileRowsQuery / compileCountQuery', () => {
  it('selects every column, sorts with a full tiebreak and pages with parameters', () => {
    const compiled = compileRowsQuery(
      TABLE,
      {
        offset: 2000,
        limit: 1000,
        sort: [
          { column: 'amount', direction: 'desc' },
          { column: 'we"ird name' },
          { column: 'amount', direction: 'asc' },
        ],
        filters: [{ kind: 'notNull', column: 'category' }],
      },
      columns,
    );
    expect(compiled.sql).toMatchSnapshot();
    expect(compiled.params).toEqual([1000, 2000]);
  });

  it('has no ORDER BY without sort keys', () => {
    const compiled = compileRowsQuery(TABLE, { offset: 0, limit: 50 }, columns.slice(0, 2));
    expect(compiled.sql).toBe('SELECT "category", "amount"\nFROM "v_sales"\nLIMIT CAST($1 AS BIGINT) OFFSET CAST($2 AS BIGINT)');
  });

  it('validates the page size and sort columns', () => {
    expectCompileError(() => compileRowsQuery(TABLE, { offset: 0, limit: 1001 }, columns), 'invalid_spec', /limit/);
    expectCompileError(() => compileRowsQuery(TABLE, { offset: -1, limit: 10 }, columns), 'invalid_spec', /offset/);
    expectCompileError(
      () => compileRowsQuery(TABLE, { offset: 0, limit: 10, sort: [{ column: 'nope' }] }, columns),
      'unknown_column',
      /sort\[0\]\.column/,
      'sort[0].column',
    );
  });

  it('counts filtered rows', () => {
    const compiled = compileCountQuery(TABLE, [{ kind: 'range', column: 'qty', min: 3 }], columns);
    expect(compiled).toEqual({
      sql: 'SELECT count(*) AS row_count\nFROM "v_sales"\nWHERE "qty" >= CAST($1 AS DOUBLE)',
      params: [3],
    });
    expect(compileCountQuery(TABLE, [], columns).sql).toBe('SELECT count(*) AS row_count\nFROM "v_sales"');
  });
});

describe('compileChartQuery snapshots', () => {
  const cases: [string, ChartSpecInput, { pixelWidth?: number }?][] = [
    ['bar: count by category', { mark: 'bar', x: { column: 'category' } }],
    [
      'bar: sum with colour, top 5, filtered',
      {
        mark: 'bar',
        x: { column: 'we"ird name' },
        y: { column: 'amount', aggregate: 'sum' },
        color: { column: 'select' },
        filters: [{ kind: 'range', column: 'qty', min: 1, max: 10 }],
        limit: 5,
      },
    ],
    ['bar: max date per month', { mark: 'bar', x: { column: 'ts', timeUnit: 'month' }, y: { column: 'created_on', aggregate: 'max' } }],
    ['histogram: auto numeric bins', { mark: 'histogram', x: { column: 'amount' } }],
    ['histogram: explicit width, avg, colour', { mark: 'histogram', x: { column: 'qty', bin: 5 }, y: { column: 'price', aggregate: 'avg' }, color: { column: 'active' } }],
    ['histogram: auto time unit', { mark: 'histogram', x: { column: 'created_on' } }],
    ['heatmap: numeric x time', { mark: 'heatmap', x: { column: 'amount' }, y: { column: 'ts', timeUnit: 'hour' } }],
    ['line: auto time unit with M4', { mark: 'line', x: { column: 'ts' }, y: { column: 'amount', aggregate: 'sum' } }, { pixelWidth: 800 }],
    ['area: colour series with M4', { mark: 'area', x: { column: 'created_on', timeUnit: 'month' }, color: { column: 'category' } }],
    ['line: numeric x, explicit bin', { mark: 'line', x: { column: 'price', bin: 0.5 }, y: { column: 'qty', aggregate: 'max' } }, { pixelWidth: 300 }],
    ['scatter: raw points', { mark: 'scatter', x: { column: 'amount' }, y: { column: 'price' } }],
    ['scatter: coloured, capped', { mark: 'scatter', x: { column: 'qty' }, y: { column: 'ts' }, color: { column: '日付 😀' }, limit: 1000 }],
  ];

  it.each(cases)('%s', (_, spec, opts) => {
    const compiled = compileChartQuery(TABLE, spec, columns, opts);
    expect(compiled.sql).toMatchSnapshot();
    expect(compiled.params).toMatchSnapshot();
  });

  it('binds the M4 pixel width and the bar limit', () => {
    const line = compileChartQuery(TABLE, { mark: 'line', x: { column: 'ts' } }, columns, { pixelWidth: 640 });
    expect(line.params).toEqual([640]);
    const bar = compileChartQuery(TABLE, { mark: 'bar', x: { column: 'category' } }, columns);
    expect(bar.params).toEqual([20]);
  });
});

describe('compileChartQuery: integer time keys and the combined heatmap cell key', () => {
  // The engine's profile carries DuckDB types; with them, hour and day buckets group on integer keys.
  const typed: CompileColumn[] = [
    { name: 'ts', type: 'timestamp', min: '2024-01-01 00:00:00', max: '2024-01-31 23:59:59', duckdbType: 'TIMESTAMP' },
    { name: 'tz', type: 'timestamp', min: '2024-01-01 00:00:00', max: '2024-01-31 23:59:59', duckdbType: 'TIMESTAMP WITH TIME ZONE' },
    { name: 'day', type: 'date', min: '2023-01-01', max: '2024-06-30', duckdbType: 'DATE' },
    { name: 'amount', type: 'float', min: 0, max: 1234.5, duckdbType: 'DOUBLE' },
    { name: 'qty', type: 'integer', min: 1, max: 40, duckdbType: 'BIGINT' },
    { name: 'far', type: 'float', min: 1e12, max: 1e12 + 100, duckdbType: 'DOUBLE' },
  ];
  const sqlOf = (spec: ChartSpecInput, opts?: { pixelWidth?: number }) => compileChartQuery(TABLE, spec, typed, opts).sql;

  it.each<[string, ChartSpecInput, { pixelWidth?: number }?]>([
    ['line: hourly TIMESTAMP (integer hour key)', { mark: 'line', x: { column: 'ts' } }, { pixelWidth: 600 }],
    ['line: daily TIMESTAMP (DATE key)', { mark: 'line', x: { column: 'ts', timeUnit: 'day' }, y: { column: 'amount', aggregate: 'sum' } }],
    ['histogram: hourly TIMESTAMP', { mark: 'histogram', x: { column: 'ts', timeUnit: 'hour' } }],
    ['heatmap: numeric x numeric (one cell key)', { mark: 'heatmap', x: { column: 'amount' }, y: { column: 'qty' } }],
  ])('%s', (_, spec, opts) => {
    const compiled = compileChartQuery(TABLE, spec, typed, opts);
    expect(compiled.sql).toMatchSnapshot();
    expect(compiled.params).toMatchSnapshot();
  });

  it('keys hours and days on integers only for TIMESTAMP columns', () => {
    expect(sqlOf({ mark: 'line', x: { column: 'ts', timeUnit: 'hour' } })).toContain('epoch_us("ts") // 3600000000');
    expect(sqlOf({ mark: 'area', x: { column: 'ts', timeUnit: 'day' } })).toContain('CAST("ts" AS DATE) AS gx');
    // Months, TIMESTAMPTZ (session time zone), DATE, unknown types and bar charts (x is the key itself) keep date_trunc.
    expect(sqlOf({ mark: 'line', x: { column: 'day', timeUnit: 'day' } })).toContain(`date_trunc('day', "day") AS gx`);
    expect(sqlOf({ mark: 'line', x: { column: 'ts', timeUnit: 'month' } })).toContain(`date_trunc('month', "ts") AS gx`);
    expect(sqlOf({ mark: 'line', x: { column: 'tz', timeUnit: 'hour' } })).toContain(`date_trunc('hour', "tz") AS gx`);
    expect(sqlOf({ mark: 'bar', x: { column: 'ts', timeUnit: 'hour' } })).toContain(`date_trunc('hour', "ts") AS gx`);
    expect(compileChartQuery(TABLE, { mark: 'line', x: { column: 'ts', timeUnit: 'hour' } }, columns).sql).toContain(`date_trunc('hour', "ts") AS gx`);
  });

  it('uses one cell key only when the profile bounds both axes', () => {
    expect(sqlOf({ mark: 'heatmap', x: { column: 'amount' }, y: { column: 'qty' } })).toContain('GROUP BY gxy');
    // Bins beyond ±2^24 (or no numeric profile, or a time axis) keep two keys.
    expect(sqlOf({ mark: 'heatmap', x: { column: 'far' }, y: { column: 'qty' } })).toContain('GROUP BY gx, gy');
    expect(sqlOf({ mark: 'heatmap', x: { column: 'amount' }, y: { column: 'ts' } })).toContain('GROUP BY gx, gy');
    const unprofiled = typed.map((column) => ({ ...column, min: null, max: null }));
    expect(compileChartQuery(TABLE, { mark: 'heatmap', x: { column: 'amount', bin: 5 }, y: { column: 'qty', bin: 1 } }, unprofiled).sql).toContain('GROUP BY gx, gy');
  });
});

describe('compileChartQuery validation', () => {
  const chart = (spec: ChartSpecInput, opts?: { pixelWidth?: number }) => () => compileChartQuery(TABLE, spec, columns, opts);

  it('rejects invalid specs with the Zod message', () => {
    expectCompileError(chart({ mark: 'pie', x: { column: 'qty' } } as never), 'invalid_spec', /Invalid chart spec[\s\S]*mark/);
    expectCompileError(chart({ mark: 'bar', x: { column: 'qty', colour: 'red' } } as never), 'invalid_spec', /colour/);
    expectCompileError(chart({ mark: 'bar', x: { column: 'qty' }, limit: 0 }), 'invalid_spec', /limit/);
  });

  it('rejects unknown columns on every channel', () => {
    expectCompileError(chart({ mark: 'bar', x: { column: 'nope' } }), 'unknown_column', /"nope" at x\.column/, 'x.column');
    expectCompileError(
      chart({ mark: 'bar', x: { column: 'qty' }, y: { column: 'nope', aggregate: 'sum' } }),
      'unknown_column',
      /y\.column/,
    );
    expectCompileError(chart({ mark: 'bar', x: { column: 'qty' }, color: { column: 'nope' } }), 'unknown_column', /color\.column/);
    expectCompileError(
      chart({ mark: 'bar', x: { column: 'qty' }, filters: [{ kind: 'notNull', column: 'nope' }] }),
      'unknown_column',
      /filters\[0\]\.column/,
    );
  });

  it('rejects type-incompatible aggregates', () => {
    expectCompileError(
      chart({ mark: 'bar', x: { column: 'qty' }, y: { column: 'category', aggregate: 'sum' } }),
      'type_mismatch',
      /y\.aggregate "sum" needs a numeric column, but "category" is text\. Use "count" instead\./,
      'y.aggregate',
    );
    expectCompileError(
      chart({ mark: 'bar', x: { column: 'qty' }, y: { column: 'ts', aggregate: 'avg' } }),
      'type_mismatch',
      /Use "count", "min" or "max" instead/,
    );
    expectCompileError(
      chart({ mark: 'line', x: { column: 'ts' }, y: { column: 'active', aggregate: 'max' } }),
      'type_mismatch',
      /"max" needs a numeric, date or timestamp column/,
    );
    expectCompileError(chart({ mark: 'bar', x: { column: 'qty' }, y: { column: 'amount' } }), 'invalid_spec', /y\.aggregate is required/);
  });

  it('rejects channel options a mark does not take', () => {
    expectCompileError(chart({ mark: 'bar', x: { column: 'qty', bin: 5 } }), 'unsupported', /Use mark "histogram"/, 'x.bin');
    expectCompileError(chart({ mark: 'bar', x: { column: 'qty', timeUnit: 'day' } }), 'type_mismatch', /x\.timeUnit needs a date/);
    expectCompileError(chart({ mark: 'histogram', x: { column: 'created_on', timeUnit: 'hour' } }), 'type_mismatch', /"hour" needs a timestamp/);
    expectCompileError(chart({ mark: 'histogram', x: { column: 'ts', bin: 3 } }), 'unsupported', /x\.timeUnit/, 'x.bin');
    expectCompileError(chart({ mark: 'histogram', x: { column: 'category' } }), 'type_mismatch', /Use mark "bar" for categories/);
    expectCompileError(chart({ mark: 'histogram', x: { column: 'qty' }, limit: 5 }), 'unsupported', /limit applies only/, 'limit');
    expectCompileError(chart({ mark: 'bar', x: { column: 'qty' }, limit: 1001 }), 'unsupported', /at most 1000/);
    expectCompileError(
      chart({ mark: 'bar', x: { column: 'qty' }, color: { column: 'ts', timeUnit: 'day' } }),
      'unsupported',
      /color\.timeUnit/,
    );
    expectCompileError(
      chart({ mark: 'heatmap', x: { column: 'qty' }, y: { column: 'amount' }, color: { column: 'category' } }),
      'unsupported',
      /heatmap charts do not take color/,
    );
    expectCompileError(
      chart({ mark: 'heatmap', x: { column: 'qty' }, y: { column: 'amount', aggregate: 'sum' } }),
      'unsupported',
      /cells always count rows/,
    );
    expectCompileError(chart({ mark: 'heatmap', x: { column: 'qty' } }), 'invalid_spec', /need y/, 'y');
    expectCompileError(
      chart({ mark: 'scatter', x: { column: 'qty' }, y: { column: 'amount', aggregate: 'avg' } }),
      'unsupported',
      /raw points/,
    );
    expectCompileError(chart({ mark: 'scatter', x: { column: 'qty', bin: 'auto' }, y: { column: 'amount' } }), 'unsupported', /x\.bin/);
    expectCompileError(chart({ mark: 'scatter', x: { column: 'qty' }, y: { column: 'category' } }), 'type_mismatch', /for y/);
    expectCompileError(chart({ mark: 'line', x: { column: 'ts' } }, { pixelWidth: 0 }), 'invalid_spec', /pixelWidth/);
  });

  it('refuses explicit bin widths that would explode the bin count', () => {
    expectCompileError(
      chart({ mark: 'histogram', x: { column: 'amount', bin: 0.01 } }),
      'too_many_bins',
      /into 123451 bins; the limit is 10000/,
      'x.bin',
    );
    expectCompileError(
      chart({ mark: 'heatmap', x: { column: 'qty', bin: 0.01 }, y: { column: 'amount' } }),
      'too_many_bins',
      /limit is 1000/,
    );
  });
});

describe('scatter fallback contract', () => {
  const spec: ChartSpecInput = {
    mark: 'scatter',
    x: { column: 'amount' },
    y: { column: 'price' },
    color: { column: 'category' },
    filters: [{ kind: 'isNull', column: 'qty' }],
    limit: 10_000,
  };

  it('counts plottable points', () => {
    expect(compileScatterCountQuery(TABLE, spec, columns)).toEqual({
      sql: 'SELECT count(*) AS row_count\nFROM "v_sales"\nWHERE "qty" IS NULL\n  AND "amount" IS NOT NULL\n  AND "price" IS NOT NULL',
      params: [],
    });
    expectCompileError(() => compileScatterCountQuery(TABLE, { mark: 'bar', x: { column: 'qty' } }, columns), 'unsupported', /scatter/);
  });

  it('caps points at the spec limit, never above 50K', () => {
    expect(scatterPointLimit(spec)).toBe(10_000);
    expect(scatterPointLimit({ ...spec, limit: undefined })).toBe(50_000);
  });

  it('falls back to an auto-binned heatmap with the same axes and filters', () => {
    const heatmap = scatterAsHeatmap(spec);
    expect(heatmap).toEqual({
      mark: 'heatmap',
      x: { column: 'amount' },
      y: { column: 'price' },
      filters: [{ kind: 'isNull', column: 'qty' }],
    });
    expect(() => compileChartQuery(TABLE, heatmap, columns)).not.toThrow();
  });
});

describe('bins', () => {
  it('picks nice widths for about 50 bins', () => {
    expect(niceBinWidth(0, 1234.5, 50, false)).toBe(50);
    expect(niceBinWidth(0, 1, 50, false)).toBe(0.02);
    expect(niceBinWidth(-3, 3, 50, false)).toBe(0.2);
    expect(niceBinWidth(1, 40, 50, true)).toBe(1);
    expect(niceBinWidth(0, 1e6, 50, true)).toBe(20_000);
    expect(niceBinWidth(5, 5, 50, false)).toBe(1);
  });

  it('parses ISO dates and timestamps as UTC', () => {
    expect(parseTemporal('2024-02-29')).toBe(Date.UTC(2024, 1, 29));
    expect(parseTemporal('2024-01-31 12:30:15.25')).toBe(Date.UTC(2024, 0, 31, 12, 30, 15, 250));
    expect(parseTemporal('2024-01-31T12:30Z')).toBe(Date.UTC(2024, 0, 31, 12, 30));
    expect(parseTemporal(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseTemporal('2023-02-29')).toBeNull();
    expect(parseTemporal('2024-01-31Z')).toBeNull();
    expect(parseTemporal('31/01/2024')).toBeNull();
    expect(parseTemporal(null)).toBeNull();
  });

  it('chooses time units from the profiled span', () => {
    const closest = { mode: 'closest', target: 50 } as const;
    expect(autoTimeUnit('2024-01-01 00:00:00', '2024-01-02 12:00:00', 'timestamp', closest)).toBe('hour');
    expect(autoTimeUnit('2024-01-01', '2024-03-01', 'date', closest)).toBe('day');
    expect(autoTimeUnit('2020-01-01', '2024-01-01', 'date', closest)).toBe('month');
    expect(autoTimeUnit('2024-01-01 00:00:00', '2024-01-02 12:00:00', 'date', closest)).toBe('day');
    const finest = { mode: 'finest', max: 20_000 } as const;
    expect(autoTimeUnit('2023-01-01 00:00:00', '2024-06-01 00:00:00', 'timestamp', finest)).toBe('hour');
    expect(autoTimeUnit('2000-01-01 00:00:00', '2024-06-01 00:00:00', 'timestamp', finest)).toBe('day');
    expect(autoTimeUnit(null, null, 'timestamp', finest)).toBe('day');
  });
});
