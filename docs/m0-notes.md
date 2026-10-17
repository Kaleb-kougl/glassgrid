# M0 notes: spike and scaffold

Status of milestone M0 and the decisions behind it. Dated 2026-10-17.

## What M0 proves

A user opens a CSV, presses **Count rows**, and the renderer shows the row
count and timings. Underneath, that exercises every seam the real app needs:

```
renderer (sandboxed, React)          main (Electron)                engine (utilityProcess)
-----------------------------        ---------------------          -----------------------
window.glassgrid.openCsv()  ── ipc ─▶ dialog / E2E hook
                                     path → handle   ── parentPort ─▶ stat(), handle → path
            ◀── { handle, name, size } ─┘
window.glassgrid.requestEnginePort() ▶ MessageChannelMain
            ◀── port2 (via preload) ──┘└── port1 ──────────────────▶ attachPort
EngineClient.countRows(handle) ═════════════ MessagePort ═════════▶ DuckDB: count(*) FROM read_csv_auto($1)
            ◀═══════════════════ Arrow IPC bytes + engineMs ═══════
tableFromIPC → render
```

- **Query traffic never touches main.** Main only brokers ports and maps
  handles to paths.
- **The renderer never sees or sends a path.** It gets an opaque, branded
  `FileHandle` (`fh_<uuid>`, validated by Zod on every hop) plus a display name.
- **Every message is validated** with the Zod schemas in `@glassgrid/core`
  (`EngineRequestSchema`, `EngineResponseSchema`, `ControlMessageSchema`,
  `ControlReplySchema`, `OpenCsvResultSchema`).

## Arrow path: constructed, not native

`@duckdb/node-api` 1.5.6-r.1 does **not** expose DuckDB's Arrow C API. The
binding declarations (`@duckdb/node-bindings/duckdb.d.ts`) list
`duckdb_query_arrow`, `duckdb_data_chunk_to_arrow`, `duckdb_to_arrow_schema`
and friends only as commented-out C prototypes, and the high-level API has no
Arrow method.

So the engine reads the result with `runAndReadAll`, maps each DuckDB column
type to an Arrow type, builds vectors with `vectorFromArray` and serialises the
table with `tableToIPC(table, 'stream')` (`apps/desktop/src/engine/arrow.ts`).
Primitive types (bool, signed/unsigned ints, float, double, varchar) map
natively; everything else is temporarily carried as its DuckDB string form.

Alternatives considered:

- **DuckDB's `arrow` community extension (`to_arrow_ipc`)** would give native
  IPC bytes, but it must be downloaded from `extensions.duckdb.org` at runtime.
  An offline-first desktop app should not fetch and load native code behind the
  user's back (the engine sets `autoinstall_known_extensions=false`), and the
  host is unreachable from some networks (it is blocked in the M0 build
  container).
- **Native Arrow in node-api**: track upstream; when it lands, swap the body of
  `readerToArrowTable` and keep the wire format unchanged.

The cost of the constructed path is a JS round trip per value. That is
irrelevant for a one-row count but will matter for grid pages; M1 should
either convert per `DuckDBDataChunk` straight from vector buffers or adopt the
native path if available.

## Transport details

- Main creates a `MessageChannelMain` per renderer, posts `port1` to the
  utility process (`child.postMessage(msg, [port1])`) and `port2` to the
  renderer (`webContents.postMessage(channel, null, [port2])`). The preload
  forwards it with `window.postMessage(tag, '*', ports)` because MessagePorts
  cannot cross `contextBridge`. The page accepts it only when
  `event.source === window` and the tag matches.
- The renderer **asks** for a port after installing its listener, instead of
  main pushing one on `did-finish-load`. That removes the race where a port
  arrives before the page's JS runs, and reloads simply request a new one.
- If the engine crashes, main respawns it (max 3 restarts per minute), replays
  file registrations and pushes a fresh port to every window. The renderer
  swaps ports and rejects in-flight requests with `engine_restarted`.
- `MessagePortMain.postMessage` only accepts ports in its transfer list, so the
  Arrow `Uint8Array` is structured-cloned (copied) once on the way to the
  renderer. Fine for M0; measure again for large result pages.

## Bound parameters

`SELECT count(*) AS row_count FROM read_csv_auto($1)` with the path bound as a
prepared-statement parameter works in DuckDB 1.5.6 (both `$1` and `?`). No
path is ever interpolated into SQL.

## Native module: no rebuild

`@duckdb/node-api` uses N-API (Electron 44 reports `napi: 10`, Node 24.22), so
the published prebuilt binary loads in Electron's utility process as-is.
Verified in the Linux container: the E2E suite runs DuckDB inside the
`utilityProcess` both from `out/` and from a packaged `linux-unpacked` build,
with `npmRebuild: false`, so no `@electron/rebuild` step ever runs.

## Packaging

- `asarUnpack: '**/node_modules/@duckdb/**'` puts `duckdb.node` and
  `libduckdb.{so,dylib,dll}` in `app.asar.unpacked/` (verified on Linux: 69 MB
  unpacked, 1.7 MB asar).
- Only `@duckdb/node-api` is a runtime `dependency`. Everything else that ships
  (`@glassgrid/*`, `zod`, `apache-arrow`, React) is a devDependency that
  electron-vite bundles; electron-vite externalises `dependencies` only.
- electron-builder 26 detects the pnpm workspace and collects production deps
  itself; no `node-linker=hoisted` needed. It warns that other platforms'
  optional `@duckdb/node-bindings-*` packages are absent; that is expected,
  since each OS builds its own package in CI. Cross-arch builds (e.g. macOS x64
  from an arm64 runner) will need pnpm `supportedArchitectures`.
- macOS: ad-hoc signature (`identity: '-'`), hardened runtime off until
  Developer ID signing and notarization land. **Not verified locally.**
- Windows: NSIS target, unsigned. **Not verified locally.**

## Security posture

- `contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity` on.
- CSP meta: `default-src 'self'; script-src 'self'; style-src 'self'; …;
  object-src 'none'; base-uri 'none'; form-action 'none'`. In `electron-vite
  dev` only, a Vite plugin adds `'unsafe-inline'` to `style-src` because Vite
  injects CSS through `<style>` tags; production HTML is untouched. Verified
  that dev mode (HMR websocket, React Refresh) and production builds run with
  no CSP violations; E2E fails on any renderer console error.
- `will-navigate`, `will-redirect` and `will-attach-webview` are prevented and
  `setWindowOpenHandler` denies, for every WebContents. All permission requests
  and checks are denied.
- IPC handlers reject senders that are not the app's own top-level frame.
- The E2E hook (`GLASSGRID_E2E_OPEN`) is read only when `GLASSGRID_E2E=1`.

## Benchmark baseline (Linux container, 2 vCPU Xeon @ 2.1 GHz, 8 GB)

Fixture: `id,category,amount,created_on`, generated by `e2e/csv-fixture.ts`.
"Cold" is the first query in a fresh engine process; the file is still in the
OS page cache because it was just written.

| Rows | File | Cold round trip (engine) | Warm round trip (engine) |
| ---: | ---: | ---: | ---: |
| 1,000,000 | 30 MB | 143 ms (135 ms) | 124 ms (122 ms) |
| 1,000,000 (packaged) | 30 MB | 155 ms (147 ms) | 141 ms (139 ms) |
| 10,000,000 | 313 MB | 802 ms (792 ms) | 736 ms (734 ms) |

These are single runs from a shared, noisy 2-vCPU VM: across six 1M-row runs
the cold round trip ranged from 143 to 490 ms (median about 210 ms). Treat the
numbers as an order of magnitude, and compare CI artifacts per runner instead.

Round trip is the renderer's `performance.measure('glassgrid:count-rows')`
(click handler to decoded Arrow); engine time is DuckDB plus Arrow encoding.
Transport and decode add roughly 2 to 10 ms. CI uploads the JSON for each OS
as the `benchmark-<os>` artifact.

## Toolchain notes

- **TypeScript 6.0.3**, not 7.x: typescript-eslint 8.71 peer-requires
  `typescript <6.1`, and the native TS 7 compiler does not provide the JS API
  that type-aware linting uses.
- **Electron 44 downloads its binary lazily** (no postinstall). The first
  download in the build container failed inside undici
  (`AssertionError: assert(!this.paused)`, connection ended mid-transfer by the
  egress proxy); a retry succeeded. CI runs `install-electron` explicitly
  before tests, with a cache.
- pnpm 10 blocks dependency build scripts; none are needed
  (`electron-winstaller`'s is explicitly ignored).

## Not yet verified

- macOS (arm64) and Windows builds, E2E and packaging: covered by CI only.
- Ubuntu CI relies on `kernel.apparmor_restrict_unprivileged_userns=0` for the
  Chromium sandbox; locally the suite runs as root and passes `--no-sandbox`.
- AppImage/DMG/NSIS artifacts: only `--dir` packaging was exercised.
