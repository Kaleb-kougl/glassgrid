# M3 notes: cross-filtering, default charts and the brush cube

Branch `m3-xfilter`, dated 2026-10-18. Builds on [M2](m2-notes.md). The
chart renderers (`packages/ui`) are built in parallel on `m3-charts`; this
branch is the model, the commands, the compiler and the engine underneath
them, plus the minimum renderer changes to keep the app and its E2E green.

| Goal | Result |
| --- | --- |
| Cross-filter model in core | `selections` per view and `userFilters` in workspace state; `viewQueries` gives every view its query inputs (never its own selection), a stable key and a cube hint; chips derived from the same model |
| Commands | `brush`, `setMark`, `addFilter`, `setColumnProfiles` (new); `addChart { columns }` with the default chart rules; `setFilter` / `clearFilter` reconciled with selections and chips |
| Cross-filter p95 < 100 ms, 4 charts + grid, 10M rows | **Parquet: p50 35.5 ms, p95 87.3 ms** (was 618 / 963 ms on the M2 engine). Raw CSV (no Parquet copy): p50 109 ms, p95 1.9 s, bound by the grid's first page |
| Count and first page under filters | Count from a cube (p95 39 ms at 10M); first page reads only the page it needs (p95 87 ms at 10M on Parquet) |

## The model (`packages/core/src/crossfilter`)

```
WorkspaceState
  selections: { [viewId]: Selection }      viewId = chart id | "grid"
  userFilters: [{ id, filter }]            chips not tied to a chart ("+ Filter", agents)
  columns[i].profile?: { type, distinctCount, nullFraction, min, max }

Selection = { source: 'brush' | 'click' | 'filter', clauses: [{ channel: 'x' | 'y' | null, filter }] }  (1 or 2 clauses)
```

- **Rule:** a view queries with every user filter, then every other view's
  selection (charts in order, then the grid). Never its own. The grid's own
  selection (e.g. a future "filter to these cells") filters the charts, not
  the grid. `effectiveFilters(state, viewId)`; pass `null` for a consumer
  that is not a view (an export), which gets everything.
- **Per-view query inputs:** `viewQueries(state, { activeView? })` returns
  `{ grid: { filters, engineViewId: 'grid', crossfilter, key }, charts: [{ chartId, spec, engineViewId: 'chart:<id>', filters, crossfilter, key }] }`.
  `spec.filters` is the chart's own filters followed by the cross-filters.
  `key` is the JSON of the inputs (not the hint): re-query when it changes.
  With `activeView` (the view being brushed) every other view gets a
  `crossfilter` hint `{ filter, dimension }`: the index of the active
  selection in that request's filters and how the active view bins its
  axis. `changedSelectionView(before, after)` names the view whose
  selection changed, for the integration to track `activeView`.
- **Brush start:** `crossfilterPlan(state, chartId, channel?)` gives the
  dimension and the cube targets (every other chart's spec and the grid's
  count filters, without the brushed chart's selection) for
  `prepareCrossfilter`.
- **Brush to filter** (`brush.ts`, used by the `brush` command):
  - binned axes (histogram, heatmap, time buckets on line/area/bar) snap
    outwards to whole bins: `[lo, hi)`, `minInclusive: true,
    maxInclusive: false`. Numeric edges are `binStart(k, width)`: the
    smallest double with `floor(v / width) >= k`, i.e. `k * width` except
    where that product rounds across the edge (17 × 0.1 is
    1.7000000000000002, but 1.7 is in bin 17). So a brush selects exactly
    the rows the histogram draws in those bins. Time edges are bucket starts,
    written as DuckDB text (`2024-03-03` for DATE, `2024-03-03 00:00:00` for
    TIMESTAMP).
  - raw axes (scatter, a line over raw numbers or with automatic numeric
    bins, whose width depends on the plot width) are inclusive `[min, max]`.
  - bar clicks are `in`; with the "Other" bar, `notIn` of the shown bars that
    were not clicked. A click on a time-bucketed bar is that bucket's range.
  - a 2-D brush (heatmap, scatter) is two clauses (x and y).
  - the bin width and time unit are resolved exactly as the compiler does
    (`resolveAxis`), from the profile recorded in state.
- **Chips:** `filterChips(state)` lists user filters then each selection
  clause: `{ id, viewId | filterId, column, condition, label, filter, remove }`.
  Labels are formatted by column type: `trip_distance 2.00 – 6.00`,
  `payment_type = Cash`, `zone not in Midtown, SoHo`, `pickup_datetime
  2024-03-03 – 2024-03-06`. `remove` is the command to dispatch
  (`clearFilter { viewId }`, `{ viewId, channel }` for one axis of a 2-D
  brush, or `{ filterId }`), so removing a chip clears its brush.
- **Default charts** (`defaultChartSpec`, used by `addChart { columns }`):

  | Columns | Chart |
  | --- | --- |
  | date/timestamp | line of row counts, automatic time bucket (the compiler's: finest of hour/day/month with ≤ 20,000 buckets) |
  | category (text, boolean), ≤ 50 distinct | bar sorted descending, `limit: 50` |
  | category, > 50 distinct, or no profile | bar `limit: 20, other: true` (top 20 + "Other") |
  | number | histogram, `bin: 'auto'` |
  | number + number, date + date | heatmap, both axes `bin: 'auto'` |
  | date + number (either order) | line of `sum(number)` |
  | date + category | line split by colour |
  | category + number | bar of `sum(number)` (limit as above) |
  | category + category | bar split by colour |
  | number + category | histogram split by colour |

  A profile is used only while it is current (`currentProfile`: computed for
  the column's effective type).

### Compiler additions (`packages/core/src/sql`)

- `notIn` filter: rows whose value is not listed; NULL cells match unless
  `null` is listed (so it is exactly the "Other" bar). Empty list: all rows.
- `ChartSpec.other` (bar only): x values beyond the top `limit` fold into one
  bar with `x` NULL and `x_other` TRUE, measured over its own rows. Works
  with colour. Result columns: `x, x_other, [color, color_other,] y`, Other
  last.
- Cube modes (`cube.ts`), next section. All three are covered by the
  DuckDB-vs-reference property tests (`test/compiler.property.test.ts` for
  `notIn` and `other`, `test/cube.property.test.ts` for cubes).

## Commands

All in `ALL_COMMANDS`; parity test green.

| Command | Tier / MCP | Notes |
| --- | --- | --- |
| `brush { viewId, selection \| null }` | edit, MCP | `selection`: `{ type: 'interval', x?: {min?, max?}, y?: {min?, max?}, column? }` or `{ type: 'points', values, other?: { shown }, column? }` (`column` only for the grid). One undo entry per commit; the UI dispatches it on brush **end** only. Rejects gestures the view cannot make with the path and a fix (`points` on a histogram, `y` on a bar, a value of the wrong type, validated with `compileWhere`). `null` clears. |
| `setMark { chartId, mark }` | edit, MCP | Re-derives shelves (`specForMark`): x stays; y keeps its aggregate on bar/line/area/histogram and becomes the second axis on heatmap/scatter (and back to count); bins and time units kept where the mark takes them; colour dropped on heatmap; `limit`/`other` only on bar. Validated with `compileChartQuery`; the chart's own selection is cleared if the new mark could not have made it. Same mark: no-op. |
| `addChart { spec, title? } \| { columns: [a] \| [a, b], title? }` | edit, MCP | The columns form applies the default chart rules and validates with the compiler. The spec form is unchanged (no compiler validation, as before). |
| `addFilter { filter }` | edit, MCP | A filter chip not tied to a view; id `filter_*` is the last entry of `userFilters`. Validated against column types. At most 64. |
| `setFilter { viewId, filter }` | edit, MCP | Unchanged contract; now stores a one-clause selection (`source: 'filter'`, channel x/y when the column is on that axis) and validates the value types. |
| `clearFilter { viewId, channel?, column? } \| { filterId }` | edit, MCP | Clears a selection, one axis of it, or a user filter. Nothing to clear records nothing. |
| `setColumnProfiles { columns: [{ name, type, distinctCount, nullFraction, min, max }] }` | edit, **MCP-exempt**, `undoable: false` | Records the engine profile in state. Exempt for the same reason as `openFile` (engine-produced input); agents read profiles through `get_state`. |
| `removeChart` | | Also removes the chart's selection (as before, now in `selections`). |
| `openFile` | | Resets `selections` and `userFilters`. |

## Engine: the brush cube

Mosaic-style pre-aggregation for the active brush dimension, decided by
measurement (below): without it a 10M-row brush took 0.6 to 1 s.

**What a cube is.** For a view V and the brushed dimension d (a column plus
its binning: `width` bins, `time` buckets or raw `value`s), one query
`SELECT <V's group keys>, <bin of d> AS gb, count(*) AS n[, count(y) AS nn,
sum(y) AS s, min(y) AS mn, max(y) AS mx] FROM table WHERE <V's other filters>
GROUP BY ALL` (`compileChartCubeBuild`; `compileCountCubeBuild` for the grid
count, keyed by `gb` only). Group keys are exactly the chart's: bars' x,
histogram bins, time buckets, heatmap cells, colour series. All supported
aggregates decompose: count and sum add, avg is `sum(s) / sum(nn)`, min and
max take the min and max of the cells. Only scatter (raw points) cannot be
pre-aggregated.

**Answering.** A brush on d whose selection is aligned to the bins
(`cubeSelection`: width bins at `binStart` edges, time ranges at bucket
starts, any filter for value dimensions, isNull/notNull for all) is
answered by `compileChartCubeAnswer`: the chart's own SQL, with `__gg_base`
re-summing the partials of the cells whose `gb` the selection covers and
every aggregate reading partials instead of rows. Same columns and row order
as the plain query; numbers equal up to floating-point summation order
(integer and decimal sums are exact). Colour ranking, top N, "Other" and M4
all run on the re-summed cells.

**Storage and lifetime** (`apps/desktop/src/engine/cubes.ts`,
`QueryService.cube`). A cube is a table in the brushed table's own DuckDB
instance, named after a digest of (table, file fingerprint, type overrides,
build SQL), so equal inputs share one cube and a type change never serves an
old one. LRU: 48 cubes or 6M cells in total. Builds are skipped when the
profile estimates more than 4M cells, and dropped after the build above 1M
cells (both then run the plain query). Cubes are dropped on a type change, a
changed file, `clearCache('results' | 'all')` and with the table. A build
runs to completion even when every request waiting on it is superseded (the
next brush on the same axis wants the same cube); callers still return at
once on abort.

**Protocol** (`packages/core/src/protocol/engine.ts`):

| Message | Change |
| --- | --- |
| `aggregate` | optional `crossfilter: { filter, dimension }`: `spec.filters[filter]` is the brushed selection. Reply carries `fromCube`. |
| `count` | same, with `filters[filter]`. Reply carries `fromCube`. |
| `prepareCrossfilter { viewId, seq, table, dimension, targets: [{ kind: 'aggregate', spec } \| { kind: 'count', filters }] }` | new, view scoped. Builds (or finds) the cubes; answers `crossfilterPrepared { cubes: [{ status: 'ready', rows } \| { status: 'skipped', reason }] }`. |

A hint the engine cannot use (unaligned selection, too large, scatter, an
index out of range, any failure answering from the cube) silently falls back
to the plain query, so a hint is never wrong to send. Superseding is
unchanged: requests are still view scoped by `chart:<id>`, `status`, `grid`;
`prepareCrossfilter` uses its own view (`brush` by default in the client).
Result-cache keys: the plain path keys by compiled SQL and parameters
(filters included, as before); cube answers by cube name (which digests the
base filters) plus the answer SQL and parameters (the selection).

**Client** (`engine-client.ts`): `aggregate(table, spec, { viewId, crossfilter })`,
`count(table, { viewId, filters, crossfilter })` (results have `fromCube`),
`prepareCrossfilter(table, { dimension, targets }, { viewId? })`.

### Other engine changes for the grid under filters

- **Count** of the grid under a brush comes from the count cube (42 cells
  for the bench's histogram).
- **First page of a filtered, unsorted view** now reads only the requested
  page (`LIMIT 1000` streaming in file order) instead of the 5,000-row top-K
  block; the block is read when a later page asks. On a selective brush the
  scan to find 5,000 matches costs up to 5x more than to find 1,000.
- **Filtered row-number indexes wait for the filter to settle**
  (`filteredIndexDelayMs`, default 1.5 s, or until a page past the first
  needs the index). M2 started one per new filter, so every brush started a
  full sort-and-materialize that competed with the next brush.
- **The Parquet cache is written uncompressed** (`PARQUET_COMPRESSION`;
  DuckDB still dictionary- and RLE-encodes). On the 10M fixture a filtered
  page that must scan the whole file took 263 ms with zstd, 158 ms with LZ4
  and 100 ms uncompressed; a cube build 1.3 s vs 0.7 s. The file is 1.65x
  the zstd size (135 MB vs 82 MB for a 459 MB CSV); writing it takes the
  same time. Existing zstd copies stay valid and are used as they are.

## Numbers

Machine: Linux VM, 2 vCPU Xeon @ 2.1 GHz, 8 GB (the M2 machine), DuckDB
1.5.6, Node 24. Fixture: `writeTaxiLikeCsv` (`pickup_datetime` over 91 days,
skewed `trip_distance` 0 to 20.7, `fare_amount`, 5 `payment_type` values,
`passenger_count`, 265 `PULocationID`s); 1M rows = 46 MB, 10M = 459 MB CSV.
Four charts: trip_distance histogram (brushed; auto width 0.5), payment_type
bar, pickup_datetime line (hourly, 600 px, M4), PULocationID bar of
sum(fare_amount) top 20 + Other; plus the grid's count and first page. One
brush = commit → the three other charts, the count and the first page, sent
at once; timed to the last reply. "CSV" opens with `parquet: 'never'` (the
raw-CSV worst case; in the default `auto` mode a 10M CSV is converted in the
background at open).

**Before: the M2 engine** (`a63cc24`, first version of the bench: the same
charts and requests with hand-built bin-aligned ranges of 1 to 12 bins in the
data's first 25 bins, 300 ms between brushes):

| ms, 20 brushes | p50 | p95 |
| --- | ---: | ---: |
| 1M Parquet | 75.5 | 106.7 |
| 1M CSV | 601 | 763 |
| 10M Parquet | 618 | 963 |
| 10M CSV | 4,958 | 5,589 |

**After** (`crossfilter-bench.test.ts`, driven by the core model:
`crossfilterPlan` → `prepareCrossfilter` at pointer down, 300 ms drag,
`brush` command, `viewQueries`; brushes start anywhere in 0 to 30, 0.5 to
12.5 wide, so a third select little or nothing; 300 ms between brushes).
`sql` sends no hints (all other engine changes included); `cube` sends them.
The first brush of a `cube` run waits for the cubes `prepareCrossfilter`
started 300 ms earlier.

| ms | p50 | p95 | first brush | cubes ready after | p95 per view (charts / count / first page) |
| --- | ---: | ---: | ---: | ---: | --- |
| 1M Parquet, sql | 91.0 | 116.8 | 112 | | 88–117 / 86 / 82 |
| **1M Parquet, cube** | **43.1** | **73.2** | 54 | 179 | 43–73 / 36 / 63 |
| 1M CSV, sql | 1,063 | 1,481 | 914 | | 1,082–1,402 / 1,481 / 1,420 |
| **1M CSV, cube** | **83.5** | 465 | 869 | 1,177 | 62–95 / 65 / 438 |
| 10M Parquet, sql | 219 | 637 | 524 | | 429–637 / 324 / 318 |
| **10M Parquet, cube** | **35.5** | **87.3** | 1,303 | 1,606 | 40–61 / 39 / 87 |
| 10M CSV, sql | 5,034 | 9,080 | 5,050 | | 5,050–9,080 / 8,656 / 6,415 |
| **10M CSV, cube** | **109** | 1,872 | 9,302 | 9,602 | 117–123 / 112 / 1,872 |

Cube sizes for the bench: payment bar 210 cells, pickups line 86,405, zones
bar 11,109, count 42. An intermediate 10M Parquet run with cubes but before
the three grid changes above had p50 83 / p95 262 ms, cubes ready after 7.9 s
(zstd, and index builds competing). JSON:
[benchmarks/m3/](benchmarks/m3/) (`crossfilter-m2-baseline-*`,
`crossfilter-1000000-*`, `crossfilter-10000000-*`,
`crossfilter-intermediate-*`).

**Reading them.** With cubes, every chart and the count stay under 65 ms at
10M on Parquet (about 120 ms on raw CSV); the budget is then the grid's
first page. On Parquet it meets the
budget (p95 87 ms). On a raw CSV a selective brush must parse most of the
file to find 1,000 matching rows (1.6 to 1.9 s at 10M); that only happens
before the background Parquet copy is ready. The first brush after brush
start waits for the cubes (1.3 s at 10M Parquet on 2 cores); later brushes on
the same axis reuse them. Run it:

```sh
GLASSGRID_XF_BENCH_ROWS=10000000 GLASSGRID_XF_BENCH_CSV=/tmp/taxi-10m.csv \
  pnpm --filter @glassgrid/desktop exec vitest run src/engine/crossfilter-bench.test.ts
# GLASSGRID_XF_MODES=sql,cube  GLASSGRID_XF_SOURCES=parquet,csv  GLASSGRID_BENCH_LABEL=<tag>
```

## Tests

| Suite | What |
| --- | --- |
| `core/src/crossfilter/crossfilter.test.ts` | Default rules (table-driven, 16 cases, each compiled), stale and missing profiles, `setColumnProfiles` (no undo entry, AI refused), brush snapping (numeric, `binStart` edges, time, 2-D, raw, bar points, Other, time bucket click), gesture errors, grid selections, composition and hints, `crossfilterPlan`, chips and labels, chip removal (2-D axis), `addFilter` validation, `setMark` re-derivation and selection clearing |
| `core/src/crossfilter/model.property.test.ts` | fast-check: a view never queries with its own selection and gets every other selection and user filter exactly once; hints point at the active selection; chips list every filter once and removing any chip removes exactly that filter (and undo restores it); numeric and time brushes snap outwards to the fewest whole bins and are cube-aligned |
| `core/test/cube.property.test.ts` | fast-check on random tables in DuckDB: bar/histogram/heatmap/line cubes answer exactly like the plain query with the brush added (width, time and value dimensions; NULL tests); the count cube equals the reference count; bin-start edges select exactly the histogram's bins; equal filter sets build equal cubes |
| `core/test/compiler.property.test.ts` | now generates `notIn` filters and `other` bars against the JS reference |
| `desktop/src/engine/crossfilter.test.ts` | fast-check end to end: random brushes through the core model on a 10-chart workspace over random data (CSV and Parquet); every hinted view answered from its cube equals the plain query (about 78% of chart answers came from cubes); plus prepare/reuse (no rebuild across brushes), invalidation on a type change, skips (scatter, unaligned, bad index), a superseded request whose build still completes |
| protocol and client tests | new schemas; `prepareCrossfilter`, hinted aggregate and count over a MessageChannel |

Mutation checks: breaking the cube's avg merge fails both the core and the
engine property tests; reverting `binStart` to `k * width` fails the edge
test; flipping the Other bar's order or the `notIn` NULL rule fails the
compiler property test.

Totals: core 198 tests (15 files), ui 141 (unchanged), desktop 173 + 2
opt-in benches skipped (21 files). `xvfb-run -a pnpm e2e`: 7 passed.

## For integration

- **Brush end → command.** On pointer release dispatch `brush { viewId:
  chartId, selection }` with the raw extent in data units (the command
  snaps); moves stay local UI state. Bar clicks: `brush { type: 'points',
  values }` (the current `ChartView` already does this), with `other: {
  shown }` when the Other bar is clicked. Draw the committed brush from
  `state.selections[chartId].clauses` (snapped extents).
- **Brush start → cubes.** On pointer down: `const plan =
  crossfilterPlan(state, chartId, channel)`, then
  `engine.prepareCrossfilter(table, { dimension: plan.dimension, targets })`,
  adding each aggregate target's `pixelWidth`. Fire and forget.
- **Per-view queries.** Track `activeView` (`changedSelectionView(prev,
  next)` on every state change, or the chart being brushed) and use
  `viewQueries(state, { activeView })`: charts → `engine.aggregate(table,
  { ...query.spec, pixelWidth }, { viewId: query.engineViewId, crossfilter:
  query.crossfilter })`; the grid → `pageFetcher(table, { viewId: 'grid',
  sort, filters: grid.filters })` and `engine.count(table, { viewId:
  'status', filters: grid.filters, crossfilter: grid.crossfilter })`.
  Re-query when `query.key` changes. Pass the same `pixelWidth` in the
  prepare target and in the aggregate, or line charts with automatic numeric
  bins get a different cube.
- **Chips.** Render `filterChips(state)` (`App.tsx` does already); removing a
  chip dispatches `chip.remove.command` with `chip.remove.input`, which
  clears the brush. The "+ Filter" editor dispatches `addFilter`.
- **Drag to chart.** Dispatch `addChart { columns: [column] }` (or two
  columns dropped together) instead of `barSpecFor` in `App.tsx`; the new
  chart may be a histogram, line or heatmap, so `ChartView` needs the new
  renderers. A mark switcher dispatches `setMark`.
- **Profiles.** `App.tsx` now dispatches `setColumnProfiles` when a profile
  arrives (also after type changes and after undoing back to a file).
- **Renderer changes made here** (merge with `m3-charts`): `App.tsx` reads
  `selections` / `filterChips` / `effectiveFilters` instead of `filters`;
  `ChartView` clicks dispatch `brush`; `describe.ts` labels the new commands
  and `notIn`; `engine-client.ts` gained the cross-filter options. The old
  `state.filters` record is gone, so leftover uses fail to compile.

## Not done / follow-ups

- **CSV before its Parquet copy:** a selective brush's first page parses most
  of the file. Cubes keep the charts and count fast; the page would need
  a copy clustered by the brushed dimension, or waiting for the background
  conversion.
- **2-D brushes** (two clauses) are answered with SQL; a cube over two
  dimensions would be bins² larger.
- **Scatter** is never pre-aggregated (raw points); its heatmap fallback
  could be.
- **Cube builds are one scan each.** Targets that share their base filters
  (the usual case) could be built in one scan with grouping sets.
- The 1.5 s index delay and the cube limits are constants measured on the
  2-core VM; re-measure on the CI runners.
- `addChart { spec }` still accepts specs the compiler rejects (unchanged
  M1 behaviour); only the columns form and `setMark` validate.
