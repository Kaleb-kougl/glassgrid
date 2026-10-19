# M4 notes: the public web demo

Branch `m4-web`, dated 2026-10-18. Milestone M4 asks for "three sample
datasets as Parquet; Vercel deploy with a preview per PR; web first-load JS
< 400 KB gzip, excluding DuckDB-WASM", and its exit gate is "the public demo
link opens a sample workspace in Chrome, Firefox and Safari" (see
[technical-design.md](technical-design.md#web-demo-target)). This branch
turns `apps/web` from a shell on a stub engine into that demo. It builds on
[m4-engine-portability.md](m4-engine-portability.md) (the engine worker),
[m4-app-package.md](m4-app-package.md) (the shared app and the web platform)
and [m4-persistence.md](m4-persistence.md) (the `.glassgrid` format).

| Goal | Result |
| --- | --- |
| The real engine in the browser | DuckDB-WASM 1.32.0 (DuckDB v1.4.3) in a Web Worker replaces the stub. The page loads no DuckDB code itself. |
| Parquet on WASM | **Verified in Chromium.** The signed Parquet extension is served from our own origin (`/duckdb-extensions/v1.4.3/`). The engine reports `parquet: true` with no extension errors. `read_parquet` over HTTP works, and so does the OPFS Parquet cache (CSV to Parquet, read back by a new worker). |
| Three sample datasets | Synthetic taxi trips (2,000,000 rows), retail orders (1,500,000) and sensor readings (1,382,400). Each is zstd Parquet of 8 to 21 MB, 38 MB in all, committed. |
| Sample workspaces | One `.glassgrid` v1 workspace per sample, with four cross-filtered charts. `/?sample=taxi`, `/?sample=retail` and `/?sample=sensors` open them, and the start screen offers all three. |
| Header CSP | `script-src 'self' 'wasm-unsafe-eval'` with no `'unsafe-eval'`. It is sent as a header, so it also covers the engine worker. Two code-generation paths were found and removed (below). |
| Budget | First-load JS for `/` is **247.6 kB gzip** of 400 kB. The worker side (1.6 MB of JS plus 34 MB of WASM) loads in the worker and is not part of first load. |
| Opening a sample (Chromium, localhost, cold) | Navigation to the last chart drawn takes **3.0 to 3.2 s**: DuckDB-WASM ready at about 1.7 s, the workspace loaded at about 2.0 s, charts after about 1.0 to 1.3 s more. A brush takes 115 to 265 ms until every view is painted. |
| Hosting | Changed after M4: the demo is served as a static subfolder of the portfolio site, `/glassgrid/`, from a released tarball. `apps/web/hosting.ts` holds the headers and rewrites for both a root deploy (`vercel.json`) and the subfolder (`glassgrid-hosting.json`). Nothing is deployed yet: see [Hosting](#hosting). |

## Architecture

```
page (main thread)                                     engine worker (module worker, same origin)
──────────────────                                     ───────────────────────────────────────────
main.tsx ── zod-jitless, route ──▶ app-route.tsx       engine-worker.ts
  App (@glassgrid/app) on createWebPlatform(web)         QueryService + EngineSession (@glassgrid/engine)
  web-engine.ts: createWorkerEngine(…) ── postMessage ─▶ WasmDriver on DuckDB-WASM's blocking build
     registerFile(File) / registerUrl('/samples/…')       BrowserFiles: File (FileReaderSync), HTTP (sync XHR, Range), OPFS cache
  samples.ts: fetch .glassgrid → parseWorkspace          LOAD parquet from /duckdb-extensions (before lock_configuration)
     → registerUrl → open → loadWorkspace               ◀── Arrow IPC (transferred ArrayBuffers)
```

| File | What |
| --- | --- |
| `apps/web/src/app-route.tsx` | Mounts the app. It creates the workspace and the DuckDB-WASM web engine, reads `?sample=` into `initialOpen`, and keeps `?sample=` in the address bar in step with what is open. |
| `apps/web/src/web-engine.ts` | `createDuckdbWebEngine`. It wraps `createWorkerEngine({ extensionRepository: origin + base + 'duckdb-extensions' })` into the web platform's `WebEngine` (`registerFile`, `samples`, `openSample`). It logs `[glassgrid] DuckDB-WASM v1.4.3 ready (parquet: …, cache: …)` and sets `performance` marks. |
| `apps/web/src/samples.ts` | The sample catalog and `openSampleWorkspace` |
| `apps/web/src/web-platform.ts` | Unchanged apart from comments, `.parquet` in the picker and the 1 GiB limit (the worker's own cap) |
| `apps/web/src/zod-jitless.ts` | `z.config({ jitless: true })`, imported first (see CSP) |
| `apps/web/csp.ts` | The policy: `WEB_CSP` (meta) and `WEB_CSP_HEADER` (header) |
| `apps/web/src/base.ts` | The base path (`import.meta.env.BASE_URL`): every URL the app builds goes through it |
| `apps/web/hosting.ts` | The headers and rewrites, in one place; `vercel.json` and `dist/glassgrid-hosting.json` come from it |
| `apps/web/vercel.json` | Build, rewrites, headers for a root deploy (generated) |
| `apps/web/e2e/serve.ts` | Serves `dist/` with `vercel.json`'s rewrites and headers at the root, or `glassgrid-hosting.json`'s under a base (as Next.js would), with Range and HEAD |
| `apps/web/public/duckdb-extensions/` | The signed Parquet extension. The [README](../apps/web/public/duckdb-extensions/README.md) has sources, hashes and how to refresh it. |
| `apps/web/public/samples/` | The sample Parquet files, workspaces and `samples.manifest.json` |
| `tools/datasets/src/samples.ts` | Generates the samples and the workspaces |
| `packages/app/src/App.tsx` | New optional prop `initialOpen` (additive) |
| `packages/engine/src/wasm/arrow.ts`, `src/worker/engine-worker.ts` | CSP fixes and the OPFS feature check (below) |

- **When DuckDB loads: on first intent** (branch `pres-polish`).
  - `createWorkerEngine({ start: 'lazy' })` creates no worker until
    `start()`, a registration or the first request (a request waiting for a
    port calls `PortEngineClient.onPortWanted`). Subscribing to engine
    events at mount does not start it. `eager` stays the default
    elsewhere (engine tests, the browser bench).
  - The web demo starts it on a `?sample=` link right in `mountApp`, before
    React mounts, and otherwise warms it up through
    `Platform.files.prepare()`: pointer or focus on **Open CSV…** or a
    sample, a file dragged over the window, and the file picker opening
    (DuckDB-WASM downloads while the person picks a file).
  - The start screen alone fetches no worker and no WebAssembly: the smoke
    E2E checks the network for `engine-worker`, `duckdb-*` and `.wasm`
    until a sample is hovered.
  - The worker script, DuckDB-WASM's JS glue (1.16 MB) and the EH build
    (34 MB, 7.7 MB gzip) are then fetched by the worker. The gallery route
    never starts it.
  - Deep-link time to first chart did not change (medians of six
    interleaved cold runs, eager → lazy: taxi 4,506 → 4,383 ms, retail
    3,822 → 3,705 ms, sensors 3,850 → 3,816 ms; engine ready 2,340 →
    2,354, 2,320 → 2,233, 2,342 → 2,312 ms). The machine was busier than
    for the table below, so compare the pairs, not the absolute numbers.
- **The stub engine is deleted.** That is `src/stub-engine/` (its 8 tests
  went with it), the badge and its CSS. `apache-arrow` stays in `apps/web`'s
  dependencies because `resolve.dedupe` needs to resolve it from the app.
- **Vite.**
  - `worker.format: 'es'` and `resolve.dedupe: ['apache-arrow']` (DuckDB-WASM
    pulls in Arrow 17).
  - `.wasm` is never inlined.
  - `chunkSizeWarningLimit` is 2 MB, for the worker's DuckDB chunk.

## Samples

| Id | Link | File | Rows | Parquet | Charts |
| --- | --- | --- | ---: | ---: | --- |
| `taxi` | `/?sample=taxi` | `taxi-trips-2025h1.parquet` | 2,000,000 | 20.8 MB | trips per day (line), trips by pickup zone (bar), trip distance (histogram), pickup locations (lon × lat heatmap) |
| `retail` | `/?sample=retail` | `retail-orders-2023-2025.parquet` | 1,500,000 | 11.1 MB | revenue per month (area), revenue by category (bar), orders by channel (bar), order value (histogram) |
| `sensors` | `/?sample=sensors` | `sensor-readings-2025-09.parquet` | 1,382,400 | 8.0 MB | hourly average temperature by site (line, colour), temperature (histogram), readings by status (bar), temperature × humidity (heatmap) |

- **Synthetic, made up from scratch.** TLC taxi data is unreachable from
  this sandbox, and its terms would need tracking anyway.
  `pnpm --filter @glassgrid/datasets samples` generates all three with
  seeded DuckDB SQL, with shapes worth brushing:
  - taxi: rush hours, weekday/weekend and holiday dips, slow growth,
    airport runs, cash trips without tips;
  - retail: seasonality, a Black-Friday peak, garden in spring, toys in
    December, a mostly-null rating column;
  - sensors: a daily temperature cycle per building, an office occupied on
    weekdays, a cold store whose door is left open now and then, offline
    readings as nulls, batteries draining.

  Details are in [tools/datasets/README.md](../tools/datasets/README.md#web-demo-samples-pnpm---filter-glassgriddatasets-samples).
- **Committed, not generated at build time.** All three come to 38 MB, under
  the 50 MB line, and generation is byte-deterministic (two runs compared).
  Committing them means:
  - a Vercel build needs no native DuckDB and no extra minute;
  - previews serve exactly the bytes the tests ran on;
  - the workspaces' fingerprints and column types match the files they
    describe.

  The cost is 38 MB in git history per regeneration, so regenerate rarely.
  A sample's bytes never change under the same name (the files are cached
  as immutable).
- **Parquet layout.**
  - zstd level 9, row groups of 122,880 rows.
  - Parquet v2 encodings: timestamps and the time-ordered `order_id` are
    delta-encoded. Rows are sorted by time, so a time brush prunes row
    groups.
  - Moving to v2 and dropping a redundant `dropoff_at` column took taxi from
    31 MB to 21 MB.
- **Workspaces.**
  - Written with core's `serializeWorkspace`, so they are valid by
    construction, and the generator compiles every chart against the file's
    real columns and ranges first.
  - Column types are what the engine infers from the Parquet file.
  - The fingerprint is the engine's function of the file, with a fixed
    mtime, so the files are reproducible.
  - `apps/web/src/samples.test.ts` parses all three with core's reader,
    checks charts, cards and columns against `samples.manifest.json`, and
    checks the start screen's catalog and sizes. The E2E fails on any
    restore warning (for example a column whose inferred type changed).

### Opening a sample

`files.openSample(id)` (web platform) → `openSampleWorkspace`:

1. `fetch('/samples/<id>.glassgrid')`, then `parseWorkspace` (core: migrate,
   validate). Failures come back as `{ status: 'failed', message }`, which
   the app shows as a toast with Retry.
2. `registerUrl('/samples/<file>.parquet', { name })`, then
   `engine.open(handle)`. The data is relinked by URL. The fingerprint is
   not compared, since a sample's Last-Modified depends on the deployment.
3. `restoreWorkspace` runs for its warnings (logged as `[glassgrid] …`), then
   core's `loadWorkspace` command applies the workspace. This is the state
   change a desktop `.glassgrid` open ends with: one undo entry, clean, with
   `document.fileName` set to `<id>.glassgrid` and no document id.
4. It resolves `{ status: 'cancelled' }`, so the app's file-open path, which
   called it as a picker, records nothing more. This reuses the existing
   `Platform.files.openSample` hook without changing core's
   `OpenCsvResult`. A dedicated result kind would be cleaner if the desktop
   ever offers samples.

- **`/?sample=<id>`.** The shell passes
  `initialOpen = () => files.openSample(id)` to `<App>`. The app runs it once
  at mount through its normal open path, with the "Opening…" state, the
  error toast and Retry.
- **The address bar.**
  - Clicking a sample on the start screen puts `?sample=<id>` in the address
    bar (`history.replaceState`), so the link is shareable.
  - Opening any other file, or undoing back to the start screen, removes it.
  - Unknown ids are ignored, so the start screen shows.

What DuckDB-WASM fetches for a sample, observed in Chromium:

1. A HEAD request (registration: size and Last-Modified).
2. Two 1 MB Range GETs (the fingerprint's head and tail).
3. One 4-byte Range GET (the engine's Parquet magic check).
4. One full GET of the file.

From then on DuckDB reads the file from memory: brushes and grid pages make
no further requests. A sample therefore costs one download of its file,
plus 2 MB.

## Parquet on DuckDB-WASM: verified

- `pnpm --filter @glassgrid/engine e2e` has a new Chromium case, the first
  run with the real extension:
  - the worker starts with the demo's extension repository and reports
    `parquet: true` with `extensionErrors: []`;
  - it reads a Parquet fixture over HTTP: count, a sorted page, a bar
    chart;
  - it converts a CSV into the OPFS Parquet cache (`COPY … (FORMAT
    parquet)` through a sync access handle);
  - a new worker opens that file from the cache (`usingParquetCache: true`).
- The web E2E opens all three samples on the production build and checks
  the start-up line `DuckDB-WASM v1.4.3 ready (parquet: true, cache: opfs, cross-origin isolated: false)`.
- **Still skipped:** the Parquet variants of the engine's Vitest `wasm`
  project, which runs DuckDB-WASM's Node runtime. `LOAD parquet` from a
  local extension folder hung there (tried once, not pursued). The browser
  is what ships, and the browser case covers it.

### Timings

Measured with `apps/web/e2e/samples.spec.ts`:

- the production build, served with `vercel.json`'s headers from localhost;
- HeadlessChrome (Playwright 1.64), a new browser context per run, so
  everything is cold: no HTTP cache, a new worker, WASM compiled again;
- a Linux VM with 2 vCPUs @ 2.1 GHz at a load average of about 2;
- milliseconds since navigation start, median of 3 runs.

JSON: [benchmarks/m4/web-demo-samples-chromium-linux-x64.json](benchmarks/m4/web-demo-samples-chromium-linux-x64.json).

| Sample | DuckDB-WASM ready | Workspace loaded | First chart | All charts | Brush → every view painted |
| --- | ---: | ---: | ---: | ---: | ---: |
| taxi (2.0M rows, 20.8 MB) | 1,705 | 2,039 | 3,193 | 3,230 | 265 |
| retail (1.5M rows, 11.1 MB) | 1,682 | 1,937 | 2,891 | 2,962 | 115 |
| sensors (1.4M rows, 8.0 MB) | 1,590 | 1,803 | 2,744 | 3,057 | 149 |

- **Phases.**
  - *Ready* is fetching and compiling 34 MB of WASM, plus `LOAD parquet`.
  - *Workspace loaded* adds registration, the fingerprint and `open`
    (200 to 350 ms).
  - The charts then wait for the full GET and the profile (about
    1.0 to 1.3 s).
  - Brushes are answered from cross-filter cubes (`fromCube` on all four
    other views in every run).
- **On a real connection,** add the downloads: the EH build is 7.7 MB with
  gzip (if the host compresses it) and the sample 8 to 21 MB. At 50 Mbit/s
  that is about 1.2 s and 1.3 to 3.3 s. The WASM download overlaps the page
  start; the sample does not. A repeat visit gets the WASM, the extension
  and the Parquet from the HTTP cache (all immutable).

## Headers and CSP

The policy is in `apps/web/csp.ts`. The build writes `WEB_CSP` into
`index.html` as a `<meta>`, so a host without our headers still enforces it
on the page. `vercel.json` sends `WEB_CSP_HEADER` on every response.
`apps/web/src/headers.test.ts` keeps them identical.

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'          ← header only (a <meta> may not carry it)
```

- **The worker runs under the header, not the page's `<meta>`.** A dedicated
  worker is governed by the policy delivered with its own script. So far
  only the `<meta>` had been tested, and that never reached the worker.
- **Finding 1, confirmed and fixed (the integrator's concern).**
  - `packages/engine/src/wasm/arrow.ts` re-encoded non-canonical result
    columns (LIST, STRUCT, BLOB, ENUM, HUGEINT) with Arrow's
    `vectorFromArray`. Its builder compiles the null check with
    `new Function`.
  - Reproduced on the production build with the production headers: a
    grid page of a Parquet file with a list column failed with "Refused to
    evaluate a string as JavaScript because 'unsafe-eval' is not an
    allowed source" (screenshot `csp-repro-before-fix.png` in the run's
    scratch folder).
  - The violation never reaches the page's console: only the failed query
    does, as an error toast.
  - Fixed by `textVector`, the same vector with a plain closure (as
    `vectorFromValues` in `packages/ui`).
  - Covered twice:
    - `wasm/arrow.test.ts` runs `normalizeIpc` with `Function` replaced by
      a thrower, and a control proves the guard catches `vectorFromArray`;
    - a web E2E opens a Parquet file with list, struct and blob columns.
- **Finding 2, fixed.** Zod 4 probes once whether it may compile fast
  parsers (`new Function("")` in a try). The throw is caught, but the browser
  still fires a `securitypolicyviolation` (two per page load). Zod is now
  `jitless` on the page (`src/zod-jitless.ts`, imported first) and in the
  engine worker. Parsing results are identical.
  - The desktop renderer has a `<meta>` CSP without `'unsafe-eval'` too, so
    it probably reports the same probe; it was not touched here.
- **DuckDB-WASM itself is fine under the policy.**
  - Its Emscripten glue contains `eval` for `EM_ASM` constants of
    dynamically loaded side modules, and for `emscripten_run_script`.
    Loading the Parquet extension does not reach either: no violation
    under the header CSP.
  - WebAssembly compilation (the core and the extension) needs only
    `'wasm-unsafe-eval'`.
- **`blob:` removed** from `worker-src` and `img-src`: nothing uses it. The
  engine worker is a same-origin module script, and the sync bindings start
  no further workers.
- **Other headers** (`vercel.json`):
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
  - `Permissions-Policy` denying camera, microphone, geolocation, payment
    and usb.
  - `Cross-Origin-Opener-Policy: same-origin`, and
    `Cross-Origin-Resource-Policy: same-origin` (no hotlinking of the WASM
    and data).
  - `.wasm` as `application/wasm`; `.parquet` as
    `application/vnd.apache.parquet`; `.glassgrid` as
    `application/vnd.glassgrid.workspace+json`.
  - Caching: `/assets/*` (content-hashed), `/duckdb-extensions/*` (versioned
    path) and `/samples/*.parquet` are `public, max-age=31536000, immutable`.
    Pages and `.glassgrid` files are `max-age=0, must-revalidate`.
- **Cross-origin isolation (COOP + COEP)** is not set and not needed. The
  engine runs DuckDB-WASM's single-threaded EH build through the
  synchronous bindings, which cannot use threads (see
  [m4-engine-portability.md](m4-engine-portability.md#threads-cross-origin-isolation-headers)).
  - Adding `Cross-Origin-Embedder-Policy: require-corp` would be harmless:
    every resource is same-origin with CORP. It would expose
    `SharedArrayBuffer` for a future threaded build.
  - The start-up line reports `cross-origin isolated: false`.
- **How the tests see production's headers.** `apps/web/e2e/serve.ts` reads
  `vercel.json` and applies its `rewrites` and `headers` (path-to-regexp's
  `(.*)` and `\\.` subset). Under a base (`GLASSGRID_BASE=/glassgrid/`) it
  reads `dist/glassgrid-hosting.json` instead and compiles its sources with
  path-to-regexp 6, as Next.js does. It also implements HEAD, Range, ETag
  and Last-Modified. Playwright runs against it instead of `vite preview`.

## Bundle budget

`pnpm --filter @glassgrid/web size` builds the app, then runs
`scripts/size.ts`. First load is the entry plus the route chunk and their
static imports, JS only, gzip at level 9. The script now also lists what the
worker loads, which is not counted.

| | Raw | Gzip |
| --- | ---: | ---: |
| **`/` first-load JS** (vendor 604 kB, app route 219 kB, entry 14 kB) | 837.5 kB | **247.6 kB** of 400 kB |
| `/gallery` first-load JS | 661.4 kB | 201.4 kB |
| `/` CSS | | 8.5 kB |
| Worker: `engine-worker-*.js` (engine core, Zod, Arrow) | 419.0 kB | 108.6 kB |
| Worker: `duckdb-browser-blocking-*.js` | 1,156.1 kB | 271.8 kB |
| Worker: `duckdb-eh-*.wasm` (fetched by most browsers) | 34,242.6 kB | 7,677.6 kB |
| Worker: `duckdb-mvp-*.wasm` (only without WebAssembly exceptions) | 39,362.7 kB | 8,730.8 kB |
| Parquet extension (`wasm_eh`) | 3,045.0 kB | |

- **Growth.** First load grew from 225.5 kB (stub) to 247.6 kB. The route
  chunk now carries the worker client (`PortEngineClient`, the control
  protocol) and the sample code. The entry carries Zod's config call.
- **Not in the page's graph.** The worker is created with
  `new Worker(new URL(…), { type: 'module' })`, so its chunks are not in
  the page's import graph at all.

## Tests

| Suite | Count | Notes |
| --- | ---: | --- |
| `packages/core` | 264 | unchanged |
| `packages/ui` | 225 | unchanged |
| `packages/engine` (Vitest) | 249 passed, 16 skipped | +3: `wasm/arrow.test.ts` |
| `packages/app` | 52 | +2: `App.initial-open.test.tsx` (once under StrictMode; a failed initial open shows Retry) |
| `apps/desktop` | 83 | unchanged |
| `apps/web` (Vitest) | 19 | The stub's 8 tests were deleted with it. +6 in `samples.test.ts`: every workspace parses (v1, no warnings, columns and cards), the catalog matches the manifest, the `?sample` lookup, `openSampleWorkspace` (relink, one entry, warnings, failures). +4 in `headers.test.ts`. |
| `apps/web` E2E (Chromium) | 8 | 3 sample links: charts with non-zero data, a mouse brush (cubes), undo, a deep grid scroll. 5 smoke: headers, start screen and engine with Parquet; a sample from the start screen and its link; a picked CSV with chart and cross-filter; a dropped CSV; a Parquet file with nested columns; the gallery. |
| `packages/engine` E2E (Chromium) | 9 | +1: Parquet through the served extension, and the OPFS Parquet cache |

**What makes a web E2E fail.** Every web E2E fails on any of:

- a console error or uncaught exception;
- a `securitypolicyviolation` on the page;
- an error toast (`role=alert`; this is how a violation inside the worker
  shows up);
- an HTTP response ≥ 400, or a failed request (aborted ones excepted);
- a `[glassgrid]` warning.

**The stray 404** seen in the engine's browser tests was `/favicon.ico`. The
test page had no `<link rel="icon">`, so Chromium asked for one. The page
now declares `data:,`. The web app already did.

**CI** (`.github/workflows/ci.yml`, checks job) now also runs
`pnpm --filter @glassgrid/web size` and the web E2E, after the engine's
browser test.

## Hosting

Changed after M4. The plan was a Vercel project of its own with a preview
per PR. The demo is now served as a static subfolder of the portfolio site,
`https://kalebkougl-portfolio.vercel.app/glassgrid/` (a Next.js app on
Vercel). The step-by-step (GitHub, releases, the portfolio's side,
`scripts/check-deploy.sh`) is in [deploy.md](deploy.md).

- **Base path.** `GLASSGRID_BASE=/glassgrid/` sets Vite's `base`. Vite
  prefixes the entry, chunks, the worker, DuckDB's `.wasm` and the fonts;
  `src/base.ts` does the rest (samples, the extension repository, the
  gallery route). The default is `/`, so `pnpm dev:web`, the root build and
  its tests are unchanged.
- **Sample workspaces** record `"absolutePath": "/samples/<file>"`. That is
  metadata from the generator: the web loader fetches the workspace and
  registers the Parquet file from the samples base (`<base>samples/`) and
  never reads `absolutePath`, so the committed files did not change.
- **Headers and rewrites** come from `apps/web/hosting.ts`.
  `pnpm --filter @glassgrid/web hosting` writes `vercel.json` from it, and
  `vite build` writes `dist/glassgrid-hosting.json`: the same rules as
  Next.js `headers()` and `rewrites()` entries under the base, with the
  name, version and base. `src/hosting.test.ts` compiles each source with
  path-to-regexp 6.3.0 and Next.js's options, and checks that every file
  the build serves gets the same headers under `/glassgrid/` as
  `vercel.json` gives it at the root.
- **Release.** A `web-vX.Y.Z` tag runs `.github/workflows/release-web.yml`:
  checks, a `/glassgrid/` build with its budget and E2E, then
  `glassgrid-web-X.Y.Z.tar.gz` (the build at the archive root) and its
  sha256 on a GitHub Release. The portfolio pins a version and unpacks the
  tarball into `public/glassgrid/` when it builds.
- **Compression.** Not verified on a live deployment. If Vercel does not
  compress `application/wasm`, the first visit downloads 34 MB instead of
  about 8 MB. A build step could then write Brotli-precompressed copies, or
  the `.wasm` could move to a CDN path that compresses; `connect-src` would
  then need that origin.

## Firefox and Safari

Only Chromium is available here. The APIs the demo relies on, with what
happens without them:

| API | Used for | Needs (approx.) | Without it |
| --- | --- | --- | --- |
| Module workers (`new Worker(url, { type: 'module' })`) | the engine worker | Chrome 80, Firefox 114, Safari 15 | The engine does not start: no fallback. |
| CSP `'wasm-unsafe-eval'` | compiling DuckDB-WASM under our policy | Chrome 97, Firefox 102, Safari 16 | WebAssembly compilation is refused. The policy would need `'unsafe-eval'`; we do not ship that. Vite's default build target is Safari 16 anyway. |
| WebAssembly exception handling | the EH build | Chrome 95, Firefox 100, Safari 15.2 | DuckDB-WASM picks the MVP build (automatic, 39 MB) |
| Synchronous XHR with `Range` in workers | DuckDB's HTTP reads of samples | all | none needed |
| `FileReaderSync` in workers | reading picked or dropped files in place | all | none needed |
| OPFS `navigator.storage.getDirectory()` + `FileSystemFileHandle.createSyncAccessHandle()` in workers | the Parquet cache for large CSVs | Chrome 102, Firefox 111, Safari 15.2 (methods changed in early versions) | **Fallback added:** the worker checks for `createSyncAccessHandle` first and runs with `cache: 'none'`: no CSV-to-Parquet conversion, everything else works. Samples never use the cache. |
| `FileSystemHandle.move()` in OPFS | renaming a finished cache file | uneven | existing fallback: copy, then delete |
| `crypto.randomUUID()`, `crypto.subtle.digest` (secure context) | source handles, fingerprints | Chrome 92, Firefox 95, Safari 15.4 | Fine on HTTPS and localhost |
| `<input type=file>` `cancel` event | noticing a closed picker | Chrome 113, Firefox 91, Safari 16.4 | existing fallback: focus regained without a file |
| WebGL2 | dense scatter overlay | all current | ui falls back per its own notes |

- **Safari, private windows.** OPFS may be missing or tiny in a private
  window: expect `cache: none`.
- **Safari, storage eviction.** Safari evicts origin storage after 7 days
  without interaction. The cache is only a cache.
- **Firefox private windows** refuse OPFS (`getDirectory` throws), which
  gives `cache: none`.
- **Memory.** WebAssembly memory is capped at 4 GB, and Safari tends to
  allow less. The taxi sample needs well under 1 GiB (the engine's
  default limit).

**Manual checklist (Firefox and Safari, latest stable, then Safari 16 if
available):**

1. Open `https://<deployment>/`.
   - The start screen shows three samples.
   - The Network panel shows no `.wasm` yet (the engine starts on intent).
   - Point at a sample: the console shows `[glassgrid] DuckDB-WASM v1.4.3 ready (parquet: true, cache: opfs, …)`.
   - There are no errors and no CSP reports (Firefox: Console, filter
     "Content-Security-Policy"; Safari: Console, "Refused to…").
2. Click **Taxi trips**.
   - Four charts draw; the line shows a weekly pattern.
   - The row count reads 2,000,000.
   - The address bar shows `?sample=taxi`.
3. Repeat in a new tab with `?sample=retail` and `?sample=sensors`. They
   open directly: 1,500,000 and 1,382,400 rows, four charts each.
4. Brush across the histogram.
   - The other three charts and the count change ("N of M rows").
   - A filter chip appears.
   - Undo restores everything.
5. Click a bar. The other charts filter; click it again to clear.
6. Scroll the grid far down, then drag the scrollbar to the end. Rows fill
   in, with no "Loading" left behind.
7. **Open file** with a local CSV, then drop another CSV onto the window.
   Both open, chart and cross-filter.
8. Open a CSV of 64 MB or more. "Optimizing file" appears; after a reload,
   the same file reopens from the cache, faster. This step checks OPFS sync
   access handles.
9. Open the same flow in a private window. It works, with `cache: none` or
   `opfs`.
10. Open `/gallery`. The component gallery renders.
11. Check the Network panel.
    - `.wasm` is `application/wasm`, compressed.
    - A sample is one full GET plus three small ranges.
    - There are no 404s.
12. Switch the OS to dark mode. The app follows.

## Known issues and follow-ups

- ~~**Bar labels show raw floating-point sums.**~~ Fixed on `pres-polish`:
  every number goes through core's `number-format.ts` (see
  [m3-charts.md → Number formatting](m3-charts.md#number-formatting)).
  Revenue by category now reads `39.0M` on the bar and `39,015,093.43` in
  the tooltip.
- ~~**Distinct counts are approximate.**~~ Fixed on `pres-polish`: the
  profile counts exactly where it is cheap (every column up to 250,000
  rows; text and boolean columns up to 5,000,000 rows) and marks the rest
  `≈` (numbers and timestamps of large tables, clamped to the non-null
  count and an integer column's range). The samples now show 64 sensors,
  4 sites and 10 categories; `≈1.7M` pickup times. Counting every column
  exactly made the samples' profile 0.9 to 1.3 s slower on DuckDB-WASM
  (every chart waits for it), so numeric columns keep the estimate.
  Follow-up: a Parquet file's row-group statistics could prove small
  integer ranges, which would make those exact too.
- **The web demo has no workspace save or open.**
  `capabilities.canSaveWorkspace` is false. A sample is an untitled
  workspace. Downloads or OPFS are the next step, as
  [m4-persistence.md](m4-persistence.md) notes.
- **`openSample` resolves `cancelled` after it has loaded the workspace.**
  See [Opening a sample](#opening-a-sample) for why.
- **Engine tests in Node still skip Parquet.** The Node WASM project skips
  its Parquet variants (above); Parquet is tested in Chromium only.
- **Two tabs on one OPFS cached copy** still conflict, as before. While
  writing the browser test, this branch saw the second worker's
  `createSyncAccessHandle` fail while the first held the file. Samples are
  unaffected: they are read over HTTP, not from the cache.
- ~~**The engine starts eagerly on `/`.**~~ It starts on first intent (see
  Architecture).
- **The "Order value" histogram of the retail sample** is dominated by one
  bar (bins of 100 over a long tail up to 4,000). A log scale or a
  narrower default range would read better; the sample workspace is
  generated (`tools/datasets`), so it was left as is.
- **Phones.** Below 760px the panels stack (columns, grid, charts) in one
  vertical scroll. It is usable for looking, not tuned: brushing on touch
  and the column drag are untested.
- **The registration HEAD shows as `net::ERR_ABORTED`** in DevTools. Its
  body is never read, which is harmless; the tests ignore aborted requests.
- **Sample files are cached as immutable** under fixed names. Changing a
  sample means a new file name (see the datasets README).
- **First visit without WASM compression** would download about 34 MB:
  verify on the first deploy (step 5 above).
- **Firefox and Safari are untested** here; use the checklist above.
