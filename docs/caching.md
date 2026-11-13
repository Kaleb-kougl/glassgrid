# Caching

Every cache in Glassgrid, from the disk to the CDN. Each layer is
independent: a cold one costs time, never correctness. Dated 2026-11-12,
written against branch `live-flights`.

The rule they all follow: **a key changes whenever its input changes.**
A changed file, a column type change or a new live batch produces new keys,
so an old entry can never answer a new question. Stale entries age out of an
LRU; explicit invalidation only frees memory sooner.

| Layer | Where | Holds | Key | Bound |
| --- | --- | --- | --- | --- |
| [Parquet cache](#1-parquet-cache) | Disk (desktop app cache folder; OPFS on the web) | A Parquet copy of each CSV | File fingerprint | 20 GB desktop, 2 GB web, LRU |
| [Result cache](#2-result-cache) | Engine memory | Query results (pages, aggregates, counts, profiles) | Table + fingerprint + type version + request | 256 MB of payload, LRU |
| [Derived tables](#3-derived-tables-in-duckdb) | The table's DuckDB database | Sort indexes, brush cubes | Hash of the build SQL | 4 indexes; 48 cubes / 6M cells |
| [Grid pages](#4-grid-page-cache) | Renderer memory | Display values of 1,000-row pages | Page number | 50 pages, LRU |
| [HTTP](#5-http-caching-web-demo) | Browser and CDN | Static assets, samples, the flights relay | URL | `Cache-Control` |

## 1. Parquet cache

`packages/engine/src/parquet-cache.ts`, `fingerprint.ts`

Reading a CSV in place re-parses text on every scan. A Parquet copy is
columnar, so reopening the file and cross-filtering read only the columns
and row groups they need. The design budget for a reopen from the cache is
under 300 ms to first rows ([technical design](technical-design.md#performance-budgets)).

**When a copy is made.** CSVs of at least 200 MB on the desktop and 64 MB on
the web (`autoConvertMinBytes`) are converted in the background after open;
smaller ones on request (`ensureParquetCache`). Without OPFS, for example in
some private-browsing modes, the web worker reports `cache: 'none'` and
never converts.

**Key.** `fingerprintFile` hashes the file's size, mtime and the SHA-256 of
its first and last 1 MB, plus `PARQUET_FORMAT_VERSION`. That reads at most
2 MB of a multi-GB file. Renames and mtime-preserving copies still match;
any edit that changes the size, the mtime or either end does not. Bumping
`PARQUET_FORMAT_VERSION` (a change to how CSVs are converted) retires every
existing entry at once. The web uses the same function: a picked `File`'s
size and `lastModified`, or a sample URL's `Content-Length` and
`Last-Modified` with the edges read by Range requests.

**Writes are atomic.** DuckDB writes `<key>.parquet.<random>.partial` in the
cache folder, and the file is renamed into place only after `COPY`
succeeds, so a crash never leaves a truncated entry. `.partial` files older
than an hour are removed when the cache starts. (Not `.tmp`: DuckDB-WASM's
`COPY` drops a trailing `.tmp` from its target name.)

**Eviction.** Least recently used first, by mtime, which every hit bumps
(atime is unreliable under `noatime`/`relatime`). OPFS cannot set mtimes,
so on the web it is oldest written first. Entries that open tables still
read are never evicted. The folder is rebuildable: "Clear cache" or deleting
any of it only costs a reconversion.

**Uncompressed on purpose** (`PARQUET_COMPRESSION`). Cross-filtering reads
this file constantly. On the 10M-row fixture, a filtered first page that
scans the whole file took 100 ms uncompressed, 158 ms with LZ4 and 263 ms
with zstd. A cube build took 0.7 s vs 1.3 s with zstd. The file is 1.65x
the zstd size (29% of the CSV instead of 18%), and writing it takes as long
([M3 cross-filter notes](m3-xfilter-notes.md)).

## 2. Result cache

`packages/engine/src/result-cache.ts`, `coalesce.ts`, `query-service.ts`

An LRU of query results in the engine (the desktop utility process, or the
web worker), capped at 256 MB of payload: Arrow IPC bytes for pages and
aggregates, a small estimate for scalars. Grid pages, chart aggregates,
counts, profiles, top-K blocks and cube answers all go through it. A hit
returns without touching DuckDB.

**Key.** `tableId ␀ fingerprint:version ␀ JSON(request parts)`, built by
`QueryService.key`. The request parts are the logical inputs: offset and
limit, sort, the compiled SQL and its bound values, `pixelWidth`.

- The **fingerprint** means a changed source file never hits.
- The **version** is `''` until the first column type change, then a digest
  of the overrides and a generation counter that never repeats. A query
  that raced a type change is cached under the old version, which is never
  asked for again, even if the types are changed back. The version moves on
  only once the views read the new types.
- The **table id prefix** lets `invalidateTable` drop one table's entries
  together (on a type change, close, or a live batch) to free memory early.

Values larger than the whole cache are not stored.

**Coalescing.** Identical requests in flight share one query (two views, or
two windows, asking for the same page). Each caller has its own
`AbortSignal`; the shared DuckDB query is interrupted only when every caller
has aborted.

## 3. Derived tables in DuckDB

`packages/engine/src/sort-indexes.ts`, `cubes.ts`

- **Sort indexes**: row-number tables that serve sorted or filtered pages
  by position instead of re-sorting. At most 4 per engine
  (`DEFAULT_MAX_SORT_INDEXES`).
- **Brush cubes**: per-bin pre-aggregations for the active brush, so a drag
  re-sums a small table instead of re-scanning the source. LRU of 48 cubes
  or 6M cells in total; builds the profile estimates above 4M cells are
  skipped, and remembered as too large so they are not retried on every
  brush ([M3 notes, the brush cube](m3-xfilter-notes.md#engine-the-brush-cube)).

Both are named by a hash of the SQL that builds them, which includes the
table's version, so equal inputs share one table and a type change never
reuses an old one.

## 4. Grid page cache

`packages/ui/src/grid/PagedGridSource.ts`

The renderer keeps 1,000-row pages in an LRU of 50 (about 50K rows), so its
memory depends on the viewport, not the table. Fetches for the visible
window are debounced (50 ms after a quiet spell; the first goes out at
once), at most 4 are in flight, requests for pages that scrolled away are
cancelled, and a failed page is not retried for 1 s. A new sort or filter
calls `reset()`, which drops every page and discards late answers of the
old view; `keepPosition` keeps the scroll position when the data changes
under the same view, such as a new live batch (`packages/app/src/views/grid-source.ts`).

## 5. HTTP caching (web demo)

`apps/web/hosting.ts` is the single source of the demo's response headers.
It generates `apps/web/vercel.json` and `dist/glassgrid-hosting.json`, which
the portfolio's Next.js config reads when it serves the build under
`/glassgrid/` ([deploy](deploy.md)). Later rules win for the same header.

| Path | `Cache-Control` | Why |
| --- | --- | --- |
| Everything (incl. `index.html`, `samples/*.glassgrid`) | `public, max-age=0, must-revalidate` | Always revalidated, so a deploy is seen on the next load |
| `assets/` | `public, max-age=31536000, immutable` | Content-hashed file names |
| `duckdb-extensions/` | same | Versioned path (`v1.4.3/…`) |
| `samples/**/*.parquet` | same | A sample's bytes never change under the same name |

**If you regenerate a sample Parquet file, give it a new name or path.**
Browsers that fetched the old one will not ask again for a year.

**The live-flights relay.** The portfolio's `/api/flights` (in
`sswe-portfolio`, branch `live-flights-proxy`) answers with
`public, s-maxage=10, stale-while-revalidate=20`, so the CDN, not the
upstream, absorbs viewer traffic. The engine fetches it with
`cache: 'no-store'` (the browser never serves a stale poll) every 20 s,
never faster than the 10 s CDN window: a faster poll would get the same
body back and only cost a request ([L2 notes](live-flights-l2.md)). A
repeated body is harmless because ingestion dedups on (hex, ts).

**The live table** has no fingerprint to change, so each ingested batch
advances its version (`~live<generation>.<batch>`), and `liveIngested`
drops its results, cubes and sort indexes. Switching to another feed source
builds a new store with a new generation, so its versions never collide
with the old one's.

## Build caching

The portfolio pins each web release tarball by sha256 in
`glassgrid.lock.json`; its prebuild verifies the hash, and its CI caches the
tarball between builds.

## Tests

| Test | Covers |
| --- | --- |
| `packages/engine/src/result-cache.test.ts` | LRU order, byte cap, oversized values, per-table invalidation |
| `packages/engine/src/parquet-cache.test.ts` | Atomic commit, stale temps, eviction order, protected entries |
| `packages/engine/src/coalescing.test.ts` | Shared in-flight queries and per-caller abort |
| `packages/ui/src/grid/sources.test.ts` | Page LRU, debounce, cancellation, reset |
| `apps/web/src/hosting.test.ts`, `headers.test.ts` | Header rules, and that `vercel.json` is regenerated |
