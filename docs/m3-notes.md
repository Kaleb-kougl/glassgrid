# M3 notes: charts and cross-filtering

Status of milestone M3 after integrating its two parallel branches, dated
2026-10-18. Builds on [M2](m2-notes.md).

| Branch | What it built | Notes |
| --- | --- | --- |
| `m3-charts` | The chart layer in `@glassgrid/ui` (`packages/ui/src/charts`): Arrow adapter, scales, Canvas 2D line/area (M4 envelopes), histogram, heatmap, scatter with the shared WebGL overlay, brushes, hit-testing, tooltips, legends, `ViewData`; `BarChart` with colour series; the `bench:charts` Chromium benchmark | [m3-charts.md](m3-charts.md) |
| `m3-xfilter` | The cross-filter model in core (`selections`, `userFilters`, `viewQueries`, `crossfilterPlan`, chips, default chart rules), the `brush`, `setMark`, `addFilter`, `setColumnProfiles` commands, the compiler's `notIn` and "Other" bar, and engine cubes (`prepareCrossfilter`, hinted `aggregate`/`count`) | [m3-xfilter-notes.md](m3-xfilter-notes.md) |

The per-branch notes are kept as written. Where integration changed a
contract they describe, this file is authoritative.

## What M3 delivers

```
column dragged / Enter / "+ New chart" ──▶ addChart { columns }  (default chart rules, profile in state)
                                              │
pointer down on a chart ─▶ crossfilterPlan ─▶ engine.prepareCrossfilter (cubes for the other views, fire and forget)
brush move ─────────────▶ the chart's own draft (+ header summary, once per frame); no store update, no query
brush end / bar click ──▶ brush { viewId, selection | null }   (one undo entry; snapped by the command)
                                              │
                         viewQueries(state, { activeView })  ── activeView: changedSelectionView, or the chart under the pointer
                                              │
   charts: aggregate({ ...spec, pixelWidth }, { viewId: chart:<id>, crossfilter })   ── answered from cubes when hinted
   grid:   count({ filters, crossfilter }) + pageFetcher({ filters })               ── chips: filterChips(state)
```

- **One renderer per mark.** `views/ChartView.tsx` adapts each result once
  (`chartColumnsFromArrow`, plus `barDataFromArrow` over the same columns
  for bars) and renders `BarChart`, `LineChart`, `AreaChart`, `Histogram`,
  `Heatmap` or `ScatterChart`; a scatter the engine answered with its
  heatmap fallback renders `Heatmap` with the scatter's field names. The
  charts list sits in one `WebGLOverlayProvider`. Series colours are pinned
  per colour field (`colorKeys` = the first result's series, new ones
  appended), so filtering never recolours a chart. "View data" shows
  `ViewData` over the same adapted columns; tooltips come from the
  components (exact values).
- **Brushing end to end.** A chart's `selection` is its own clauses from
  `state.selections` (snapped by the command, so the brush redraws on bin
  edges after release). `move` only updates the card header ("2.00 – 6.00")
  once per animation frame; `end` dispatches `brush` with the raw extent, a
  cleared brush dispatches `brush null`. Bar clicks toggle through the same
  command (`in`, or `notIn` of the other named bars with the "Other" bar).
  Pointer down on any chart sends `prepareCrossfilter` with
  `crossfilterPlan`'s targets and the panel's `pixelWidth` (the same one
  the aggregates use). Every view queries with `viewQueries(state,
  { activeView })`; requests are scoped per `engineViewId`, so a newer one
  supersedes the stale one, and late replies are ignored by key.
- **Grid and chips.** The grid's pages and count use the grid's filters
  (the count with its cube hint); chips come from `filterChips(state)` and
  remove through the command each names. The row count reads "80,723 of
  1,000,000 rows".
- **Default charts.** Drag-to-chart, Enter on a column and "+ New chart"
  dispatch `addChart { columns }`. Two columns go together when both are
  selected in the grid and either is dragged (or "+ New chart" is pressed):
  that is how the heatmap of two numbers is made.
- **Card controls.** A mark switcher in the card's ⋯ menu (radio items;
  marks the columns cannot make are disabled, checked with `specForMark` and
  the compiler) dispatches `setMark`. The Color shelf takes a dropped column
  (`setShelf color`) and the legend lists the series; heatmaps colour by
  count. A column dropped on the card itself goes to Y (numbers), X (dates)
  or Color (categories). Shelves and titles show resolved bins and time
  units (`bin(trip_distance, 1)`, `hour(pickup_at)`).
- **"+ Filter"** (`views/FilterEditor.tsx`, rules in
  `filter-editor-model.ts`): column → condition (between, at least, at most,
  equals for numbers and dates; one of, none of for categories; is empty /
  is not empty) → value(s), validated as typed with the problem named next
  to the field; `addFilter` errors show in the form.
- **Loading and errors.** A query over 300 ms shows the skeleton on that
  card only ("Updating…"); until then the previous chart stays. Errors show
  the engine's message and the offending spec path.
- **Timings in the app.** `glassgrid:chart-create` (drop → the new chart
  drawn: `onDrawn` after its layers are painted), `glassgrid:crossfilter`
  (brush end → every other view painted with the new filters: each chart
  drawn, the count shown, the grid's first rows painted; per-view times,
  engine times and `fromCube` in the detail) and
  `glassgrid:crossfilter-prepare` (pointer down → cubes ready).

### Changes made during integration

- `@glassgrid/ui`: `onDrawn` on every chart (ChartFrame, BarChart); the
  "Other" bar (`x_other`) is read by the adapter (`isOther`, key
  `OTHER_BAR_KEY`, label "Other", neutral colour, last); `barDataFromArrow`
  takes adapted columns; `ChartCard` takes a `description` read after the
  title (cards with equal titles are distinct landmarks: "Line chart, 2 of
  4") and an open "View data" is a focusable, named region (axe
  `landmark-unique`, `scrollable-region-focusable`).
- Default titles per mark ("Rows over pickup_at", "Distribution of
  trip_distance", "Rows by trip_distance and fare_amount", "fare_amount
  against trip_distance"); bar titles are unchanged.
- E2E-only: `GLASSGRID_E2E_AUTO_CONVERT_MIN_BYTES` (main → engine config) to
  keep a 10M file on its raw CSV; `data-parquet` on the app root
  (`none`/`converting`/`ready`). Shared E2E helpers moved to
  `e2e/support.ts`.

### Chart-create fixes after the first exit-gate run

The first exit-gate run (below, "before") missed chart create for line and
heatmap. Three changes, same results:

- **Integer time-bucket keys** (compiler). On a zone-less `TIMESTAMP`
  column, line/area, histogram and heatmap time axes group hour buckets on
  `floor(epoch_us(ts) / 3.6e9)` (a `CASE` on the sign, since BIGINT `//`
  truncates; ±infinity get sentinel keys) and day buckets on
  `CAST(ts AS DATE)`, and turn the key back into the bucket start
  (`make_timestamp`, `CAST(… AS TIMESTAMP)`) on the aggregated rows only.
  The profile now tells the compiler the column's DuckDB type
  (`CompileColumn.duckdbType`, optional); TIMESTAMPTZ (whose `date_trunc`
  follows the session time zone), DATE, months, bar charts and callers
  without a type keep `date_trunc`. Bare GROUP BY on the 10M Parquet copy,
  2 threads: `date_trunc('hour')` 175–190 ms, the integer key 118 ms
  (truncating `//` alone 105 ms but wrong before 1970; `%`-based floors
  157–163 ms; `time_bucket` 190 ms); days 132 → 76 ms. See
  [m1-compiler.md](m1-compiler.md#group-keys).
- **One heatmap cell key** (compiler). When the profile bounds both numeric
  axes within ±2^24 bins, the heatmap groups on `gx * 2^26 + gy` (an exact
  DOUBLE) and decodes `gx`, `gy` after the GROUP BY; otherwise two keys as
  before. 10–15% off the heatmap query.
- **The hidden data table renders after the chart is painted** (ui).
  `ChartFrame` renders the screen-reader table (up to 300 formatted rows)
  through `useDeferredValue`: a new chart is drawn first, new data repaints
  the chart before the table follows. It was 10–25 ms of every line and
  heatmap create (drop → drawn minus engine time fell from 15–36 ms to
  7–10 ms) and of every cross-filter repaint of those charts (per-chart p95
  81.9 → 74.6 ms).

Engine query, measured in Node through `QueryService` + `runAggregate`
(the engine host's path) on the 10M Parquet copy, 25 fresh `fare_amount ≥ k`
filters, before/after alternated twice, p50 (p95):

| Chart | Before | After |
| --- | ---: | ---: |
| line, `hour(pickup_at)`, M4 at 600 px | 211 ms (250) | **138 ms** (166) |
| line, `day(pickup_at)` | 152 ms (190) | **89 ms** (115) |
| heatmap, distance × fare (360 cells) | 202 ms (264) | **178 ms** (220) |
| histogram / bar (unchanged SQL) | 140 / 50 ms | 133 / 52 ms |

What else was checked on the aggregate path, without a change:

- **Engine overhead** around the query is under 2 ms: the profile is cached
  per table, compiling is sub-millisecond, and the Arrow build of ≤ 744 rows
  is negligible; `runAggregate` times equal the bare query's.
- **Nothing runs beside a create.** With every engine request and index
  build logged during the exit gate, each create's aggregate ran alone; the
  grid's filtered index build finishes about 3.5 s after a filter is added
  (1.5 s delay + ~2 s), well inside the test's 6 s wait (kept).
- **Threads:** 2 (the default, one per core) is best: 1 thread is 80%
  slower, 4 threads 35% slower on the heatmap.
- **Caches and format:** `parquet_metadata_cache`, the external file cache
  (on, off, unvalidated) made no difference; a Parquet copy without
  dictionary encoding is 25–80% slower; a native in-memory DuckDB table
  (600 MB) is no faster for the heatmap. The heatmap is compute-bound: per
  EXPLAIN ANALYZE about 40 ms scan, 70 ms for the cell key (six vector ops)
  and 60 ms hash aggregation (wall, 2 threads).
- **Heatmap alternatives that were not faster:** two INTEGER or BIGINT
  keys, a combined BIGINT key, multiplying by the reciprocal, `fdiv`,
  `floor((x - lo) / w)` in a CTE (also not exact). DuckDB groups a single
  raw dictionary-encoded column about 4× faster (`GROUP BY trip_distance`
  44 ms; unary `floor`/`ceil`/`round(x, n)` keep that path), but any binary
  operation (`x / w`, even `x + 0`) or a second key loses it, and a heatmap
  needs both; perfect-hash aggregation needs column statistics, which
  DuckDB does not propagate through `floor(x / w)`.

## Exit gate

> Every v1 budget in Performance budgets green in CI, including chart create
> < 250 ms and cross-filter p95 < 100 ms.

`xvfb-run -a pnpm e2e:10m`, `crossfilter.spec.ts`: a 10,000,000-row
taxi-like CSV (`writeTripsCsv`: `pickup_at` over March 2024 with a daily
rhythm, 5 payment types, skewed `trip_distance` 0.01–30, `fare_amount`;
407 MB), opened in the app, **after the background Parquet copy is ready**
(uncompressed, as m3-xfilter left it). Four charts + the grid: line of
`hour(pickup_at)` (744 buckets, M4), bars of `payment_type`, histogram of
`bin(trip_distance, 1)`, heatmap of distance × fare (360 cells). Three runs
back to back on a quiet machine (Linux VM, 2 vCPU Xeon @ 2.1 GHz, 8 GB,
software rendering under Xvfb; Electron 44.9.0, Chrome 152, DuckDB 1.5.6).

- **Chart create** = a column dragged from the list and dropped on the
  charts panel → the new chart drawn. Per run and mark: the first create
  (cold) plus five more, each under a fresh user filter (`fare_amount ≥ k`
  through "+ Filter"), each chart removed before the next, so no create is
  a result-cache hit (asserted). After adding each filter the test waits
  6 s: 1.5 s after a filter settles the engine builds the grid's filtered
  row-number index in the background, and a chart created during that
  build shares the two cores with it (heatmap creates took 600+ ms then).
- **Cross-filter** = a mouse brush on the histogram (pointer down → 300 ms
  drag → release) → the last other view painted (3 charts drawn, the count
  shown, the grid's first rows painted). 20 brushes after a first one,
  300 ms apart, each a different range (wide, narrow, in the tail).

| 10M rows, Parquet, medians of 3 runs | p50 | p95 | Budget | Before the fixes (p50 / p95) |
| --- | ---: | ---: | --- | --- |
| Chart create, bar (`payment_type`) | **62.2 ms** | **88.8 ms** | < 250 ms ✓ | 73.6 / 87.2 ms |
| Chart create, histogram (`trip_distance`) | **153.6 ms** | **206.1 ms** | < 250 ms ✓ | 157.2 / 190.9 ms |
| Chart create, line (`pickup_at`, hourly, M4) | **166.8 ms** | **196.5 ms** | < 250 ms ✓ (runs 194.5, 196.8, 196.5) | 244.5 / 288.8 ms |
| Chart create, heatmap (distance × fare) | **198.7 ms** | 257.1 ms | < 250 ms ✗ at p95 (runs 257.1, 245.1, 261.0) | 238.4 / 266.0 ms |
| engine time per create (p50): line / bar / histogram / heatmap | 158 / 59 / 151 / 186 ms | | | 229 / 66 / 162 / 209 ms |
| Cross-filter, 20 brushes | **66.0 ms** | **80.5 ms** | p95 < 100 ms ✓ (runs: 94.7, 79.4, 80.5) | 70.7 / 98.8 ms |
| per view p95: charts / count / first page | | 74.6 / 48.0 / 79.3 ms | | 81.9 / 54.6 / 90.4 ms |
| First brush, cubes built at pointer down | 248.8 ms | | (runs: 263.1, 248.8, 197.9) | 349.6 ms |
| Cubes ready after pointer down | 681 ms | | 4 cubes: 17,343 / 153 / 360 / 31 cells | 781 ms |

80 of every 100 view answers came from cubes (the three charts and the
count; the grid's rows cannot be pre-aggregated).

**Raw CSV** (a second launch with the Parquet conversion off; the same
file): chart create is one cold sample per mark and run, so p50 = p95.

| 10M rows, raw CSV, medians of 3 runs | p50 | p95 |
| --- | ---: | ---: |
| Chart create: line / bar / histogram / heatmap | 1,123 / 830 / 817 / 1,086 ms | (n = 1 per run) |
| Cross-filter, 20 brushes | 67.6 ms | 93.6 ms (runs 74.6, 93.6, 111.5) |
| First brush, cubes built at pointer down | 5,037 ms | cubes ready after 5,568 ms |

On the raw CSV the cubes carry the brushes: once built (one full parse of
the file, 5–6 s), charts and count answer from them, and the grid's first
page of these brushes is found early in the file. A brush selective enough
that 1,000 matches sit deep in the file still costs a parse of most of it
(1.6–1.9 s in the m3-xfilter bench); that only happens before the Parquet
copy is ready.

**Result: cross-filter met with room (p95 80.5 ms); chart create met for
bar, histogram and line; heatmap met at p50 (198.7 ms) but not at p95
(257.1 ms median; 245–261 ms).** The line went from 245 / 289 ms to
167 / 197 ms. The heatmap's p95 is the slowest of six samples per run,
and on this VM one heatmap query in six or so takes 220–250 ms in the
engine instead of 175–190 ms: the run-to-run noise of a 2-vCPU VM (the
same spikes appear in the Node bench with nothing else running; the
engine logs show no concurrent work). Rendering is now 7–10 ms of a
heatmap create, so the query is the budget: the heatmap's aggregate is
compute-bound at about 175 ms on two 2.1 GHz cores (see "What else was
checked"), and no cheaper exact SQL was found. What it would take on this
VM: about 30 ms more off the heatmap query (DuckDB evaluating `x / w` over
a dictionary's values, as it already does for unary `floor`, would make it
a ~60 ms query), or a faster machine — these budgets are set for the CI
macOS arm64 runners and should be re-measured there. An app-side option
is to start the default chart's query when the drag starts (the spec is
known then), which hides the query behind the gesture for people but adds
queries for drags that end elsewhere.

Other figures from the same runs (no M2 regression): open → first rows
259–273 ms, sort → first sorted rows 173–201 ms, wheel/thumb fling p95 rAF
interval 16.7/16.7–16.8 ms, renderer working set 179–182 MB before and
181–184 MB after a full scroll. 1M default run (`pnpm e2e`, the raw CSV:
below the conversion size), last run: chart create p95 111–188 ms per mark
(the cold first create is the slowest), cross-filter p50 65.1 ms, p95
77.5 ms, first brush 64 ms.

JSON in [benchmarks/m3/](benchmarks/m3/): `m3-exit-gate-medians-linux-x64.json`
(the three runs after the fixes, medians, with each mark's engine p50) and
the last run's `m3-exit-gate-10000000-linux-x64.json` (milestone `M3`,
`exitGate` and `rawCsv` blocks, every sample with its per-view timings).
The numbers before the fixes are in git history (commit 316dad6).

## Tests

| Suite | Count | Result |
| --- | ---: | --- |
| `packages/core` | 212 tests, 16 files | pass |
| `packages/ui` | 223 tests, 28 files | pass |
| `apps/desktop` (engine on real DuckDB, renderer on jsdom) | 187 tests, 20 files (+2 opt-in benches skipped) | pass |
| E2E, 1M rows (`pnpm e2e`) | 11 tests (+1 skipped: the raw-CSV launch only runs at 10M) | pass |
| E2E, 10M rows (`pnpm e2e:10m`) | 12 tests | pass |

New in integration:

- `crossfilter.spec.ts`: four linked charts by drag-to-chart; a bar click
  and a mouse brush cross-filter every other view; the grid's count, the
  filters and every bar match an independent DuckDB over the CSV
  (`e2e/sql-reference.ts`); chips, undo and redo; axe with every mark on
  screen (line, area, bar, histogram, heatmap, scatter, "View data" open)
  in both themes: **0 violations**; the exit gate (above).
- App tests: a histogram from a number column, `prepareCrossfilter` on
  pointer down with the plan's targets, a keyboard brush through the `brush`
  command, the bar chart re-queried with the cube hint, the count's hint,
  undo; the mark switcher (disabled marks, `setMark`) and the Color shelf;
  two selected columns → a heatmap; the "+ Filter" editor (validation,
  `addFilter`, chip removal).
- Unit tests for the selection mapping (intervals, bar toggles with
  "Other"), the filter editor's rules, the cross-filter timing, view keys
  and pixel widths; ui tests for `onDrawn`, the "Other" bar and the card's
  name and data region.

New with the chart-create fixes:

- `packages/core/test/fast-keys.property.test.ts`: the line/area,
  histogram and heatmap reference properties rerun with DuckDB types in
  the profile (integer keys, one cell key), and their cube answers against
  the plain query; old vs new SQL compared exactly (column names, DuckDB
  types, every value, order) on edge data: microseconds either side of
  hour/day/month edges and of the epoch, 1900 and leap days, years 1 to
  9999, DuckDB's first and last timestamps (where a bucket end overflows,
  both fail), ±infinity, NULLs, empty and single-row tables. Mutating the
  floor branch or the cell stride fails them.
- Compiler snapshots and shape tests for the new keys (and that
  TIMESTAMPTZ, DATE, months, bars and untyped profiles keep `date_trunc`;
  that unbounded or time heatmap axes keep two keys); an engine test that
  the real profile carries `TIMESTAMP` and that hour/day buckets match UTC
  buckets on both sides of the epoch; a ui test that a chart is drawn
  before its hidden table renders.

## Deviations

- **Selections are drawn from the store after the command snapped them**,
  so a released brush jumps outwards to bin edges (the chart keeps its draft
  until the snapped selection arrives).
- **The first brush on an axis waits for its cubes** (the integration
  checklist's design: hints are sent as soon as the view is active). On 10M
  Parquet that is 0.3–0.6 s; on the raw CSV 5–6 s.
- **pixelWidth is one per panel** (the list's width × DPR, rounded to 50),
  not per card: all cards share the panel's width.
- **Two-column charts come from a grid selection**, not from dropping a
  second column on a card (which sets a shelf). See
  [design/README.md](design/README.md) for the visual deviations.
- **Chart create is timed under a user filter after the engine settles**
  (see the exit gate), to keep every sample uncached and measure the
  chart, not the grid's background index build.

## Gaps for M4 and later

- **Heatmap chart create on 10M rows** misses 250 ms at p95 on the 2-core
  VM (257 ms median of three runs; p50 199 ms). The query is the cost
  (above); remaining options: measure on the CI runners the budgets are
  set for, start the default chart's query at drag start, or a DuckDB that
  evaluates `x / w` over dictionaries. A two-stage histogram (GROUP BY the
  raw dictionary-encoded column, then bin its few thousand values) would
  take the histogram from ~140 to ~50 ms; not done, since it only pays
  for low-cardinality columns and the histogram meets its budget.
- **Cross-filter p95** has room now (80.5 ms median of three; one run
  94.7 ms). The grid's first page is still the slowest view (p95 79 ms).
- **The first brush waits for its cubes**; a plain query for the first
  commit while cubes build (and hints once `crossfilterPrepared` arrives)
  would make the first brush as fast as the SQL path at the cost of two
  scans competing.
- **No unit menu on the X chip** (hour/day/month), no bin-width control,
  no facets; the line's default unit is the finest that fits (hourly for a
  month).
- **WebGL scatter at 1M points** still needs a hardware GPU to verify
  (m3-charts notes); the E2E scatter is a Canvas 2D one (a few thousand
  points under the brush).
- **Persistence (M4):** `selections` and `userFilters` are workspace state
  and should be saved with the charts; the active view, brush drafts and
  cubes are session state and are not.
- The parse-error card still shows the engine's message (no line/column).
