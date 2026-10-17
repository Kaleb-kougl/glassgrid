# M1 notes: data path and command registry

Status of milestone M1 after integrating its three parallel branches.
Dated 2026-10-17. Builds on [M0](m0-notes.md).

| Branch | What it built | Notes |
| --- | --- | --- |
| `m1-compiler` | `ChartSpec`, `Filter`, `RowQuery` and `ColumnProfile` schemas (`packages/core/src/spec`), the pure SQL compiler (`packages/core/src/sql`) and its property tests | [m1-compiler.md](m1-compiler.md) |
| `m1-commands` | Workspace state, Immer store with undo/redo, command registry with tiers and MCP parity check (`packages/core/src/state`, `packages/core/src/commands`) | [m1-commands.md](m1-commands.md) |
| `m1-engine` | `QueryService` (open, profile, rows, count, cancel), Parquet cache, result cache, per-view ordering, typed renderer client (`apps/desktop/src/engine`, `packages/core/src/protocol`) | [m1-engine-notes.md](m1-engine-notes.md) |

The per-branch notes are kept as written. Where integration changed a
contract they describe, this file is authoritative; see
[Changes to the per-branch contracts](#changes-to-the-per-branch-contracts).

## What M1 delivers

```
click / shortcut ──▶ registry.dispatch(name, input, { caller: 'user' })  ──▶ WorkspaceStore (undo, "by AI")
       │                                                                        │ useSyncExternalStore
       ▼                                                                        ▼
openFileAction: dialog (main) ─▶ engine open ─▶ dispatch openFile         views (first page, profile, chart)
                                                                                │ EngineClient (viewId, seq)
                                                                                ▼
                         EngineSession: Zod ─▶ compileWhere / compileChartQuery ─▶ QueryService ─▶ DuckDB
                                                                                ◀── Arrow IPC ──┘
```

- **One schema per concept in core.** `ColumnType`, `SortKey`, `ColumnProfile`,
  `Filter` and `ChartSpec` live in `spec/`; the engine protocol and workspace
  state import them. The engine's `Fingerprint` is the one fingerprint schema.
- **Filters reach the engine.** `rows` and `count` requests take
  `filters: Filter[]`. `EngineSession` compiles them with
  `compileWhere(filters, columns)` and hands `QueryService` the
  `{ sql, params }` fragment as `where`. The fragment is the only placeholder
  source (`$1..$n`); the engine writes its offsets, limits and row-number
  bounds as literals, so the two compose without renumbering. Sorted or
  filtered pages use the engine's materialized row-number index per
  (sort, filter), so deep filtered pages stay deterministic.
- **Aggregates run.** `aggregate { spec }` takes `ChartSpec` plus an optional
  `pixelWidth`. The session compiles it with
  `compileChartQuery(quoteIdent(QueryService.viewName(table)), spec, profile.columns, { pixelWidth })`
  using the table's cached profile (computed on first use), and runs it
  through the result cache keyed by SQL, bound values and `pixelWidth`.
  Scatter specs follow the compiler's contract: `compileScatterCountQuery`
  first, and above `scatterPointLimit(spec)` points the engine compiles
  `scatterAsHeatmap(spec)` instead. The reply is
  `aggregate { ipc, mark, fellBackToHeatmap, engineMs, cached }`, where `mark`
  is the mark the rows are shaped for (`heatmap` after a fallback).
- **Compile errors are user errors.** A `CompileError` from any compile step
  becomes `error { code: 'bad_request', message, path }`; `EngineClient`
  surfaces it as `EngineRequestError` with the same `path`. The message is
  the compiler's, e.g. `y.aggregate "sum" needs a numeric column, but
  "category" is text. Use "count" instead.`
- **Renderer on the command registry.** One workspace per window
  (`createWorkspace` with `Date.now`, `crypto.randomUUID` ids and the desktop
  policy: `confirmWrite` is true for `user` and false for `ai`; `allowRaw` is
  false). React reads it with `useSyncExternalStore`. The window shows the
  column list with a type dropdown (`setColumnType`), Undo/Redo buttons and
  Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z, the history with each entry's caller
  ("by you" / "by AI"), the M0/M1 count and profile panels, and a debug panel
  that runs a bar chart aggregate (`viewId: 'chart:debug'`) and shows its rows
  as a table. Real grid and charts come in M2 and M3.
- **The async action pattern.** `openFileAction` runs main's dialog, then the
  engine's `open`, then dispatches `openFile` with the handle, display name,
  fingerprint and inferred columns. The first grid page and the profile are
  views of the new data source: they query when `openFile` changes it, and
  again after undo/redo changes it back.

### Client API additions

```ts
await engine.rows(table, { offset: 0, limit: 1000 }, { viewId: 'grid', filters });
await engine.count(table, { viewId: 'status', filters });
const chart = await engine.aggregate(table, { mark: 'bar', x: { column: 'category' }, pixelWidth: 640 }, { viewId: `chart:${id}` });
chart.table; chart.mark; chart.fellBackToHeatmap;
```

`aggregate` and `filters` are validated in the renderer before sending, so a
malformed spec rejects with `bad_request` without a round trip. Use
`viewId: 'chart:<id>'` per chart card so a newer request (e.g. while
brushing) supersedes the stale one.

## Exit gate

> Compiler property tests green; open-to-first-query baseline recorded.

**Compiler property tests: green.** `packages/core/test/compiler.property.test.ts`,
7 properties (filters and count, rows, bar, histogram, heatmap, line/area with
M4, scatter with its count), 200 runs each, seed 20261017, each compared with a
JS reference on random DuckDB tables.

**Open to first query: recorded.** E2E (`pnpm e2e`, Playwright driving
Electron, renderer `performance.measure`), 1,000,000-row CSV (31.9 MB),
"Open CSV" click to the first 1,000-row page decoded in the renderer. The
measure now spans the dialog hook, engine `open`, the `openFile` dispatch and
the first-page view's query.

| 1M rows, three runs | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| open → first page (round trip) | 157 ms | 200 ms | 134 ms |
| engine `open` | 85 ms | 72 ms | 83 ms |
| engine first page | 46 ms | 52 ms | 29 ms |
| profile round trip (after first page) | 235 ms | 247 ms | 199 ms |
| bar aggregate, cold (count by category) | 94 ms | 89 ms | 89 ms |
| count cold / warm (result cache) | 89 / 13 ms | 83 / 13 ms | 81 / 12 ms |

Median open → first page: **157 ms**. Machine: Linux container, 2 vCPU Xeon
@ 2.1 GHz, 8 GB; Electron 44.9.0, `@duckdb/node-api` 1.5.6-r.1, unpackaged
build. The benchmark JSON (`apps/desktop/e2e-results/open-to-first-page-*.json`)
carries `milestone: "M1"` and an `exitGate` block; the last run's files are
copied to [benchmarks/m1/](benchmarks/m1/). CI uploads the same files per OS
(macOS arm64, Windows x64, Ubuntu), packaged and unpackaged.

## Tests

| Suite | Count | Result |
| --- | ---: | --- |
| `packages/core` (Vitest: schemas, compiler snapshots, compiler property tests, commands, registry, history property test, parity, protocol, workspace state) | 122 tests, 10 files | pass |
| `apps/desktop` engine (Vitest, real DuckDB: query service, session, caches, cancellation, fingerprint, compiler integration) | 91 tests, 9 files (+1 skipped bench, opt-in via `GLASSGRID_BENCH_ROWS`) | pass |
| `apps/desktop` renderer (Vitest: `openFileAction` with a fake engine, `App` with React Testing Library on jsdom) | 8 tests, 2 files | pass |
| E2E (Playwright + Electron, 1M rows) | 4 tests | pass |

New in integration:

- `src/engine/compiler-integration.test.ts`: filtered `count` and `rows`
  (unsorted and sorted, first and deep pages) on CSV and Parquet for six
  filter sets, each compared with a JS filter over the generated rows; one
  aggregate test per mark (bar, histogram, line, area with M4 and the
  `pixelWidth` cache key, heatmap, scatter), the scatter → heatmap fallback,
  the Parquet view and `CompileError` → `bad_request` with its path.
- `src/renderer/src/App.test.tsx`: open → column list → change a type →
  undo/redo by button and keyboard, "by AI" labels, the aggregate debug table.
- E2E: change `amount` to `text` in the UI, undo (button), redo and undo
  (keyboard), assert the dropdown reverts; one bar aggregate round trip shown
  as a table and checked against the fixture's category counts.

## Changes to the per-branch contracts

- **`ColumnProfile`.** The engine's profile columns are
  `TableColumnProfile` = spec `ColumnProfile` + `duckdbType`. The engine's
  `approxDistinct` is now `distinctCount` (still a HyperLogLog estimate).
  The protocol's `Scalar` is the spec's `ProfileValue`.
- **Sort keys** are the spec's `SortKey` (`column`, `direction`). The
  engine's optional `nulls: 'first' | 'last'` was dropped: NULLs sort last in
  both directions, as in `compileRowsQuery`.
- **Fingerprint** is the engine's `{ sizeBytes, mtimeMs, headTailSha256, key }`
  everywhere; state's placeholder `{ sizeBytes, mtimeMs, sampleHash }` is gone.
- **View ids.** The protocol's per-request stream id is `QueryViewId`
  (`grid`, `chart:<id>`, `profile`, ...). `ViewId` in workspace state is the
  filter-owner id (a chart id or `grid`); its alphabet excludes `:`.
- **Workspace state** uses `ChartSpecSchema` for `charts[].spec` and
  `FilterSchema` for `filters[viewId]` (one selection per view, as in the
  design's cross-filtering model).
- **`sql.ts` is gone.** `ROW_COUNT_COLUMN` lives in `sql/builder.ts` and is
  exported from `sql/`; the unused `Sql.countRows` was removed (the web
  placeholder shows `compileCountQuery` instead).
- **`aggregate`** answers `aggregate` instead of `arrow`;
  `not_implemented` is no longer used by any request.
- **`openFileAction`** dispatches right after the engine's `open` (whose
  `TableHandle` already carries the inferred column types) instead of after a
  profile, so the column list and first page do not wait for a full-table
  scan (2 to 5 s at 10M rows on CSV). The profile is a view that queries once
  the data source changes.

## Known gaps carried to M2 and later

- **CSV deep and sorted pages are slow until the Parquet cache exists.** At
  10M rows a deep unsorted page takes ~3 s and a first sorted page ~6 s on
  CSV, against 10 ms and 2.6 s on Parquet. Files over 200 MB convert in the
  background; smaller ones stay on CSV. A top-N fast path for first sorted pages is an M2
  candidate (see [m1-engine-notes.md](m1-engine-notes.md)).
- **DECIMAL, TIME and INTERVAL arrive as text** in Arrow results (encoded per
  value in JS); DECIMAL is still `decimal` in the profile and compiles as
  DOUBLE.
- **Column type overrides are state only.** `setColumnType` changes the
  workspace; the engine still queries with the inferred types. Applying
  overrides (casts in the view, compile with effective types) is M2 work.
- **DuckDB external-access lockdown is deferred to M5**
  (`enable_external_access = false` with an allowed-paths list).
- **Engine respawn is not E2E-tested.** Table ids survive a respawn by
  design (reopen on first use), but only unit tests cover it.
- **The fingerprint misses same-size, same-mtime edits** in the middle of a
  file (it hashes the first and last 1 MB), so such an edit can serve a stale
  Parquet copy.
- **Agent commands do not yet queue during a brush**; that gate belongs
  around `dispatch` in the renderer once brushing exists (M3).
- **No AI caller exists yet**; the "by AI" label is rendered from the
  history's `caller` and covered by a component test.
