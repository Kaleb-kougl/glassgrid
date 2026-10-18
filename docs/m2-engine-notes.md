# M2 notes: query engine

Engine work for milestone M2 on branch `m2-engine`, dated 2026-10-17. It
builds on [M1](m1-engine-notes.md) and closes the engine gaps listed in
[m1-notes.md](m1-notes.md#known-gaps-carried-to-m2-and-later): slow first
sorted pages and deep pages on CSV, type overrides that never reached the
engine, DECIMAL/TIME/INTERVAL as text, and DuckDB's external access, which
was still open.

| Goal | Result |
| --- | --- |
| Fast first sorted page | First 5,000 rows come from one top-K query; the row-number index builds in the background. 10M rows: 6.0 s to 2.3 s on CSV, 2.5 s to 0.28 s on Parquet. Identical rows on both paths (property test). |
| Deep pages on raw CSV | A deep unsorted page uses the Parquet copy, converting on demand. Every page after that takes 8 to 16 ms at 10M rows (was 1.2 to 3.5 s). |
| Type overrides reach the engine | New `setColumnTypes` request: `TRY_CAST` per column, failed-cast counts, caches and indexes invalidated, profile and compiler see the new types. |
| Arrow types | DECIMAL to Decimal128, TIME to Time64, INTERVAL to Interval(MONTH_DAY_NANO). The renderer formats them as DuckDB prints them. |
| Page fetch contract | `fetchPage(offset, limit, signal)` per view: concurrent pages, coalescing in the client and engine, aborts reach DuckDB, cache keys cover sort, filters and overrides. A superseded page is rejected within 1 ms. |
| Security | Each table gets its own DuckDB instance with `enable_external_access = false`, an allowlist (its file and the Parquet cache) and `lock_configuration = true`. Tests check that other paths, URLs, extension installs, writes and `SET` are refused. |

## For integration

### Protocol (`packages/core/src/protocol/engine.ts`)

| Message | Change |
| --- | --- |
| `rows` | New optional `concurrent: true`. A concurrent page neither supersedes nor is superseded by other requests of its `viewId`. The grid cancels pages it no longer needs. `viewId` still ties the page to its view's sort index, so a background build keeps running while the view pages. |
| `setColumnTypes { table, overrides: [{ column, type }] }` | New request (not view scoped). `overrides` is the **complete** set: columns not listed, or listed with their inferred type, are read as inferred. Duplicate columns are rejected (`bad_request`); unknown columns give `unknown_column`. |
| `columnTypes { table, columns: [{ column, type, duckdbType, failedCasts }], engineMs }` | Reply to `setColumnTypes`, one entry per requested override in request order. `failedCasts` counts non-NULL source values that did not convert and now read as NULL. A `tableUpdated` event is broadcast as well. |
| `TableHandle.typeOverrides?` | The overrides the engine currently applies. `columns` carries the effective types. |
| `ColumnTypeOverride`, `ColumnTypeResult`, `MAX_TYPE_OVERRIDES` | New exported schemas and types. |

### Client (`apps/desktop/src/renderer/src/engine-client.ts`)

```ts
// One fetcher per grid view; make a new one when sort or filters change.
const fetchPage = engine.pageFetcher(tableId, { viewId: 'grid', sort, filters });
const page = await fetchPage(offset, 1000, controller.signal); // RowsResult { table, engineMs, cached }

// Or directly:
await engine.fetchPage(tableId, { offset, limit, sort }, { viewId: 'grid', filters, signal });

// Type overrides: the complete set from workspace state.
const result = await engine.setColumnTypes(tableId, [{ column: 'code', type: 'integer' }]);
result.columns; // [{ column: 'code', type: 'integer', duckdbType: 'BIGINT', failedCasts: 2 }]
result.table;   // TableHandle with effective column types and typeOverrides
```

- **`fetchPage` semantics.** Pages of one view run side by side. Identical
  in-flight requests (same table, view, offset, limit, sort and filters)
  share one round trip. Aborting a page rejects that caller with
  `cancelled` (`isAbandoned` is true). The client sends `cancel` and the
  engine interrupts DuckDB only once every caller of that page has
  aborted. An already-aborted signal rejects without a round trip.
- **Wiring `setColumnType`.** After the command changes state (including
  undo and redo), call `engine.setColumnTypes(table, overrides)` with every
  column whose `typeOverride` is not null. Then refetch the grid pages,
  profile, counts and charts. The engine has already dropped its cached
  results, top-K blocks and sort indexes for that table. Show
  `failedCasts` to the user, e.g. "2 values could not be read as
  integer and are shown empty". The engine forgets overrides when it
  restarts (tables reopen with inferred types). After `engine_restarted`,
  or when `table.typeOverrides` differs from the workspace, send the set
  again.
- **New Arrow types to format.** DECIMAL is `Decimal` (bitWidth 128;
  precision and scale on the field type). `vector.get(i)` returns four
  little-endian 32-bit words of the unscaled integer. TIME is
  `Time64<MICROSECOND>` (bigint µs since midnight); TIME_NS is
  `Time64<NANOSECOND>`. INTERVAL is `Interval<MONTH_DAY_NANO>`, and
  `get(i)` returns an `Int32Array` `[months, days, nanos lo, nanos hi]`.
  The renderer helpers live in `apps/desktop/src/renderer/src/arrow-values.ts`:
  `valueKind(field)` now also returns `decimal:<scale>`, `time`, `timeNs`
  and `interval`, and `displayValue` uses `decimalUnscaled` /
  `formatDecimal`, `formatTime` and `formatInterval`. Its output matches
  DuckDB's `CAST(x AS VARCHAR)` exactly (tested). `filterValue` turns a
  decimal into its nearest double, as the compiler compares numerics as
  DOUBLE. `packages/ui` was not changed. If the canvas grid formats cells
  itself, it should use these helpers. Apache Arrow's own `bigNumToBigInt`
  loses precision on negative 128-bit values.
- **Unchanged:** `rows` without `concurrent` still supersedes per view, as
  before. The profile panel, counts and charts keep their M1 calls.

## Paging

### Sorted and filtered views: top-K block, then the index

M1 built a row-number table, `row_number() OVER (ORDER BY <keys>, __gg_ord)`,
before it served the first sorted page. That took 6.0 s at 10M rows on CSV
and 2.5 s on Parquet. Now (`QueryService.rows`, `sort-indexes.ts`):

1. A page that ends within the first `TOP_K_MAX_ROWS = 5,000` rows comes
   from a **top-K block**. One query,
   `SELECT ... ORDER BY <keys>, __gg_ord LIMIT 5000` (with the filter if
   any), returns the first 5,000 rows. DuckDB plans it as a heap top-N in
   a single scan. The block is cached (result cache, versioned key), and
   every page inside it is an Arrow slice of the block: 1 ms for the
   second page instead of another scan. A filtered view that is not
   sorted uses a streaming `LIMIT` in file order, which stops early.
2. When the block has been served, the view's index starts building in
   the background. It starts after the block so the two do not compete
   for the same cores. Pages past the block wait for the index, and the
   wait can be aborted. If the block holds fewer than 5,000 rows (a
   selective filter), it is the whole view, and no index is built.
3. Once the index exists, pages are `__gg_rn` range reads, as in M1
   (5 to 7 ms at any depth).

**Why 5,000.** DuckDB uses its TopN operator only when `LIMIT + OFFSET`
is at most 5,000, or at most 0.7% of the estimated input. A CSV scan is
estimated at about 42 rows, so a deeper top-K becomes a full sort that
costs about as much as building the index. Measured at 10M rows on CSV:
`LIMIT 1000` took 2.0 s, while `LIMIT 1000 OFFSET 9000` and
`OFFSET 49000` took 4.1 to 4.3 s. Hence one block of exactly 5,000 rows.

**Identical results.** Both paths order by the sort keys (NULLs last in
both directions), then by `__gg_ord`, the file position. That is
`file_row_number` on Parquet and `row_number() OVER ()` on CSV, which is
unique. The order is total, so the block slice and the range read return
the same rows. `paging.test.ts` checks this with fast-check (seed
20261017, 60 runs). It uses random tables of 0 to 120 rows with NULLs,
duplicates and ties, 0 to 3 sort keys, `in`/`range`/`notNull` filters,
random offsets and limits, on CSV and Parquet. Three services are compared:
top-K forced, index forced, and `auto` with a 40-row block, so pages cross
the block boundary. Unfiltered results are also checked against a JS
reference order. Mutating the top-K tie-break (`__gg_ord DESC`) makes the
property fail within 14 runs. A 300k-row test compares block pages and
index pages at offsets up to the end, and filtered unsorted pages on a
multi-threaded scan.

**Trade-off.** A deep page requested right after the first sorted page
now waits for the background build. The build costs the same as before,
but it starts after the block. The view is fully pageable a little later:
at 10M rows, 2.9 s after sorting in the default `auto` mode (was 2.5 s),
and 8.6 s on CSV with Parquet off (was 6.0 s). In exchange, the first
rows show 2.5x to 10x sooner. The canvas grid starts at the top, so that
is the common case. Another path would compute the block and the
index in one query, for example by materializing the sorted rows and
taking the first page from them. That costs the full sort before the
first page, which is what M1 did.

### Unsorted deep pages on CSV: Parquet first

Options measured at 10M rows, 313 MB CSV, on a quiet machine
(`docs/benchmarks/m2` has the bench JSON; these one-off timings come
from scratch scripts):

| Option | First deep page | Later pages | Other effects |
| --- | ---: | ---: | --- |
| `LIMIT/OFFSET` over the CSV (M1) | 1.8 to 3.1 s | same, every time | none |
| `__gg_ord` range over the CSV view | 1.9 s | same | none: the window runs single-threaded |
| Positional in-memory table (`CREATE TABLE AS SELECT * FROM csv`, `rowid` range) | 1.3 s to build | 5 ms | Holds the whole table in DuckDB memory (spills when over the limit). Lost on restart. Helps nothing else. |
| **Parquet copy** (chosen) | 2.0 s to convert | 8 to 16 ms | Kept on disk and reused on reopen. Sorts build 2x faster (2.5 s vs 5.5 s), profiles are 2.5x faster, counts come from metadata. |

The Parquet copy costs about as much as one deep OFFSET scan and makes
everything after it fast, so:

- `auto` mode (the default) still converts CSVs of 200 MB or more in the
  background at open. A smaller CSV now also converts **on demand** when
  an unsorted page at offset 100,000 or deeper is requested, or when a
  sort or filter index is about to be built. The deep page waits for the
  copy (the wait can be aborted) and then reads it. With `parquet: 'never'`
  the engine keeps M1's OFFSET over the CSV.
- **Full-scan queries wait for a running conversion instead of competing
  with it.** These are the profile, filtered counts, aggregates, top-K
  blocks, index builds, deep pages and `setColumnTypes` scans. On 2 cores,
  a full CSV scan costs about as much as the conversion itself, running
  both roughly doubles each, and the query is 3 to 10 times faster on the
  copy. So waiting for the remaining conversion is never slower than
  scanning the CSV. Shallow unsorted pages and the unfiltered count (the
  row count the grid shows at open, which parses little of each line)
  still run at once.
- Costs: more disk writes, since any CSV that gets deep-paged or sorted
  is copied into the cache (zstd Parquet was 10% of the CSV size for
  the fixture; real data compresses less; the 20 GB LRU cap applies). The first deep page on a small file costs
  the conversion time. For 1M rows (32 MB) that is about 270 ms, compared
  with about 210 ms for an OFFSET.

### Coalescing and aborts

- `coalesce.ts`: one task per key, shared by identical in-flight requests
  (two windows, or a duplicated grid page). Each caller has its own
  `AbortSignal`. Aborting rejects that caller at once, and the shared
  DuckDB query is interrupted only when every caller has aborted.
  `QueryService` uses this for pages, top-K blocks, counts, aggregates
  and profiles. `EngineClient.fetchPage` does the same in the renderer.
- Result-cache keys are now logical:
  `table + file fingerprint + override version + [kind, offset, limit, sort, filter]`
  for pages, and the compiled SQL, parameters and `pixelWidth` for
  aggregates. Sort index names include the override version, so an
  in-flight build from before a type change cannot be served afterwards.
- View ids are scoped per renderer session inside the engine, so two
  windows' `grid` views do not cancel each other's index builds. A closed
  session releases its views.

## Type overrides

`QueryService.setColumnTypes(table, overrides)` (`query-service.ts`):

| Logical type | DuckDB type |
| --- | --- |
| integer | BIGINT |
| float | DOUBLE |
| decimal | DECIMAL(38,6). A column already inferred as DECIMAL keeps its own precision and scale. |
| boolean | BOOLEAN |
| date | DATE |
| timestamp | TIMESTAMP |
| text | VARCHAR |

- Each table has three views: `gg_<id>_raw` (source types), `gg_<id>` (the
  user's columns, with `TRY_CAST(c AS T) AS c` for each override) and
  `gg_<id>_ord` (the same plus `__gg_ord`). The compiler, the profile,
  filters and sort keys all read `gg_<id>`. `columns()` and the handle
  report effective types. The Parquet copy stores raw types, so an
  override never invalidates it.
- One scan over the raw view counts the failed casts per override and
  computes profile statistics for each column whose (name, DuckDB type)
  has none yet. Statistics and failed counts are cached per (name, type),
  so undo and redo of a type change, or a profile after it, need no new
  scan: the following `profile` is answered from those statistics.
- The change is atomic. The scan runs first, and if it is cancelled or
  fails, nothing changes. Then the views are redefined, the table's result
  cache entries and sort indexes are dropped, and `tableUpdated` is
  broadcast. Calls for one table are serialized.
- Caveats: DECIMAL(38,6) rounds values with more than 6 decimals, and
  only values beyond 32 integer digits count as failed. Text to
  date or timestamp uses DuckDB's ISO parsing, so other formats fail and
  read as NULL. Overriding a TIME column to `text` keeps TIME, since TIME
  is already logical `text`.

## Arrow types

`apps/desktop/src/engine/arrow.ts`:

| DuckDB | Arrow | JS value from `vector.get(i)` |
| --- | --- | --- |
| DECIMAL(p,s) | Decimal(scale s, precision p, bitWidth 128) | 4 x uint32 words, little-endian two's complement unscaled value |
| TIME | Time64(MICROSECOND) | bigint µs since midnight |
| TIME_NS | Time64(NANOSECOND) | bigint ns since midnight |
| INTERVAL | Interval(MONTH_DAY_NANO) | `Int32Array [months, days, nanos lo, nanos hi]` (nanos = DuckDB micros x 1000) |
| DATE, TIMESTAMP* | unchanged (DateDay, Timestamp) | |
| TIME WITH TIME ZONE, HUGEINT, UUID, BLOB, nested | Utf8 (DuckDB's text) | |

Decimal128 is practical in Apache Arrow JS 21: it writes and reads IPC
correctly, and the unscaled value converts exactly with BigInt. A Float64
fallback would have lost exactness for wide DECIMALs. An INTERVAL whose
time part does not fit in 64-bit nanoseconds (more than about 292 years of
hours) sends that page's column as text.

## Security

Requirement: `enable_external_access = false`, `allowed_paths` /
`allowed_directories` limited to the registered files and the cache, and
`lock_configuration = true` (`sandbox.ts`).

**DuckDB constraint (verified on 1.5.6).** Once `enable_external_access`
is false, `SET allowed_paths` fails with "Cannot change allowed_paths when
enable_external_access is disabled". With `lock_configuration` on, every
`SET`/`RESET` fails. A single shared instance therefore cannot learn about
files the user opens later.

**Design: one DuckDB instance per open table.** On first open, a table
gets an in-memory instance created with `autoinstall_known_extensions` and
`autoload_known_extensions` off, `preserve_insertion_order`, its own spill
folder `<userData>/cache/duckdb-tmp/<tableId>` and a memory limit. Then
the engine runs `SET allowed_paths = [<the CSV>]`,
`SET allowed_directories = [<Parquet cache folder>]`,
`SET enable_external_access = false` and `SET lock_configuration = true`.
All of the table's views, top-K blocks, sort indexes and its conversion
run in that instance. Creating and locking one takes about 10 to 20 ms
(`open` went from about 70 to 95 ms on CSV, and from 13 to 26 ms on a
cached Parquet). Tables never query each other, so nothing is lost.

- **Refused** (`security.test.ts`, through crafted WHERE fragments and
  statements handed straight to the query layer): `read_csv('/etc/passwd')`,
  `read_text`, `glob('/etc/*')`, another open table's file, `..` traversal
  out of the cache folder, `https://`, `http://169.254.169.254` and
  `s3://` URLs, `INSTALL`/`LOAD httpfs`, `COPY ... TO` outside the cache,
  `ATTACH` outside the cache, and `SET`/`RESET` of `enable_external_access`,
  `lock_configuration`, `allowed_*`, `autoinstall_known_extensions` and
  `PRAGMA memory_limit`. The table's own CSV and its Parquet copy still
  work.
- **Spill files.** DuckDB names its temp files the same in every instance
  (`duckdb_temp_storage_*.tmp`), so each instance has a private spill
  folder. Spilling works with external access off: a 5M-row sort with a
  100 MB limit spilled 230 MB. Instances remove their folders when they
  close, and the engine removes leftovers from crashed runs (older than an
  hour) at startup.
- **Progress bar.** `SET enable_progress_bar` is refused once the
  configuration is locked, but `PRAGMA enable_progress_bar` and
  `PRAGMA disable_print_progress_bar` still work. They change only that
  connection, and the conversion uses them for progress events.
- **Remaining exposure.**
  - Any table's instance may read and write inside the Parquet cache
    folder, which holds Parquet copies of other files the user opened,
    and it may `ATTACH` a database file there.
  - Per-connection PRAGMAs that are not settings (profiling, progress)
    still run.
  - Path matching on Windows (backslashes, drive letters, UNC) has not
    been exercised: CI runs the engine tests on Linux only. The E2E on
    Windows will show whether opening a file still works there.
  - Requests carry no SQL, so all of this matters only if the compiler
    or engine has a bug, or an attacker can already run code in the
    engine.
- **Memory.** Each instance gets `memory_limit` = 50% of RAM (at least
  512 MB; `QueryServiceOptions.memoryLimitBytes`) and DuckDB's default
  thread count. With one file open this matches M1 closely (DuckDB's
  default was 80%). With two files under heavy load at once, each spills
  past its half instead of one taking everything.
- `QueryService.closeTable(id)` closes a table's instance. The protocol
  does not expose it yet. Tables stay open for the engine's lifetime, as
  in M1.

## Numbers

Engine bench (`GLASSGRID_BENCH_ROWS=<n> UV_THREADPOOL_SIZE=8 pnpm --filter
@glassgrid/desktop exec vitest run src/engine/bench.test.ts`), fixture CSV
(`id, category, amount, created_on`; 1M rows = 32 MB, 10M = 329 MB), sort
`amount desc`. Before = M1 (`20e7338`), after = this branch. Each value is
the median of three interleaved runs per side. The machine (2 vCPU Xeon
@ 2.1 GHz, 8 GB) was shared with another agent (load average about 2),
so single timings vary by up to 2x. Medians are in
[benchmarks/m2/engine-bench-medians-linux-x64.json](benchmarks/m2/engine-bench-medians-linux-x64.json).

"CSV" opens with `parquet: 'never'` (raw CSV). "auto" opens with the
default mode and an empty cache: at 10M rows the conversion starts at
open, at 1M rows on demand.

| ms (median), before → after | 1M CSV | 1M Parquet | 10M CSV | 10M Parquet |
| --- | ---: | ---: | ---: | ---: |
| open | 76 → 98 | 11 → 23 | 70 → 94 | 13 → 26 |
| first page | 24 → 44 | 9 → 9 | 38 → 41 | 12 → 11 |
| deep page (offset n − 100k), raw CSV | 215 → 230 | 8 → 8 | 2,501 → 2,122 | 15 → 9 |
| deep page right after open, auto | 206 → 292 | | 3,481 → 2,247 | |
| next deep page, auto | 114 → 7 | | 1,157 → 11 | |
| deep page after a fling, auto | 201 → 8 | | 2,671 → 16 | |
| profile | 193 → 187 | 74 → 72 | 1,749 → 1,722 | 683 → 645 |
| **first sorted page** | 613 → 289 | 278 → 42 | **6,043 → 2,337** | **2,461 → 276** |
| first sorted page, auto | 546 → 50 | | 2,510 → 240 | |
| second sorted page | 5 → 1 | 5 → 1 | 10 → 1 | 6 → 1 |
| deep sorted page right after the first (waits for the index) | 6 → 575 | 4 → 262 | 8 → 6,283 | 5 → 2,507 |
| same, auto | 4 → 268 | | 8 → 2,618 | |
| sorted page once the index exists | 6 → 5 | 5 → 5 | 7 → 7 | 5 → 5 |
| filtered + sorted first page | 366 → 259 | 117 → 54 | 4,020 → 2,606 | 1,079 → 239 |
| CSV → Parquet conversion | 293 → 270 | | 2,252 → 2,134 | |

Fling: 30 page requests in 1 s at random offsets, each one aborted when the
third newer one is sent. "last 3" is the time from the last request to all
three kept pages; "interrupt" is the time from `abort()` to the rejection.

| fling, median before → after | last 3 | interrupt median / max |
| --- | ---: | ---: |
| 10M raw CSV, unsorted (OFFSET scans) | 1,969 → 2,268 | 4.5 / 12.9 → 0.4 / 1.0 |
| 10M auto, unsorted, right after open (conversion running) | 1,853 → 1,225 | 5.8 / 16.4 → 0.3 / 0.6 |
| 1M auto, unsorted, right after open | 130 → 9 | 3.3 / 16.1 → 0.3 / 0.3 |
| 10M Parquet, unsorted | 10 → 22 | 0 / 0 → 0 / 0 (pages finish before their abort) |
| 10M CSV or Parquet, sorted, index built | 6 → 5 | 0 / 0 |
| 10M, new sort, index not built: CSV / Parquet | 4,896 / 1,348 → 4,820 / 1,337 | 0.4 / 0.6 both |

A superseded page is now rejected within about 1 ms (the coalescer rejects
the caller at once; DuckDB's interrupt follows within a few ms). The last
pages of a fling are fast whenever the background work is done. Before
that, they wait for the Parquet copy or the index instead of competing
with stale scans.

Electron E2E at 10M rows (`pnpm e2e:10m`, single runs back to back on the
same machine, before → after): open → first page 258 → 228 ms; profile
right after open 5,114 → 3,880 ms (it now waits for the background
conversion and then reads Parquet); cold row count right after open
2,692 → 2,032 ms. **Exit gate:** first rows appear in 0.23 s, under the
2 s budget, and any page takes 5 to 16 ms once the background work is
done. The 1M E2E (`pnpm e2e`) passes: open → first page 203 to 210 ms.

## Tests

| File | What |
| --- | --- |
| `src/engine/paging.test.ts` | Property test: top-K vs index vs auto paths (CSV and Parquet) plus a JS reference order. Block slices vs index pages at depth. File order of filtered unsorted pages. No index when the block is complete. Deep CSV pages use Parquet in auto mode and OFFSET in `never` mode. |
| `src/engine/column-overrides.test.ts` | `setColumnTypes` on CSV and Parquet: casts, failed counts, effective types, numeric sort order, profile and compiled filters/aggregates on the new types, invalidation and revert, DECIMAL(38,6), unknown columns, atomic cancel, protocol round trip and `tableUpdated`. |
| `src/engine/arrow-types.test.ts` | Decimal128, Time64 and Interval mapping. Every rendered cell equals DuckDB's VARCHAR cast. TIME sniffed from a CSV. Interval overflow falls back to text. |
| `src/engine/coalescing.test.ts` | `Coalescer` semantics. Identical pages share a query. One caller aborting keeps it running for the others, and all aborting interrupts it. A fling settles. |
| `src/engine/client-integration.test.ts` | `EngineClient` against a real session over a MessageChannel: concurrent pages, client-side coalescing, sort and filters, an abort that ends in an engine `cancel` and interrupt, `setColumnTypes`. |
| `src/engine/security.test.ts` | The refusals listed above, the locked settings, and that the table's own file and Parquet copy still work. |
| `src/engine/session.test.ts` | Concurrent pages are not superseded, and cancelling one leaves the others. |
| `packages/core/src/protocol/engine.test.ts` | `concurrent`, `setColumnTypes` (duplicates, bad types, stripped fields), `columnTypes`, `typeOverrides`. |
| `src/renderer/src/describe.test.ts` | Decimal, time and interval formatting. |

`cancellation.test.ts` now asks for a page past the top-K block to observe
an index build being interrupted. The renderer client test lives under
`src/engine` because it needs Node (DuckDB). It has its own tsconfig
(`tsconfig.integration.json`: DOM plus Node types). `fast-check` is now a
dev dependency of `@glassgrid/desktop`.

## Not done / follow-ups

- The bench uses the 4-column fixture. Wide tables (the `tools/datasets`
  synthetic and taxi sets) will make top-K blocks and sort indexes more
  expensive per row. Run the bench on them before tuning
  `TOP_K_MAX_ROWS`.
- A deep sorted page requested while the index builds waits for the
  whole build. If users often jump to the bottom of a sorted 10M-row view
  right away, the reverse top-K (`ORDER BY` reversed, `LIMIT`) can serve
  the last 5,000 rows the same way.
- `closeTable` is not exposed. Closing a file or workspace should call it
  to free that table's DuckDB instance and spill folder.
- Overrides are forgotten when the engine restarts (by design; the
  renderer re-sends them). The fingerprint still misses same-size,
  same-mtime edits (M1 gap).
