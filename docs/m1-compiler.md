# M1 notes: spec schemas and SQL compiler

`packages/core/src/spec` holds the Zod schemas (`ColumnProfile`, `Field`,
`Filter`, `ChartSpec`, `RowQuery`); `packages/core/src/sql` compiles them to
DuckDB SQL. The compiler is pure (no I/O) and is the only producer of SQL for
grid and chart requests.

## API

```ts
compileWhere(filters, columns): CompiledQuery                    // boolean expression, 'TRUE' if empty
compileRowsQuery(table, query: RowQuery, columns): CompiledQuery
compileCountQuery(table, filters, columns): CompiledQuery        // one BIGINT column, row_count
compileChartQuery(table, spec: ChartSpec, columns, opts?: { pixelWidth?: number }): CompiledQuery
compileScatterCountQuery(table, spec, columns): CompiledQuery    // see "Scatter and heatmap"
scatterPointLimit(spec): number; scatterAsHeatmap(spec): ChartSpec
type CompiledQuery = { sql: string; params: unknown[] }          // $1 is params[0]
```

- `table` is inserted verbatim. The engine passes a relation it controls, quoted
  with `quoteIdent` (e.g. `"v_<handle>"`).
- `columns` is the table's profile. The compiler reads `name` and `type`, plus
  `min`/`max` for automatic bins and time units. Temporal min/max are ISO
  strings (`2024-01-31`, `2024-01-31 12:00:00`) or epoch ms.
- Identifiers are always double-quoted with embedded quotes doubled. Every data
  value (filter values, bin widths, limits, offsets, pixel width) is a `$n`
  parameter wrapped in an explicit `CAST`, so results do not depend on how the
  driver infers types from JS values (node-api binds `1` as INTEGER and `1.5`
  as DOUBLE). Only code constants and keywords from closed enums (`'hour'`,
  `INTERVAL 1 MONTH`, `LIMIT 8` for colour series) appear as SQL text.
- Every input is re-validated with its Zod schema. Problems throw
  `CompileError { code, message, path }`. Codes: `invalid_spec`, `unknown_column`,
  `type_mismatch`, `unsupported`, `too_many_bins`. Messages name the path and
  the valid alternatives, e.g. `y.aggregate "sum" needs a numeric column, but
  "category" is text. Use "count" instead.` They are meant to be shown to users
  and returned to models.

## Filters

AND-combined. `range` (numeric/date/timestamp; `minInclusive`/`maxInclusive`
default true), `in` (any type; `null` in `values` also matches NULL cells; an
empty list matches nothing), `isNull`, `notNull`. Temporal bounds are ISO
strings (cast to TIMESTAMP) or integer epoch ms (`epoch_ms`). DATE columns
compare as midnight timestamps. Numeric comparisons go through DOUBLE, so a
DECIMAL or INTEGER column is compared as DOUBLE, the way DuckDB casts it.
Range and `in` never match NULL unless `null` is listed.

## Rows

`SELECT <every profiled column> FROM t WHERE … ORDER BY … LIMIT $n OFFSET $m`
with `limit` from 1 to 1000. With sort keys, NULLs sort last in both directions.
Every column not already a sort key is appended as an ascending tiebreak, so
paging is deterministic: only fully identical rows can swap, which nobody can
see. Without sort keys there is no ORDER BY, and pages follow scan order.
DuckDB keeps scan order stable for a table or a view over a file
(`preserve_insertion_order`).

## SQL shape per mark

Every chart query starts with
`__gg_base AS (SELECT <keys> AS gx[, gy][, gc] FROM t WHERE <filters> [AND <dims> IS NOT NULL])`.
It projects only the columns the chart needs and renames them, so user column
names never collide with internal aliases.

| Mark | Shape | Columns returned |
| --- | --- | --- |
| bar | `GROUP BY gx ORDER BY y DESC NULLS LAST, gx ASC NULLS LAST LIMIT $n` (default 20, max 1000). `x.timeUnit` allowed on temporal x | `x, y` |
| histogram | `gx = floor(CAST(x AS DOUBLE) / $w)`, returns `gx*$w`, `(gx+1)*$w`, `ORDER BY gx`. Auto width: smallest 1/2/5×10ⁿ ≥ (max−min)/50 from the profile (≥ 1 for integers). Temporal x: `date_trunc(unit)`, auto unit closest to 50 buckets | `x, x_end, y` |
| line / area | bucket (`date_trunc` with `timeUnit` or auto: finest of hour/day/month with ≤ 20,000 buckets; numeric x raw or binned), aggregate, then M4 (below) | `x, y` |
| heatmap | both axes binned like histogram with target 100 per axis; cell = `count(*)` | `x, x_end, y, y_end, count` |
| scatter | raw `x, y` with x and y not NULL, `LIMIT $n` (default and max 50,000) | `x, y` |

Measures: no `y` means `count(*)`; `count(col)` counts non-NULL; `sum`/`avg`
need numeric; `min`/`max` take numeric or date/timestamp. Measures are DOUBLE,
except min/max of temporal columns, which keep the column type. Binned x is
DOUBLE, time-bucketed x is TIMESTAMP, raw x keeps its type. Explicit widths
that would create more than 10,000 histogram bins (1,000 per heatmap axis)
throw `too_many_bins`. Empty bins are not returned.

**Colour** (all marks except heatmap): `__gg_series` ranks series by the
chart's measure over all base rows (scatter: by row count), descending, NULLs
last, ties by series value ascending, NULLs last. It keeps the top 8.
`__gg_src` folds every other row into one "Other" series: the output has
`color` (column type, NULL for Other) and `color_other` (BOOLEAN), and Other's
measure is recomputed from its raw rows. The result holds at most 9 series. A
bar chart with colour picks the top N x values by total measure, then splits
each bar by folded series.

## NULL semantics

- **Bar:** NULL x is a group of its own (SQL `GROUP BY` semantics) and competes
  for the top N like any other. It is last among equal measures.
- **Histogram, line/area, heatmap, scatter:** rows with a NULL positional value
  are dropped (`IS NOT NULL` in `__gg_base`). Count them with
  `compileCountQuery` and an `isNull` filter if the UI wants to show them.
- **Measures:** a group whose `sum`/`avg`/`min`/`max` input is all NULL gets
  NULL. It sorts last in top N and in colour ranking, and is a gap in a line.
- A NULL colour value is a normal series (`color = NULL, color_other = FALSE`).
- **Ties:** top N and top 8 break ties by value ascending, NULLs last. Results
  are deterministic.

## M4

After bucketing and aggregating, each point gets
`xn` (`epoch_us(x)` for time, `CAST(x AS DOUBLE)` for numbers) and a pixel
column computed over the global `[lo, hi]` of `xn`:

```
px = CASE WHEN hi = lo THEN 0 ELSE least(floor((xn - lo) / (hi - lo) * $W), $W - 1) END
```

Per `(series, px)` four `row_number()` windows pick the first (min x), last
(max x), min y (`y ASC NULLS LAST, x ASC`) and max y (`y DESC NULLS LAST, x ASC`)
point. Rows ranked first by any window are kept, so the result has at most
4 × `pixelWidth` points per series, in one query. `pixelWidth` (`opts`, default
1000, max 16,384) should be the plot width in device pixels. All series share
one x range, so their pixel columns line up.

## Scatter and heatmap contract

The engine decides the fallback, because only it can count:

1. Run `compileScatterCountQuery(t, spec, columns)`. It counts rows that pass
   the filters with non-NULL x and y.
2. If `row_count > scatterPointLimit(spec)` (spec `limit`, capped at 50,000),
   compile `scatterAsHeatmap(spec)` (same axes and filters, auto 100×100 bins,
   colour dropped) and tell the renderer the result is a heatmap fallback.
3. Otherwise compile the scatter spec. Its LIMIT is only a safety cap, so all
   points come back.

## What the engine needs

- A relation per open file and its profile (`ColumnProfile[]`: name, type,
  min, max; `nullFraction`/`distinctCount` are for the UI). Profiles should
  map DuckDB types to the 7 logical types. Map TIMESTAMPTZ to `timestamp` only
  if the session time zone is UTC, because `date_trunc` on TIMESTAMPTZ follows
  the session zone.
- Bind `params` positionally (`connection.run(sql, params)` works as is) and
  include `opts.pixelWidth` in the cache key along with the SQL and params.
- Auto bins use the profile's min/max, not the filtered range. Bins therefore
  stay put while other charts cross-filter this one.

## Tests

- `src/sql/compile.test.ts`: SQL snapshots per mark, identifier quoting with
  quotes, spaces, unicode, keywords and NUL, every `CompileError` path, and the
  bin and time-unit helpers. `src/spec/spec.test.ts` covers schema defaults and
  strictness.
- `test/compiler.property.test.ts`: fast-check, seed 20261017, 200 runs per
  property. Seven properties: filters (`compileWhere` and count), rows,
  bar, histogram, heatmap, line/area with M4, and scatter with its count.
  - **Data:** each run builds a random table with every type present, 0 to 60
    rows, NULLs, duplicates and hostile column names, loads it into in-memory
    DuckDB, runs the compiled SQL and compares the rows with a plain JS
    reference (`test/support/reference.ts`). Floats compare with 1e-9 relative
    tolerance.
  - **Exact ties:** generated numbers are k/8 (float) or k/100 (decimal), so
    the reference ranks aggregates with exact rationals and reproduces DuckDB's
    tie order exactly.
  - **Sanity check:** mutating the compiler (tie directions, NULL order, M4
    windows, pixel rounding, bound inclusivity, series cap, `x_end`) makes at
    least one property fail.
