# M1 notes: engine data path

Status of the M1 engine work (QueryService, caches, cancellation) and the
decisions behind it. Dated 2026-10-17. Builds on [M0](m0-notes.md): DuckDB
still runs in an Electron `utilityProcess` and answers the renderer over a
MessagePort that main brokers.

## Layout

| Path | What |
| --- | --- |
| `packages/core/src/protocol/engine.ts` | Zod schemas for every renderer <-> engine message |
| `packages/core/src/protocol/control.ts` | `EngineConfigSchema` (main -> engine at spawn) |
| `apps/desktop/src/engine/query-service.ts` | `QueryService`: tables, profile, rows, count, Parquet cache, result cache. Plain Node. |
| `apps/desktop/src/engine/session.ts` | `EngineSession`: one per MessagePort; validation, per-view ordering, cancel |
| `apps/desktop/src/engine/sort-indexes.ts` | Row-number tables for sorted/filtered paging |
| `apps/desktop/src/engine/parquet-cache.ts` | Cache folder: atomic commit, LRU eviction |
| `apps/desktop/src/engine/result-cache.ts` | Byte-bounded LRU of results |
| `apps/desktop/src/engine/fingerprint.ts` | size + mtime + SHA-256 of first/last 1 MB |
| `apps/desktop/src/engine/index.ts` | Utility-process entry: wires parentPort and ports to the above |
| `apps/desktop/src/renderer/src/engine-client.ts` | Typed client with per-view sequencing |

## Protocol

Requests (all carry `requestId`; query requests also carry `viewId`, `seq`,
`table`):

| Request | Reply | Notes |
| --- | --- | --- |
| `open { file, parquet? }` | `opened { table: TableHandle }` | `parquet`: `auto` (default; convert in background when the CSV is >= 200 MB), `always`, `never` |
| `profile` | `profile { rowCount, columns: ColumnProfile[] }` | |
| `rows { query: { offset, limit <= 1000, sort? } }` | `arrow { ipc }` | Arrow IPC stream |
| `count` | `count { rowCount }` | |
| `aggregate { spec }` | `arrow` | Stub: `not_implemented` (see "Integration") |
| `cancel { target }` | target answered `cancelled` | |
| `ensureParquetCache { table }` | `parquetCache { table, alreadyCached, sizeBytes }` | resolves when the copy is ready |
| `clearCache { scope? }` | `ack` | `all`, `results`, `parquet` |
| `cacheStats` | `cacheStats { results, parquet }` | hits, misses, evictions, bytes |

Every reply to a query carries `engineMs` and `cached`. Failures are
`error { requestId, code, message }` with `code` one of `bad_request`,
`unknown_handle`, `unknown_table`, `unknown_column`, `query_failed`,
`io_failed`, `engine_unavailable`, `cancelled`, `superseded`,
`not_implemented`. Unsolicited `event` messages are broadcast to every port:
`parquetProgress { table, fraction }`, `parquetReady { table, sizeBytes }`,
`parquetFailed`, `tableUpdated { table }`.

`TableHandle = { id, file, fileName, rowCount?, fingerprint, usingParquetCache, columns }`.
`id` (`tb_<uuid>`) is derived from the `FileHandle` (`fh_<uuid>`), so after an
engine respawn the engine reopens a table on first use from main's replayed
file registration; renderer-held ids stay valid.

**No SQL on the wire.** Requests carry typed objects only; Zod strips unknown
fields such as `where`. The engine-side `QueryService` accepts a compiled
`where: { sql, params }` fragment, which only engine code (the compiler, at
integration) can supply.

## Client API (renderer)

```ts
const engine = new EngineClient(window.glassgrid);
const { table } = await engine.open(fileHandle);                       // TableHandle
const page = await engine.rows(table.id, { offset: 0, limit: 1000, sort }, { viewId: 'grid' });
page.table;                                                            // apache-arrow Table
await engine.profile(table.id, { viewId: 'profile' });                 // { rowCount, columns }
await engine.count(table.id, { viewId: 'status' });                    // { rowCount }
await engine.aggregate(table.id, spec, { viewId: 'chart:1' });         // not_implemented for now
await engine.ensureParquetCache(table.id); await engine.clearCache('all'); await engine.cacheStats();
engine.onEvent((event) => ...);                                        // Parquet progress etc.
engine.cancel(engine.lastRequestId);                                   // or pass { signal }
```

Rejections are `EngineRequestError { code }`; `isAbandoned(error)` is true for
`superseded` and `cancelled`, which views should ignore.

## Cancellation and ordering

- The client numbers requests per `viewId`. Sending a newer one rejects older
  pending promises of that view with `superseded` immediately and drops any
  late response (it also re-checks `seq` on arrival).
- The engine session keeps the latest `seq` per view. A newer request aborts
  the older in-flight ones (their responses are never sent); a request whose
  `seq` is not newer is answered `superseded` without running.
- Every request runs on its own DuckDB connection. An abort calls
  `connection.interrupt()`; `@duckdb/node-api` 1.5.6 exposes it and DuckDB
  stops within about 1 to 5 ms in our tests (a 10M-row sort materialization
  interrupted after 300 ms rejected at 301 ms with `INTERRUPT Error`). An
  interrupt sent while no query runs does not stick to the connection.
- `cancel { target }` aborts the target and answers it `cancelled` at once.
- Sort-index builds are shared and run on their own connection. They are
  interrupted only when no view wants them any more (the view moved to a
  different sort or to unsorted), not when one page request is superseded,
  because the next page of the same view needs the same index.
- Main passes `UV_THREADPOOL_SIZE=8` to the engine: each in-flight DuckDB call
  holds a libuv worker, and file I/O shares the pool.

## Ingest and paging

- **One sniff per file.** `open` runs `sniff_csv` once and defines the view
  with an explicit `read_csv(path, auto_detect = false, delim, quote, escape,
  new_line, skip, comment, header, columns = {...}, dateformat, ...)`, the
  same options DuckDB's own `sniff_csv(...).Prompt` spells out. With
  `read_csv_auto` every query re-sniffs at bind time (30-60 ms each); with the
  explicit form a 1,000-row page drops from ~37 ms to ~8 ms of DuckDB time
  and `open` from ~150 ms to ~70 ms at 1M rows. The Parquet conversion uses
  the same reader, so types match exactly. If sniffing fails the view falls
  back to `read_csv_auto` and DuckDB reports the real error.
- **Unsorted pages** keep file order. On CSV: `LIMIT/OFFSET` (DuckDB returns
  file order because `preserve_insertion_order` is on; set explicitly). On
  Parquet: a range predicate on `file_row_number`, which DuckDB pushes into
  the Parquet scan (row groups skipped via statistics).
- **Sorted or filtered pages** materialize once per (table, sort, filter):
  `CREATE TABLE gg_idx_<table>_<hash> AS SELECT row_number() OVER (ORDER BY
  <keys>, __gg_ord) AS __gg_rn, * ... ORDER BY __gg_rn`, then page with
  `__gg_rn > offset AND __gg_rn <= offset + limit`. `__gg_ord` is the file
  position (`file_row_number` on Parquet, `row_number() OVER ()` on CSV,
  verified to equal file order on 10M rows with 2 threads), so ties are
  stable and paging is deterministic. Sort keys are validated against the
  table's columns and quoted. Up to 4 indexes are kept (LRU, unreferenced
  ones dropped). Each is a full in-memory copy (~500 MB at 10M rows of the
  4-column fixture); DuckDB spills to `<userData>/cache/duckdb-tmp`.
- Column names `__gg_ord` / `__gg_rn` are reserved (open fails with a clear
  message).

## Profile: trade-off

One aggregate scan: `count(*)`, and per column `count(c)`,
`approx_count_distinct(c)` (HyperLogLog), `min(c)`, `max(c)`. Min/max are
numbers for numeric columns, text for temporal and big values (text truncated
to 200 chars).

| 10M rows (2 vCPU) | CSV | Parquet |
| --- | ---: | ---: |
| this query | 2.1 s | 0.75 s |
| `SUMMARIZE` | 4.4 s | 3.2 s |

`SUMMARIZE` also computes avg, stddev and three approximate quantiles, which
dominate its cost. Sampling (`USING SAMPLE`) does not help on CSV because the
whole file must still be parsed; on Parquet the full scan is already fast. So
the profile is exact for null fractions and min/max and approximate only for
distinct counts (about +/-15% at small cardinalities, tighter at large ones).
The result is cached.

## Parquet cache

- Folder: `<userData>/cache/parquet` (main injects it via `EngineConfig`;
  tests use temp folders). Entry: `<fingerprint key>.parquet`, where the key is
  SHA-256 over a format version, size, mtime and the head/tail hash.
- Fingerprint trade-off: reading 2 MB keeps `open` fast on multi-GB files; an
  edit in the middle of a file that keeps size and mtime unchanged is not
  detected (tested and documented).
- Atomic: DuckDB `COPY ... TO '<key>.parquet.<random>.tmp'`, then the CSV is
  fingerprinted again (a file changed mid-copy is discarded), then `rename`.
  Interrupted or failed conversions delete their temp file; stale temp files
  (untouched for an hour) are removed at startup.
- LRU: recency is the entry's mtime, bumped on every hit. After each commit
  the cache evicts oldest entries until it fits the cap (default 20 GB),
  skipping entries that open tables read.
- During conversion queries keep reading the CSV; progress events come from
  `connection.progress` (requires `SET enable_progress_bar = true` on that
  connection). When the copy commits, both views switch with `CREATE OR
  REPLACE VIEW` and `parquetReady` carries the updated handle.
- `clearCache('parquet' | 'all')` interrupts running conversions, points
  tables back at their CSVs (`tableUpdated`) and empties the folder.

## Result cache

LRU keyed by table id + SQL + bound parameters, capped at 256 MB of Arrow
bytes (scalar results count a small estimate). Grid pages, counts and
profiles use it; hit/miss/eviction stats are in `cacheStats`. A table's
entries are dropped when its file changes.

## Timings (Linux container, 2 vCPU Xeon @ 2.1 GHz, 8 GB; single runs)

Engine only (`GLASSGRID_BENCH_ROWS=<n> pnpm --filter @glassgrid/desktop exec
vitest run src/engine/bench.test.ts`, writes `e2e-results/engine-bench-*.json`):

| Step | 1M CSV | 1M Parquet | 10M CSV | 10M Parquet |
| --- | ---: | ---: | ---: | ---: |
| open | 70 ms | 10 ms | 73 ms | 11 ms |
| first page (1,000 rows) | 38 ms | 10 ms | 37 ms | 12 ms |
| deep page (offset n-100k) | 251 ms | 9 ms | 3.1 s | 10 ms |
| profile | 197 ms | 80 ms | 2.1 s | 0.75 s |
| count | 62 ms | (metadata) | 643 ms | (metadata) |
| sorted first page (`amount desc`, builds index) | 637 ms | 308 ms | 6.3 s | 2.6 s |
| sorted deep page (index exists) | 9 ms | 5 ms | 6 ms | 15 ms |
| CSV -> Parquet conversion | 255 ms | | 2.5 s | |

E2E (Electron, renderer `performance.measure`, 1M rows): open -> first page
218 ms (engine: open 80 ms, page 59 ms); profile round trip 281 ms; count cold
83 ms, warm 12 ms (result cache). At 10M rows (313 MB, so `open` starts the
background Parquet conversion): open -> first page 186 ms (engine: open
99 ms, page 59 ms); the profile took 4.9 s because it scanned the CSV while
the conversion competed for both cores; the count afterwards ran on Parquet
metadata in 8 ms. Written to `e2e-results/open-to-first-page-*.json` and
`count-rows-*.json`.

Takeaways: on CSV, deep unsorted pages and first sorted pages grow with file
size; on Parquet they do not. Above 200 MB `open` converts in the background,
so large files reach Parquet speed a few seconds after opening. A top-N fast
path for the first sorted pages while the index builds is a possible M2
optimization.

## Integration with the compiler

1. **Filters on rows/count.** Add `filters: FilterSchema.array().optional()`
   to `RowsRequestSchema` and `CountRequestSchema`. In `EngineSession.run`,
   compile them with the core compiler to `{ sql, params }` (a boolean
   predicate over the table's columns, identifiers quoted, values bound with
   `?` or `$n`) and pass it as `where` to `QueryService.rows` / `count`, which
   already support it (materialized index per filter, cached per fragment).
   The fragment must be the only source of placeholders: the engine inlines
   its own integer bounds, so `?` and `$1..$n` both work.
2. **Aggregates.** Tighten `AggregateRequestSchema.spec` to the compiler's
   `ChartQuery` schema and replace `compileAggregate()` in
   `apps/desktop/src/engine/session.ts` with the compiler. It must return a
   full `SELECT` with bound params that reads from the table's view; expose
   the view name to the compiler (`QueryService` keeps it as
   `gg_<tableId>`, quoted) or have the compiler emit a placeholder relation
   that `QueryService.aggregate` substitutes. Then implement
   `QueryService.aggregate` as `cachedArrow(id, compiled.sql, compiled, ctx)`
   (results cache by SQL + params automatically).
3. Use `viewId: 'chart:<id>'` per chart card so brushing supersedes stale
   aggregates.

## Not done / follow-ups

- Arrow encoding is still per value in JS (`arrow.ts`); fine for 1,000-row
  pages, revisit for large aggregates. DATE/TIMESTAMP now map to Arrow
  DateDay/Timestamp; DECIMAL, TIME, INTERVAL and nested types travel as text.
- DuckDB still runs without `enable_external_access = false` and an
  allowed-paths list (security section of the design); add in M5.
- Type inference uses DuckDB's 20,480-row sample; a value deep in the file
  that contradicts the sniffed type makes queries fail with `query_failed`
  (DuckDB's message names the line). A per-column override is
  `setColumnType`'s job.
- Engine respawn was not exercised end to end; the E2E covers open, profile,
  first page and count.
