# M4 notes: one engine for desktop and web

Branch `m4-engine`, dated 2026-10-18. Milestone M4 asks for a "DuckDB-WASM
adapter on a pinned version; OPFS cache" (see
[Web demo target](technical-design.md#web-demo-target)). This branch moves
the query engine into its own package, puts it behind a DuckDB driver
interface, and runs the same engine on native DuckDB (desktop) and on
DuckDB-WASM in a Web Worker (web demo).

| Goal | Result |
| --- | --- |
| Engine core in its own package | `packages/engine` (`@glassgrid/engine`). It holds QueryService, sessions, caches, top-K and row indexes, cubes, profile, type overrides and fingerprints, and imports no Node, DOM or DuckDB binding. The desktop utility process is now a 100-line host. |
| Behaviour unchanged on the desktop | All 140 engine tests from `apps/desktop/src/engine` pass against the native driver after the move, untouched apart from imports (plus the Parquet temp suffix, below). `xvfb-run -a pnpm e2e` passes (Electron 11 passed, 1 skipped). |
| DuckDB-WASM driver | `@duckdb/duckdb-wasm` **1.32.0** (DuckDB v1.4.3), pinned. It runs the synchronous bindings in the engine's own Web Worker. Arrow IPC goes back as transferred buffers, and the Parquet cache lives in OPFS. |
| Parity | The engine suite runs twice in `pnpm test`, once per driver (vitest projects `native` and `wasm`; DuckDB-WASM's Node build stands in for the browser). Parquet-backed variants are skipped on WASM (see Parquet). A shared scenario runs through the client API on native, on WASM in Node, and on WASM in Chromium. On the 1M-row synthetic set both drivers give identical answers, apart from the order of floating-point sums. |
| Browser client | `createWorkerEngine()` in `@glassgrid/engine/web` implements `EngineClientApi`, the same interface the desktop `EngineClient` now declares. |
| Benchmarks | Below and in [benchmarks/m4/](benchmarks/m4/). On 1M rows of CSV, the web demo reaches its first page in 0.49 s (native: 0.13 s). A brush answered from cubes takes 43 ms (native: 30 ms). Full scans are 2 to 6 times slower than native on this 2-core machine. |

## Layout

| Path | What |
| --- | --- |
| `packages/engine/src/driver.ts` | The driver interface (below) |
| `src/query-service.ts`, `session.ts`, `sort-indexes.ts`, `cubes.ts`, `coalesce.ts`, `result-cache.ts`, `parquet-cache.ts`, `fingerprint.ts`, `column-types.ts`, `sql-text.ts`, `errors.ts` | The engine core, moved from `apps/desktop/src/engine` |
| `src/hash.ts`, `src/emitter.ts` | Synchronous SHA-256 for internal names (cache keys, index and cube names) and a typed emitter. They replace `node:crypto` and `node:events`. |
| `src/native/` (`@glassgrid/engine/native`) | Native driver: `@duckdb/node-api` 1.5.6-r.1, one sandboxed instance per table (`sandbox.ts`), Arrow built from JS values (`arrow.ts`), `node:fs` file operations |
| `src/wasm/` (`@glassgrid/engine/wasm`) | DuckDB-WASM driver over the synchronous bindings: pending queries, argument binding, Arrow normalization, out-of-memory mapping |
| `src/wasm/node.ts` (`@glassgrid/engine/wasm/node`) | DuckDB-WASM with its Node runtime, for tests and benches |
| `src/worker/` | The web demo's engine worker (`engine-worker.ts`), its control protocol (`protocol.ts`) and browser files: sources and the OPFS cache (`browser-files.ts`) |
| `src/client/` (`@glassgrid/engine/client`) | `EngineClientApi` and its result types, and `PortEngineClient`. The latter is the desktop client's logic (per-view sequencing, superseding, page coalescing) over any MessagePort-like endpoint. |
| `src/web/` (`@glassgrid/engine/web`) | `createWorkerEngine()` |
| `src/testing/` | Runtime-neutral fixture, shared scenario (`scenario.ts`) and M4 workload (`m4-bench.ts`) |
| `e2e/`, `playwright.config.ts` | Chromium tests and bench: a Vite-built page, a static server with Range/HEAD (`serve.ts`), specs |
| `apps/desktop/src/engine/index.ts` | Utility-process host: native driver plus Electron ports, wired to the shared engine |
| `patches/@duckdb__duckdb-wasm@1.32.0.patch` | Exports DuckDB-WASM's synchronous browser build (see the version section) |

ESLint keeps the core runtime-neutral: `packages/engine/src/**` may not
import Node built-ins, Electron or `@duckdb/*`, and may not use DOM or Node
globals. The exceptions are `native/`, `wasm/node.ts`, `worker/`, `web/`,
tests and test support. Four tsconfigs check the four environments: core
(ES2023 + DOM types for shared globals), node, worker (WebWorker) and e2e.

## The driver interface

```ts
interface DuckDriver {
  readonly name: string;                       // 'native' | 'wasm'
  readonly capabilities: DriverCapabilities;   // { interrupt: 'immediate' | 'cooperative', progress, parquet, isolatedInstances, spill }
  readonly files: DriverFiles;
  start(): Promise<string>;                    // DuckDB's version; fails fast if the binding is broken
  createDatabase(options: DatabaseOptions): Promise<DuckDatabase>;   // one per table: { allowedPaths, allowedDirectories, tempDirectory, memoryLimitBytes }
  defaultMemoryLimitBytes(): number;
  removeTempDirectory(path: string): Promise<void>;
  close(): void;
}
interface DuckDatabase { connect(): Promise<DuckConnection>; close(): Promise<void> }
interface DuckConnection {
  run(sql, params?): Promise<void>;
  query(sql, params?): Promise<{ columns: string[]; rows: DriverValue[][] }>;   // small results
  arrow(sql, params?): Promise<Uint8Array>;   // Arrow IPC stream in the engine's type mapping
  interrupt(): void;                          // the statement rejects with "INTERRUPT Error..."
  enableProgress(): Promise<void>;
  progress(): number | null;                  // percent, or null when unknown
  close(): void;
}
interface DriverFiles {                        // the user's files and the Parquet cache folder
  join, basename, dirname, stat, readRange, mkdir, readdir, rename, remove, touch, sha256
}
```

- **Values.** `query` maps DuckDB values to plain JS. BOOLEAN becomes
  boolean; small integers and floats become number; BIGINT and HUGEINT
  become bigint; DECIMAL(p, s>0) becomes its nearest number; VARCHAR,
  dates, timestamps and the rest become text; LIST becomes an array and
  STRUCT an object (`sniff_csv` returns them). Engine code that needs
  DuckDB's exact text casts in SQL. The profile now reads min and max of
  non-numeric columns as `CAST(min(c) AS VARCHAR)`, and of DECIMAL columns
  as DOUBLE, so both drivers report the same text. Native results are
  unchanged.
- **Arrow.** `arrow` returns the M2 mapping on both drivers (DECIMAL as
  Decimal128, TIME as Time64, INTERVAL as MONTH_DAY_NANO, DATE and
  TIMESTAMP as DateDay and Timestamp; HUGEINT, UUID, BLOB and nested types
  as Utf8). The shared `arrow-types.test.ts` checks every rendered cell
  against DuckDB's VARCHAR cast on each driver.
- **Interrupts.** QueryService still maps `ctx.signal` to `interrupt()`.
  Drivers report an interrupt with DuckDB's native wording, so
  `isInterruptError` and every caller are unchanged.
- **Files.** The fingerprint (size, mtime, SHA-256 of the first and last
  1 MB) and the Parquet cache (atomic temp and rename, LRU, stale temp
  cleanup) now go through `DriverFiles`. Keys are the same function of the
  same inputs on every platform, so existing desktop cache entries stay
  valid.

Other engine changes made while porting, all covered by the suite:

- **Parquet input.** A file that starts with Parquet's magic bytes opens in
  place (`read_parquet`, `file_row_number` order), with no conversion. The
  web demo's sample datasets need this; the desktop gets it as well.
- **Temp suffix and `USE_TMP_FILE false`.** Parquet cache temp files now
  end in `.partial`, and `COPY ... TO` runs with `USE_TMP_FILE false`.
  DuckDB-WASM (1.4.3 and 1.5.6 alike) drops a trailing `.tmp` from a COPY
  target; native DuckDB does not. DuckDB's own temp-then-move is also
  redundant, since the engine already does its own. Stale `.tmp` files
  from older builds are still cleaned up.
- **`out_of_memory`.** A new protocol error code
  (`packages/core/src/protocol/engine.ts`). The WASM driver maps DuckDB's
  "Out of Memory Error" and WebAssembly traps to it. The native driver is
  unchanged (`query_failed`).

## Native driver

This is the M2 security model, unchanged (`native/sandbox.ts`, `security.test.ts`).
Each table gets its own in-memory instance created with extension
autoinstall and autoload off and `preserve_insertion_order`. Its
`allowed_paths` is the table's file, its `allowed_directories` is the
Parquet cache, and it has its own spill folder and memory limit. Then
`enable_external_access = false` and `lock_configuration = true`. Interrupts
are immediate, and progress comes from `connection.progress`.

## DuckDB-WASM driver

- **Where it runs.** The synchronous ("blocking") bindings run DuckDB in
  the calling thread. In the web demo that is the engine worker, which also
  runs QueryService and EngineSession, so a request costs two
  `postMessage` hops and no third thread. Tests and benches run the same
  driver in Node with DuckDB-WASM's Node runtime.
- **One instance, a database per table.** Creating a DuckDB-WASM instance
  costs about 0.8 s and 90 MB (measured in Node). Instead, each table gets
  `ATTACH ':memory:' AS gg_db_<n>`, and each of its connections runs `USE`
  on it, so its views, sort indexes and cubes disappear with
  `DETACH` when the table closes.
- **Sandbox, set once at start.** The driver runs
  `SET autoinstall_known_extensions = false`,
  `SET autoload_known_extensions = false`, `preserve_insertion_order` and
  the memory limit, and optionally `custom_extension_repository` plus
  `LOAD parquet`. Then it sets `allowed_directories` to the worker's roots
  (`/gg/src/` for sources, `opfs://glassgrid-cache/` for the cache),
  `enable_external_access = false` and `lock_configuration = true`.
  `wasm/wasm-driver.test.ts` checks the refusals: other paths, globs,
  http(s) URLs, `LOAD`, COPY and ATTACH outside the roots, and every
  `SET`.
- **Interrupts are cooperative.** Statements run as pending queries,
  polled from the event loop (`startPendingQuery` / `pollPendingQuery`), so
  the worker handles new messages between DuckDB's scheduling steps, and
  other connections' queries interleave. `interrupt()` cancels at the next
  step. A step of a large sort can take a few hundred ms (one poll of a 3M
  row sort took 364 ms). In Chromium, aborting a 400k-row profile was
  rejected 22 ms after `abort()`.
- **Arguments.** Only the pending-query API can be interrupted, and it
  takes SQL text. Parameterized SELECTs run as `PREPARE p AS <sql>` and
  `EXECUTE p(<typed constants>)`. The values never enter the statement
  text, and they bind with the native binding's types: number to DOUBLE,
  bigint to BIGINT or HUGEINT, string to VARCHAR. DuckDB cannot PREPARE
  `CREATE TABLE ... AS`, which the engine uses for filtered sort indexes and
  cubes, so their arguments are inlined as the same typed, quoted literals,
  outside string literals, quoted identifiers and comments
  (`wasm/params.ts`, tested). That SQL comes only from the engine and the
  compiler.
- **Arrow.** DuckDB-WASM returns DuckDB's own Arrow export. Results already
  in the engine's mapping pass through byte for byte. Otherwise the driver
  re-encodes HUGEINT (exported as Decimal(38,0)), BLOB, nested types,
  ENUMs and NULL as Utf8 (`wasm/arrow.ts`).
- **Memory.** One memory limit for the whole worker: 1 GiB by default,
  `memoryLimitBytes` in `createWorkerEngine`. Nothing spills. DuckDB's
  "Out of Memory Error" becomes `out_of_memory`, with the message "This
  file is too large for the web demo. Open it in the Glassgrid desktop app
  (<DuckDB's detail>)", and the instance keeps working (tested in Node and
  Chromium). A WebAssembly trap (e.g. `memory.grow` failing) marks the
  instance dead and posts `gg:fatal`. The client then starts a new worker,
  registers the same sources again and fires `onRestarted`. A CSV scan needs
  about 61 MB of buffers in our tests (DuckDB asked for 30.5 MiB blocks), so limits below 128 MB
  make every scan fail.

## The web worker and its client

```ts
import { createWorkerEngine } from '@glassgrid/engine/web';

const engine = createWorkerEngine({
  extensionRepository: `${location.origin}/duckdb-extensions`, // for Parquet; see below
  memoryLimitBytes: 1024 ** 3,
});
const info = await engine.ready;                // { duckdbVersion, capabilities, extensionErrors }
const { handle } = await engine.registerFile(file);   // a picked or dropped File
// or: await engine.registerUrl('/samples/nyc-taxi-2m.parquet');
const { table } = await engine.open(handle);           // from here on, exactly the desktop API
const fetchPage = engine.pageFetcher(table.id, { viewId: 'grid', sort });
await engine.aggregate(table.id, spec, { viewId: 'chart:1', crossfilter: hint });
engine.onRestarted(() => { /* re-send setColumnTypes, re-query views */ });
```

- **Interface.** `EngineClientApi` (`@glassgrid/engine/client`) lists what
  both implementations have: open, profile, rows, fetchPage, pageFetcher,
  count, aggregate, prepareCrossfilter, setColumnTypes, ensureParquetCache,
  closeTable, clearCache, cacheStats, cancel, onEvent, onRestarted and
  dispose. The result types are the desktop client's. The desktop
  `EngineClient` declares `implements EngineClientApi`; that type-only
  edit is the one change to `apps/desktop/src/renderer`.
- **Transport.** The engine protocol (`packages/core`) runs over the
  worker's `postMessage`. Arrow results are copied out of the engine's
  result cache once and their `ArrayBuffer` is transferred (no structured
  clone). Control messages use `gg:` kinds (`worker/protocol.ts`):
  `gg:init`, `gg:registerSource`, `gg:ready`, `gg:fatal`,
  `gg:sourceRegistered`, `gg:registerFailed` and the `gg:cacheSelfTest`
  diagnostic. They play the part of Electron main: the page registers
  sources and gets opaque file handles. The worker never sees a path.
- **Sources.**
  - A `File` is registered with DuckDB-WASM as `BROWSER_FILEREADER`, so
    it is read in place with FileReaderSync and never copied.
  - A URL is registered as HTTP and read with synchronous range requests.
    It is accepted only from `allowedOrigins` (default: the page's own
    origin), so the demo reads no other host. The server must answer HEAD
    with Content-Length and support `Range`; Last-Modified feeds the
    fingerprint.
  - Files over `maxSourceBytes` (default 1 GB, from the design doc's risk
    table) are refused with `too_large` and a pointer to the desktop app.
- **Fingerprints** are the same function as on the desktop. For a `File`,
  the size is `size` and the mtime is `lastModified`. For a URL, they come
  from Content-Length and Last-Modified. The edges are read with
  `File.slice` or Range requests and hashed with `crypto.subtle`. The name
  is the file name (tested: same File, same key; changed contents, new
  key).
- **Parquet cache in OPFS.** `opfs://glassgrid-cache/...` maps to the OPFS
  folder `glassgrid/parquet`. Before a statement names a cache file, the
  worker opens a `FileSystemSyncAccessHandle` for it and registers it with
  DuckDB-WASM. It closes the handle before a rename or removal; renames use
  `FileSystemHandle.move`, falling back to copy and delete. DuckDB-WASM
  writes to OPFS handles only for `opfs://` names; other names go to its
  in-memory file system, as the cache self-test showed.
  - **Tested.** `gg:cacheSelfTest` runs the cache path with CSV instead
    of Parquet: DuckDB writes a `.partial` file, it is renamed, a new
    worker reads it back, then it is cleaned up. It passes in Chromium,
    which shows that copies survive a reload.
  - **LRU.** OPFS cannot set mtimes, so the LRU becomes oldest-written
    first. The cap is 2 GB by default (`parquetCacheMaxBytes`), and CSVs
    of 64 MB or more convert in the background at open.
  - **Without OPFS** (e.g. some private modes) the worker reports
    `cache: 'none'` and never converts.
  - **Two tabs.** A sync access handle locks its file, so two tabs cannot
    both read the same cached copy; the second one's views fail on it.
    This is not handled yet.

### Parquet needs the extension, served from our origin

DuckDB-WASM does not link Parquet in. `read_parquet` and `COPY ... (FORMAT
parquet)` exist only after `LOAD parquet`, which fetches
`<repository>/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm` (`wasm_mvp`
for the MVP build). The worker loads it before it locks the
configuration, from `extensionRepository`. The design therefore serves
the signed extension from the app's own origin, for example by copying it
into the web build. Unsigned extensions stay refused.

**Update (branch `m4-web`):** verified. The extension is served from
`apps/web/public/duckdb-extensions/`, and the engine's Chromium suite and the
web demo's E2E load it and read Parquet (including the OPFS Parquet cache).
See [m4-web-demo.md](m4-web-demo.md#parquet-on-duckdb-wasm-verified). The
Node `wasm` project still skips its Parquet variants.

**Not verified on this branch.** The sandbox's egress proxy blocks
extensions.duckdb.org, so the extension could not be downloaded or tested
here. On this branch DuckDB-WASM runs CSV only:

- `capabilities.parquet` is false and `extensionErrors` says why.
- Parquet sources are refused with `not_implemented`.
- Deep CSV pages use OFFSET, and no conversion runs.
- The Parquet variants of the suite are skipped on `wasm`.

The OPFS machinery the cache uses is tested with CSV (above). Integration
must fetch the extension (one file per WASM build), serve it,
and run the Parquet variants: `pnpm --filter @glassgrid/engine test` skips
them only while `read_parquet` is missing.

## DuckDB-WASM version

What I checked, on 2026-10-18:

| Source | Finding |
| --- | --- |
| `npm view @duckdb/duckdb-wasm dist-tags` | `latest` = 1.33.1-dev57.0 (published 2026-06-22), `next` = 1.33.1-dev65.0 (2026-09-29). Both are dev builds. |
| `npm view @duckdb/duckdb-wasm time` | The newest non-dev release is **1.32.0** (2025-12-16). Everything published since is 1.33.1-devN. |
| `SELECT version()` in each build (Node blocking bundle) | 1.32.0 = DuckDB **v1.4.3**; 1.33.1-dev57.0 = v1.5.4; 1.33.1-dev65.0 = v1.5.6 (the desktop's version) |
| `duckdb_extensions()` | No build links Parquet, JSON or ICU in. They are autoloadable extensions. |
| The engine suite on the WASM driver | 1.32.0 and 1.33.1-dev65.0 both pass everything that does not need Parquet: 92 + 10 tests at the time. |
| Parity with native 1.5.6 on 1M synthetic rows (columns, profile, distinct counts, first and sorted pages, bar, heatmap, histogram, line) | Identical for both versions, except `sum(DOUBLE)` in the last digits: single-threaded vs two-threaded summation order. Files: `benchmarks/m4/version-check-*.json`. |
| Package exports | In both versions `./blocking` points `import` at `dist/duckdb-node-blocking.mjs`, which does not exist. The browser blocking build is not exported. |
| GitHub releases | Not reachable from this sandbox (GitHub API access not enabled). |

**Decision: pin 1.32.0.** It is the newest stable release, and it supports
every DuckDB feature the engine uses (the full suite and the parity check).
Known differences from DuckDB 1.5.6 that the suite hit:

- `SET allowed_directories = ['/']` allows everything on 1.4.3 but not on
  1.5.6. Roots are always real folders, so this does not matter in
  practice.
- 1.4.3 has the same COPY `.tmp` quirk as 1.5.6.

The alternative is 1.33.1-dev65.0. It runs exactly the desktop's DuckDB
(v1.5.6), so desktop and web share one dialect, but it is a dev build from
duckdb-wasm's main branch. Switching is a one-line version change, plus the
patch file renamed to the new version, and the `wasm` vitest project then
validates it. Upgrade when a stable duckdb-wasm on DuckDB 1.5.x appears, or
when the compiler needs a 1.5-only feature. The `wasm` project catches that
on the first test that uses it.

**Patch.** `patches/@duckdb__duckdb-wasm@1.32.0.patch` (pnpm
`patchedDependencies`) adds a `browser` condition to `./blocking` that
points at `dist/duckdb-browser-blocking.mjs`, and exports that file. Without
it no bundler can import the synchronous browser build.

## Threads, cross-origin isolation, headers

- The worker runs the **EH** build (WebAssembly exception handling; every
  current browser), or **MVP** where that is missing: single-threaded
  DuckDB in both cases.
- The multithreaded **COI** build needs `SharedArrayBuffer`, hence cross-origin
  isolation:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`)
  - every subresource same-origin or served with
    `Cross-Origin-Resource-Policy`
- **We do not enable them.** The synchronous bindings cannot start
  DuckDB's pthread workers. The COI build would need DuckDB-WASM's async
  API in a nested worker, with its own worker hop per query, and
  DuckDB-WASM marks its threads support as experimental. COEP also blocks
  any cross-origin embed without CORP headers.
- The engine works under isolation: `GLASSGRID_COI=1` serves the test page
  with both headers, the page reports `crossOriginIsolated: true`, and all
  8 browser tests pass. Switching to threads later means a different
  binding in the worker, not a different engine.
- Other headers the web build needs:
  - `.wasm` files served as `application/wasm` (streaming compile).
  - In the CSP: `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`
    and `connect-src 'self'`.
  - Range, HEAD, Content-Length and Last-Modified on the sample data. Static
    hosts such as Vercel provide them.

## Security in the browser

There is no local file system: DuckDB can read only what the page
registered in this tab and the OPFS cache.

- **Sandbox.** Extension autoload and autoinstall are off, extensions load
  only from our origin before the lock, and external access is off with
  `allowed_directories` limited to `/gg/src/` and
  `opfs://glassgrid-cache/`. Configuration is locked.
- **Network.** DuckDB cannot fetch URLs; only registered HTTP sources are
  read, and registration accepts only `allowedOrigins`.
- **Requests** still carry no SQL or paths: the same Zod schemas as the
  desktop, and handles are opaque.
- **Difference from the desktop.** Tables share one allowlist, so a crafted
  query of one table could read another registered file. Both were picked
  by the same person in the same tab, and requests carry no SQL, so this
  matters only with an engine bug. Documented in `wasm/driver.ts`; the
  native per-table test (`security.test.ts`) runs only on `native`.

## Differences between the drivers

| Area | Native (desktop) | DuckDB-WASM (web) |
| --- | --- | --- |
| Interrupt | Immediate (ms) | At the next DuckDB step: up to a few hundred ms of a large sort. Tests that time answers allow 1.5 s on WASM (`latencyBudget`) |
| Concurrency | Threads; queries run in parallel | One thread; pending queries interleave step by step |
| Progress | `parquetProgress` with fractions | No progress API: `fraction: null` |
| Spilling | Private temp folder per table | None; past the limit, `out_of_memory` |
| Memory limit | Per table, half of RAM | One per worker, 1 GiB default |
| Isolation | Instance per table, allowlist per table | One instance, database per table, shared allowlist |
| Parquet | Built in | Only with the extension served (see above) |
| HUGEINT, TIME WITH TIME ZONE | Text | HUGEINT as text (same); TIMETZ as Time64 without its offset (DuckDB's Arrow export drops it) |
| Nested values as text | DuckDB's rendering | Best effort in JS (lists match; structs may differ in quoting) |
| `sum(DOUBLE)` | Multithreaded summation order | Single-threaded order: the last digits differ |
| Cache LRU | mtime bumped on use | Oldest-written first (OPFS mtimes are read-only) |
| Instance start | ~10 to 20 ms per table | ~1.2 s per worker in Chromium (fetch and compile 34 MB of WASM); tables then attach in ms |

## Numbers

Linux VM, 2 vCPU Xeon @ 2.1 GHz, 8 GB, load average about 1.5. Dataset:
`synthetic-1m-seed42` from `tools/datasets` (1,000,000 rows, 14 columns,
156 MB CSV; its zstd Parquet copy is 46 MB). Each step is timed from the
client side, transport included, through `PortEngineClient` and an
EngineSession: over a Node MessageChannel for native and WASM-in-Node, and
through `createWorkerEngine()` in HeadlessChrome 141 for the browser.

The workload (`src/testing/m4-bench.ts`) runs open → first page, profile,
the first page sorted by amount, a bar of rows per region, a
latitude × longitude heatmap, then a region brush. `prepare` builds the
heatmap, histogram and count cubes. `brush` answers those three views from
the cubes; `brush, plain SQL` answers them with no hint. The CSV is opened
with `parquet: 'never'` (raw CSV). Medians of 3 cold runs (a new service or
worker each).

| ms (median) | native CSV | native Parquet | WASM in Node, CSV | **web demo (Chromium worker), CSV** |
| --- | ---: | ---: | ---: | ---: |
| engine start | | | | 1,193 |
| open → first page | 131 | 78 | 283 | **491** |
| profile | 622 | 382 | 1,579 | **1,453** |
| sorted first page | 860 | 195 | 1,219 | **1,297** |
| bar (count by region) | 446 | 26 | 1,283 | **1,710** |
| heatmap (lat × lon) | 377 | 121 | 1,692 | **2,205** |
| brush start: build 3 cubes | 1,033 | 179 | 2,476 | **2,735** |
| brush, answered from cubes | 30 | 24 | 23 | **43** |
| brush, plain SQL | 1,010 | 130 | 1,778 | **2,238** |

JSON: [benchmarks/m4/engine-node-1m-linux-x64.json](benchmarks/m4/engine-node-1m-linux-x64.json),
[benchmarks/m4/engine-web-chromium-1m-linux-x64.json](benchmarks/m4/engine-web-chromium-1m-linux-x64.json).
The web demo's Parquet column is missing: the extension is not available
here (see Parquet).

**Reading them.**

- On 2 cores, single-threaded DuckDB-WASM is 2 to 6 times slower than
  native on full CSV scans.
- The browser adds 10 to 30% over WASM in Node (worker hops, FileReaderSync
  reads from a Blob).
- Interactions that do not scan stay fast: the first page, pages inside
  the top-K block, and cube-answered brushes (43 ms).
- Native Parquet is 3 to 17 times faster than native CSV on the same
  steps, which is why the samples should ship as Parquet and the web
  demo should serve the extension. A Parquet number for WASM is the first
  thing to record once it loads.
- At 1M rows every step is within the web demo's reach. The 10M-row
  budgets apply to the desktop app only.

To reproduce:

```sh
pnpm --filter @glassgrid/datasets exec tsx src/synthetic.ts --rows 1m --seed 42
# Parquet copy for the native column: COPY (FROM read_csv('out/synthetic-1m-seed42.csv')) TO 'out/synthetic-1m-seed42.parquet'
GLASSGRID_M4_BENCH_CSV=../../tools/datasets/out/synthetic-1m-seed42.csv \
GLASSGRID_M4_BENCH_PARQUET=../../tools/datasets/out/synthetic-1m-seed42.parquet \
  pnpm --filter @glassgrid/engine exec vitest run --project native src/m4-bench.test.ts   # native + WASM in Node, plus parity
GLASSGRID_M4_BENCH_CSV=... GLASSGRID_M4_BENCH_PARQUET=... pnpm --filter @glassgrid/engine bench:web   # Chromium
```

## Tests

| Suite | Count |
| --- | --- |
| `@glassgrid/engine`, project `native` | 153 passed, 3 opt-in benches skipped. This is the 140 moved tests plus `wasm/wasm-driver.test.ts` (10: sandbox, statements, interrupts, out of memory, arguments), 2 new Arrow cases and the scenario through `PortEngineClient`. |
| `@glassgrid/engine`, project `wasm` | 93 passed, 13 skipped: the Parquet variants, the native per-table security file and the native Arrow interval-overflow case |
| `@glassgrid/engine` e2e (Chromium, `pnpm --filter @glassgrid/engine e2e`) | 8 passed: start-up and capabilities, the shared scenario on a File, a sample over HTTP and a refused origin, the size cap, out of memory, abort, fingerprints, the OPFS cache round trip across workers. Also passes with COOP/COEP. |
| `@glassgrid/desktop` | 47 passed (renderer, plus `client-integration.test.ts` against the shared engine) |
| `xvfb-run -a pnpm e2e` | Electron 11 passed, 1 skipped; then the engine's Chromium tests (8) |

The shared scenario (`src/testing/scenario.ts`) runs the same steps on
native, on WASM in Node and on WASM in Chromium:

- open, first page and profile;
- sorted pages from the top-K block and from the index;
- a filtered page and count;
- every mark;
- cube answers against plain answers;
- setColumnTypes and its revert;
- abort, and closeTable followed by a reopen.

## For integration

- **Vite.**
  - Import `createWorkerEngine` from `@glassgrid/engine/web`. Its
    `new Worker(new URL('../worker/engine-worker.ts', import.meta.url), { type: 'module' })`
    and the `?url` imports of `duckdb-eh.wasm` and `duckdb-mvp.wasm` are
    handled by Vite.
  - Set `worker: { format: 'es' }`, `build.assetsInlineLimit: 0` (or at
    least never inline `.wasm`) and `resolve: { dedupe: ['apache-arrow'] }`.
    DuckDB-WASM imports apache-arrow 17 for helpers the engine never calls;
    deduping cuts the worker from 1.8 to 1.57 MB of JS.
  - `packages/engine/e2e/vite.config.ts` is a working example.
  - Main-thread cost of the client is about 74 KB gzip (Arrow 21 and Zod
    included). The worker loads on its own: about 1.6 MB of JS plus
    34 MB of WASM (7.8 MB with gzip, smaller with brotli).
- **Hosting.**
  - Serve `.wasm` as `application/wasm`.
  - Serve the sample datasets from the app's origin, with Range,
    Content-Length and Last-Modified.
  - Copy the signed Parquet extension (`v1.4.3/wasm_eh` and `wasm_mvp`) under
    `/duckdb-extensions/` and pass `extensionRepository`.
  - COOP/COEP are not needed.
- **Sample data URLs.** Pass relative URLs to `engine.registerUrl()`; they
  resolve against the page. Other origins need `allowedOrigins`. Samples
  should be Parquet; a CSV sample works too, and converts in the
  background once Parquet is available.
- **App wiring.**
  - The web shell plays the part of Electron main: a dropped or picked File
    goes to `registerFile`, a sample link to `registerUrl`, then
    `open(handle)`.
  - Show `too_large`, `not_allowed` and `out_of_memory` messages as they
    are.
  - After `onRestarted`, re-send type overrides and re-query, as on the
    desktop.
  - `engine.ready.capabilities` tells the UI whether progress and Parquet
    are available.
- **Shared app.** Type the engine as `EngineClientApi` and both clients fit.
  The desktop renderer's EngineClient still duplicates `PortEngineClient`'s
  logic. When `packages/app` lands, it could become
  `PortEngineClient` + the preload port, and render-perf hooks could
  become an option.
- **Lockfile and root config.** This branch adds `packages/engine`,
  `patches/` and `patchedDependencies` in `pnpm-workspace.yaml`, a CI step
  that installs Chromium and runs the engine's browser test, and the
  engine's browser test at the end of the root `e2e` script.

## Not done / follow-ups

- Parquet on DuckDB-WASM (extension hosting) is unverified, and so are the
  Parquet variants of the WASM suite (see above).
- Firefox and Safari are not tested. Points to watch:
  - FileReaderSync and sync XHR in workers exist in both.
  - OPFS sync access handles need a recent Firefox and Safari (check the
    minimum versions against the browsers the demo supports).
  - `FileSystemHandle.move` has a copy fallback.
- Two tabs on the same OPFS cached copy: the second tab's views fail on
  that file. Lock-aware fallback to the CSV is not built.
- The DuckDB-WASM instance is not restarted after `DETACH` leaks or long
  sessions. Memory stays bounded by the limit, but WASM linear memory
  never shrinks.
- The COI (threads) build is not used (above).
