# M4 notes: the shared app package (`@glassgrid/app`)

Branch `m4-app`, dated 2026-10-18. Part of [M4](technical-design.md#m4--persistence-and-web-demo-week-4),
alongside `m4-engine` (the portable `packages/engine` and its DuckDB-WASM
worker client) and `m4-persist` (`.glassgrid` workspace files). This branch
moves the React app out of the desktop renderer into `packages/app`, so the
desktop app and the web demo render the same app, and turns `apps/web` into
a second shell. Nothing here changes desktop behaviour.

## Package boundaries

```
packages/core   specs, compiler, workspace state, commands, protocols        (no DOM, no Node, no React)
packages/ui     components, canvas grid, chart layer, tokens                  (browser, React)
packages/app    the app: App, views, actions, workspace wiring, theme, perf   (browser, React; no Electron, no Node, no shell)
  ▲  <App platform={…} />
  ├── apps/desktop/src/renderer   main.tsx + desktop-platform.ts + engine-client.ts (MessagePort transport)
  └── apps/web/src                main.tsx (routes) + web-platform.ts + app-route.tsx + gallery/ + stub-engine/ (temporary)
```

| Package | Imports | Must not import |
| --- | --- | --- |
| `@glassgrid/app` | `@glassgrid/core`, `@glassgrid/ui`, `apache-arrow` (types), React | Electron, Node built-ins, `apps/**`, `@glassgrid/desktop`, `@glassgrid/web` (ESLint `no-restricted-imports` on `packages/app/src/**`) |
| desktop renderer | `@glassgrid/app`, core, ui | Node (renderer rule, unchanged) |
| `apps/web` | `@glassgrid/app`, core, ui | Node in `src/` (renderer rule) |

What moved (with `git mv`, so `git log --follow` works) from
`apps/desktop/src/renderer/src/` to `packages/app/src/`: `App.tsx`,
`App.test.tsx`, `app.css`, `actions/open-file(.test).ts`, `describe(.test).ts`,
`perf.ts`, `render-perf-core.ts`, `render-perf.ts`, `theme.ts`, `workspace.ts`
and all of `views/`. What stayed in the desktop renderer: `main.tsx`,
`engine-client.ts` (the MessagePort client is a transport, and
`src/engine/client-integration.test.ts` imports it from its old path),
`global.d.ts` (`window.glassgrid` only) and the new `desktop-platform.ts`.

Package entry points (`packages/app/package.json` `exports`):

| Import | What |
| --- | --- |
| `@glassgrid/app` | `App`, `Platform` and its parts, `workspaceFilesOf`, `createAppWorkspace`, `appPolicy`, `applyInitialTheme`, theme helpers, `installRenderPerf`, `perfRegion`, `EngineClientLike` and result types, `EngineError`, `isAbandoned`, `AUTOSAVE_DELAY_MS` |
| `@glassgrid/app/perf` | performance-timeline names and detail types (the E2E suites read these) |
| `@glassgrid/app/render-perf-core` | the render-perf recorder; import it first in a shell, and from engine transports (`renderPerf.request/reply/…`) |
| `@glassgrid/app/app.css` | the main-screen layout |

`src/test-support/` (fake platform, fake engine, jsdom layout stubs) is for
the package's own tests and is not exported.

## The Platform interface

`packages/app/src/platform.ts`, passed once per window or page:
`<App platform={platform} workspace={workspace} />` (`workspace` optional;
shells create it outside React so StrictMode keeps one undo history and
render-perf builds can install their recorder on its store first).

```ts
export type PlatformName = 'mac' | 'win' | 'linux' | 'web';

/** A dropped file as fileFromDrop hands it back: a DOM File on both shells today, or any opaque handle. */
export interface DroppedFileRef {
  readonly name: string;
}

export interface SampleDataset {
  readonly id: string;
  readonly label: string;   // "NYC taxi trips"
  readonly detail?: string; // "3M rows · Parquet"
}

export interface PlatformFiles {
  /** Ask for a CSV, register it with the engine, resolve with its handle (never a path). */
  pickCsv(): Promise<OpenCsvResult>;
  /** The first file a drop carries, or null. Called synchronously in the drop handler. */
  fileFromDrop(data: DataTransfer): DroppedFileRef | null;
  /** Register a dropped file; resolves like pickCsv. */
  openDropped(file: DroppedFileRef): Promise<OpenCsvResult>;
  /** Shown under "Drop a CSV file here". */
  readonly privacyNote: string;
  /** Offered on the empty state; absent or empty for none. */
  readonly samples?: readonly SampleDataset[];
  openSample?(id: string): Promise<OpenCsvResult>;
}

export interface PlatformClipboard {
  writeText(text: string): Promise<void>;
}

export interface PlatformWindow {
  /** Leave room for native window controls (macOS traffic lights, --gg-titlebar-inset). */
  readonly titleBarInset: boolean;
  /** ⌘Z ('mac') or Ctrl+Z ('pc'). */
  readonly shortcuts: 'mac' | 'pc';
  /** Tell the native shell the theme preference (native frame, View menu ticks). */
  syncTheme?(preference: ThemePreference): void;
  /** Native application-menu commands. Returns an unsubscribe function. */
  onMenuCommand?(listener: (command: MenuCommand) => void): () => void;
  /** The window/page is going away (pagehide today). Returns an unsubscribe function. */
  onBeforeClose(listener: () => void): () => void;
}

export interface PlatformCapabilities {
  /** .glassgrid save/open; the UI also needs workspaceFiles. */
  readonly canSaveWorkspace: boolean;
  /** A saved workspace can reopen its data file from a stored path (desktop). */
  readonly canOpenFromPath: boolean;
  /** Largest data file in bytes; null for none. Checked before the engine opens a file. */
  readonly maxFileBytes: number | null;
}

export type WorkspaceFileOutcome =
  | { readonly status: 'done'; readonly displayName: string }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly message: string };

export interface WorkspaceFileContext {
  readonly workspace: AppWorkspace; // store + command registry
  readonly engine: EngineClientLike;
}

export interface RecoveryOffer {
  readonly id: string;
  readonly displayName: string;
  readonly savedAt: number; // epoch ms
}

/** Provisional: implemented by the persistence work. Absent → the UI below stays hidden. */
export interface WorkspaceFilesApi {
  save(context: WorkspaceFileContext, options: { saveAs: boolean }): Promise<WorkspaceFileOutcome>;
  open(context: WorkspaceFileContext): Promise<WorkspaceFileOutcome>;
  autosave?(state: WorkspaceState): void;
  readonly recovery?: {
    check(): Promise<RecoveryOffer | null>;
    restore(offer: RecoveryOffer, context: WorkspaceFileContext): Promise<WorkspaceFileOutcome>;
  };
  onOpenRequest?(listener: () => void): () => void;
}

export interface Platform {
  readonly name: PlatformName;
  readonly engine: EngineClientLike;
  readonly files: PlatformFiles;
  readonly clipboard: PlatformClipboard;
  readonly window: PlatformWindow;
  readonly capabilities: PlatformCapabilities;
  readonly workspaceFiles?: WorkspaceFilesApi;
}

/** The save/open controls show only with the capability and an implementation. */
export function workspaceFilesOf(platform: Pick<Platform, 'capabilities' | 'workspaceFiles'>): WorkspaceFilesApi | null;
```

Render-perf instrumentation is deliberately not a runtime slot: it is
compile-time. Each shell defines `__GG_RENDER_PERF__` (Vite `define`; `false`
in ordinary builds, so every instrumented branch is dropped), imports
`@glassgrid/app/render-perf-core` before react-dom, calls
`installRenderPerf(workspace.store)` and wraps the app in `perfRegion('App', …)`;
`GLASSGRID_RENDER_PERF=1` also aliases `react-dom/client` to
`react-dom/profiling` and turns minification off, in both
`electron.vite.config.ts` and `apps/web/vite.config.ts`. The flag's type is
declared once, in `render-perf-core.ts`.

### What each shell provides

| Member | Desktop (`desktop-platform.ts`) | Web (`web-platform.ts`) |
| --- | --- | --- |
| `name` | `mac` / `win` / `linux` from `process.platform` | `web` |
| `engine` | `EngineClient` over the engine's MessagePort | the temporary stub today; the DuckDB-WASM worker client after integration |
| `files.pickCsv` | `bridge.openCsv()` (main's dialog registers the path) | hidden `<input type=file>` → `registerFile(File)`; `cancel` event, or focus regained without a file, resolves `cancelled` |
| `files.fileFromDrop` / `openDropped` | the DOM `File` → `bridge.openDroppedFile` (preload resolves the path; the page never sees it) | the DOM `File` → `registerFile(File)`; anything else fails |
| `files.privacyNote` | "The file is read on this computer and never uploaded." | "The file is read in this browser and never uploaded." |
| `files.samples` | none | the engine's samples (stub: "Sample taxi trips") |
| `clipboard.writeText` | `bridge.clipboard.writeText` (one validated IPC call) | `navigator.clipboard.writeText`, a clear error when absent |
| `window.titleBarInset` | macOS only | false |
| `window.shortcuts` | `mac` on macOS | `mac` when `navigator.userAgentData.platform` / `navigator.platform` says Mac |
| `window.syncTheme` | `bridge.setTheme` | absent: the theme follows `prefers-color-scheme` (and a stored override) |
| `window.onMenuCommand` | `bridge.onMenuCommand` (File → Open, View → Theme) | absent |
| `window.onBeforeClose` | `pagehide` | `pagehide` |
| `capabilities` | save: false (until persistence), open from path: true, no size limit | save: false, open from path: false, `maxFileBytes` 2 GiB |
| `workspaceFiles` | absent (persistence adds it) | absent |

The app root carries `data-platform` (`mac`/`win`/`linux`/`web`; it used to
be `darwin`/`linux`/`win32`) and `data-titlebar-inset`; `app.css` keys the
title-bar padding on the latter. E2E selectors are unchanged.

## The engine client interface

`packages/app/src/engine.ts`. **Integrated:** `EngineClientLike` is now an
alias of the engine package's `EngineClientApi`
(`packages/engine/src/client/types.ts`, imported type-only from the
browser-safe `@glassgrid/engine/client` entry), and the result types
(`RowsResult`, `AggregateResult`, `CountResult`, `ProfileResult`,
`OpenResult`, `ColumnTypesResult`, `PrepareCrossfilterResult`, `FetchPage`,
`QueryOptions`, …) are re-exported from there. One interface is implemented
by the desktop `EngineClient` (`implements EngineClientApi`), the web
`createWorkerEngine()` (`WorkerEngine extends EngineClientApi`), the web
stub engine and the app's `fakeEngine()`. App code that needs a few methods
takes `Pick<EngineClientLike, …>`. ESLint keeps `packages/app/src/**` off
every other `@glassgrid/engine` entry (`.`, `./native`, `./wasm`, `./web`).

```ts
export type EngineClientLike = EngineClientApi;   // open, profile, rows, count, fetchPage, pageFetcher, setColumnTypes,
                                                  // aggregate, prepareCrossfilter, ensureParquetCache, closeTable,
                                                  // clearCache, cacheStats, cancel, lastRequestId, onRestarted, onEvent, dispose

/** What clients reject with: an Error with the engine's code and, for compiler errors, the input path. */
export class EngineError extends Error { constructor(readonly code: string, message: string, readonly path?: string) }
/** superseded / cancelled / engine_restarted, recognised by `code` on any Error (structural). */
export function isAbandoned(error: unknown): boolean;
```

`EngineError` and `isAbandoned` stay in the app: errors are recognised by
their `code`, not their class, so the desktop `EngineRequestError`, the
engine package's `EngineRequestError`, `EngineError` and any other client's
class all work; ChartView reads `error.path` for the offending-spec message.
(The engine package's own `isAbandoned` checks `instanceof
EngineRequestError`; the app does not use it.)

## Web build: routes, CSP and headers

- **Routes.** `src/main.tsx` is a tiny entry that loads one route chunk:
  `/` → `app-route.tsx` (the app), `/gallery` or `?gallery` →
  `gallery/route.tsx` (the component gallery, unchanged). Route CSS is in
  the route chunk, so the gallery's page chrome never reaches the app.
  Hosting must serve `index.html` for `/gallery` (Vite dev and preview do).
- **CSP.** The production build carries the policy as a `<meta>` in
  `index.html` (`vite.config.ts`, build only: the dev server needs inline
  styles and React Refresh):
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'`.
  The Playwright smoke tests run against it (any console error fails them).
- **No `new Function` in the browser.** Arrow's builders compile their null
  check with `new Function` whenever they see null values
  (`vectorFromArray`, `tableFromArrays`), which this CSP refuses; the
  gallery's synthetic chart data broke on it. `@glassgrid/ui` now exports
  `vectorFromValues(values, type)` (same vector, no code generation), used by
  the synthetic tables and the stub. Decoding (`tableFromIPC`) is unaffected,
  so the real engine path needs nothing. Anything that builds Arrow in the
  browser must use it.
- **Headers for the Vercel config (later).** Send the same policy as a
  `Content-Security-Policy` header plus what a `<meta>` cannot carry:
  `frame-ancestors 'none'`. Also `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy` denying what the app
  does not use (camera, microphone, geolocation), and `.wasm` served as
  `application/wasm` (streaming compilation). If the DuckDB-WASM build that
  needs `SharedArrayBuffer` (threads) is used, the page must be
  cross-origin isolated: `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` on every response, which also
  forbids cross-origin assets without CORP; the single-threaded `eh` bundle
  needs neither. Self-host the DuckDB bundles and sample Parquet files so
  `script-src`/`connect-src 'self'` hold (no CDN); a rewrite of `/gallery` to
  `/index.html`; long-lived `Cache-Control: immutable` for `/assets/*`
  (content-hashed) and `no-cache` for `index.html`.

## Bundle budget

`pnpm --filter @glassgrid/web size` builds and runs `apps/web/scripts/size.ts`:
it walks Vite's manifest from the entry; a route's first load is the entry,
the route chunk and their static imports (dynamic imports excluded), JS only,
gzip level 9, files whose name contains `duckdb` excluded; it fails when `/`
is over 400 kB (400,000 bytes).

| Route | First-load JS (gzip) | Raw | CSS (gzip) |
| --- | ---: | ---: | ---: |
| `/` (app + stub engine) | **225.5 kB** of 400 kB | 738.7 kB | 8.6 kB |
| `/gallery` | 197.9 kB | 655.3 kB | 7.7 kB |

Chunks of `/`: the shared vendor chunk (React, React DOM, Arrow, zod, Immer,
d3, core, ui) 188.3 kB, the app route 35.8 kB, the entry 1.4 kB. No further
splitting was needed: the WebGL scatter overlay (about 40 kB of commented
source) is part of ui's chart layer, which the app needs on first paint
anyway; lazy-loading it (or the chart layer) is the next lever if the WASM
client's glue pushes `/` close to the budget. The stub engine (about 30 kB of
source) is in the app route chunk and goes away at integration.

## Tests

| Suite | Count | Notes |
| --- | ---: | --- |
| `packages/app` | 50 tests, 5 files | the moved App, open-file, describe and cross-filter view tests (on a fake Platform), plus `App.platform.test.tsx`: open → grid → chart → undo/redo on a browser-like platform, Mac shortcuts and inset, no menus/theme sync, samples, the size limit, onBeforeClose, the workspace-file hooks (hidden without the API or capability, save/Save As/Ctrl+S, edited dot, failed save, open, recovery offer, autosave timing) |
| `apps/desktop` | 153 tests, 17 files (+2 opt-in benches skipped) | engine suites unchanged; `desktop-platform.test.ts` (4) replaces the moved renderer tests |
| `apps/web` | 17 tests, 2 files | web platform (picker incl. the focus fallback, drops, samples, clipboard, shortcuts, pagehide, capabilities), routes, the stub engine (sample, casts, open/profile/count/page, every mark's result shape through the real adapter, compiler errors, overrides, aborts) |
| `packages/ui` | 225 tests, 29 files | +2 for `vectorFromValues` |
| `packages/core` | 212 tests, 16 files | unchanged |
| Desktop E2E (`xvfb-run -a pnpm e2e`, 1M rows) | 11 passed, 1 skipped | unchanged; the skip is the raw-CSV launch (10M only) |
| Web smoke (`pnpm e2e:web`, Playwright Chromium on `vite preview`) | 3 | `/`: CSP present, dark theme from `prefers-color-scheme`, sample → grid (240 rows) → bar chart → cross-filter → undo ×2; a picked file through `<input type=file>`; `/gallery` and `?gallery` |

`pnpm --filter @glassgrid/desktop e2e:render` still records (instrumented
build, N = 5): commits and component renders per interaction match the
[baseline](render-perf-baseline.md) (heatmap create 5 commits, 96–97 renders
of which 64–66 wasted; brush 8 commits, 214 / 172; grid key press 2, 87 / 80).
Its timings were taken while other worktrees were building on the same
2-vCPU VM (load average 3.3) and are not comparable to the baseline's. The
CPU-profile attribution now counts `packages/app/src` as "app (renderer)".

## Integration notes

### Persistence UI (`m4-persist`)

The app owns the UI; the persistence work provides `Platform.workspaceFiles`
and flips `capabilities.canSaveWorkspace` in `desktop-platform.ts` (and later
the web platform). Where things plug in, all in `packages/app/src/App.tsx`
("Workspace files" section) and `views/TopBar.tsx`:

- **Save / Save As / Open workspace…** — TopBar buttons (`save-workspace`,
  `open-workspace`) and Cmd/Ctrl+S, Shift+Cmd/Ctrl+S call
  `workspaceFiles.save({ workspace, engine }, { saveAs })` /
  `.open({ workspace, engine })`. The implementation serialises with core's
  workspace format, writes atomically, and on open reopens the data source
  (relative → absolute → locate on desktop, a picker on the web), runs the
  engine open and replaces the state through a command. The outcome's
  `displayName` is toasted ("Saved trips.glassgrid"); `failed` shows its
  message.
- **Edited indicator** — the dot after the file size (`workspace-edited`):
  the latest history entry differs from the one recorded at the last
  successful save or open. Undo past the save point shows it again. If the
  persistence work resets history on open, this still holds.
- **Autosave** — `workspaceFiles.autosave(state)` runs `AUTOSAVE_DELAY_MS`
  (2 s) after the last state change while a file is open; the
  implementation decides where it goes (and should be cheap: it is called
  on the main thread).
- **Recovery** — `recovery.check()` once at start; an offer shows a toast
  with Restore → `recovery.restore(offer, context)`.
- **Shell-initiated opens** — `workspaceFiles.onOpenRequest` (a
  double-clicked `.glassgrid`, a menu item).
- **Menus** — `MenuCommand` (core `protocol/ipc.ts`) only has `open` and
  `theme`; Save/Open Workspace menu items need new kinds there, handled in
  App's menu effect next to `open`.
- **Unsaved changes on close** — `onBeforeClose` is a notification today
  (pagehide). A "save before closing?" prompt needs a veto: on desktop,
  main's `close` event plus an IPC round trip; on the web, `beforeunload`.
  Extend `PlatformWindow` with something like
  `onCloseRequest(listener: () => boolean | Promise<boolean>)` when that
  lands; `edited` is the input.
- `canOpenFromPath` is there for the open flow's fallbacks (false on the
  web: always ask for the file).

### DuckDB-WASM engine (`m4-engine`)

**Done on branch `m4-web`** (see [m4-web-demo.md](m4-web-demo.md)): the stub
and its badge are gone, the web platform runs on `createWorkerEngine()`, and
the CSP is also sent as a header (`apps/web/vercel.json`). The notes below
are kept as they were written.

- **Swap the stub.** In `apps/web/src/app-route.tsx`, replace
  `createStubEngine()` with an object of the `WebEngine` shape
  (`web-platform.ts`): `{ engine, registerFile(file: File): Promise<OpenCsvResult>, samples?, openSample? }`.
  `registerFile` is the WASM client's file registration
  (`db.registerFileHandle` for picked/dropped `File`s), returning a
  `toFileHandle(uuid)` handle; samples are the bundled Parquet datasets.
  Then delete `src/stub-engine/`, the badge (`app-route.css`, the `<aside>`)
  and `apache-arrow` from `apps/web` dependencies if nothing else needs it.
- **Unify the interface.** Done at integration: `EngineClientLike` is the
  engine package's `EngineClientApi` (see "The engine client interface").
  If the desktop `EngineClient` moves into `packages/engine` (or becomes
  `PortEngineClient` over the preload port), update `desktop-platform`'s
  import and `client-integration.test.ts`.
- **Render-perf.** Clients report phases through
  `@glassgrid/app/render-perf-core` behind `if (__GG_RENDER_PERF__)`, as
  `engine-client.ts` does (`request`, `reply`, `validated`, `decoded`); a
  client in a worker reports from the main-thread side.
- **Bundle.** Keep the DuckDB-WASM JS glue and worker in chunks/assets whose
  names contain `duckdb` (e.g. a `codeSplitting` group) so `size.ts`
  excludes exactly them, or adjust its `isDuckdb` rule; re-run `pnpm size`.
  Workers load from `'self'` or `blob:` (`worker-src` allows both).
- **Limits.** `WEB_MAX_FILE_BYTES` (2 GiB) is the web's `maxFileBytes`;
  tune it to what the WASM build handles.

## Deviations and known gaps

- **The stub engine** serves the same 240 rows whatever file is opened (the
  name and size are the file's) and computes in plain JS: no cubes
  (`prepareCrossfilter` skips every target), no M4 downsampling, no
  superseding, no Parquet events. It validates specs with the real
  compiler, so disabled marks and error messages match the engine.
- **Theme on the web** follows `prefers-color-scheme`; there is no in-page
  control for the override the desktop View → Theme menu sets.
- **Sample datasets** appear on the empty state when a platform offers them
  (new UI: "Or try a sample"); desktop offers none.
- The render issues in [render-perf-baseline.md](render-perf-baseline.md)
  are untouched (App still subscribes to the whole store); the new hooks add
  no renders when `workspaceFiles` is absent.
