# Render-path baseline: where the non-engine time of a chart create goes

Measurement only, dated 2026-10-18, branch `perf-heatmap` (from `main`
c42f679). Nothing here changes behaviour: the instrumentation is compiled in
only by `GLASSGRID_RENDER_PERF=1` builds. Numbers are medians of three runs
of each configuration on the shared VM (2 vCPU Xeon @ 2.1 GHz, 8 GB, Xvfb
with software compositing; Electron 44.9.0 / Chrome 152, React 19.3.1),
nothing else running. Raw runs, medians and two CPU profiles are in
[`benchmarks/render/`](benchmarks/render/).

**Short version.** On the M3 exit-gate case (10M rows, Parquet copy, heatmap
of distance × fare under a fresh filter) a create is 204 ms p50 / 261 ms p95
drop → drawn, of which the engine is 192 / 251 ms. The rest is **8.6–9.4 ms
p50, 11.8–12.3 ms p95** (plain vs instrumented build), plus **~5 ms** more
until the frame with the chart is on screen. About half of the 9 ms is React
work that should not be there: a whole-tree re-render before the request is
sent (1.3 ms), a second render-and-commit of the new chart because its width
is measured after mount (≈ 1–1.5 ms), heavy ChartView renders (SQL compiled for
every mark in the ⋯ menu on every render) and two to three full-tree
re-renders around each interaction, 65–90 % of whose component renders are
wasted. **The exit-gate heatmap p95 overrun is engine time** (engine p95
251 ms on its own); the renderer can win ~4–5 ms of it, not 10+.

## How to run

```sh
pnpm --filter @glassgrid/desktop e2e:render          # 1M fixture (writes e2e-results/render-perf-1000000-*.json)
pnpm --filter @glassgrid/desktop e2e:render:10m      # 10M, measured on the Parquet copy
GLASSGRID_E2E_RENDER_N=20                             # samples per variant (default 20)
# overhead check: the same flows on an ordinary build record only the app's own measures
pnpm --filter @glassgrid/desktop build && GLASSGRID_E2E_RENDER=1 xvfb-run -a pnpm --filter @glassgrid/desktop exec playwright test
# medians over runs (+ the tables below on stdout)
node apps/desktop/e2e/render-perf-medians.ts out.json run1.json run2.json run3.json …
```

`e2e:render` builds with `GLASSGRID_RENDER_PERF=1` and runs only
`e2e/render-perf.spec.ts` (`GLASSGRID_E2E_RENDER=1`); `pnpm e2e` ignores that
spec. A 1M run takes ~4 min, a 10M run ~6 min.

What the spec does (each interaction armed, performed, and recorded until the
frame after it, plus 300 ms of quiet):

| Variant | What |
| --- | --- |
| create, **cached** | the same chart dropped again, N = 20 per mark (the engine answers from its result cache, `cached: true`, engine ≈ 0.1 ms): the non-engine path alone |
| create, **fresh** | a new `fare_amount ≥ k` filter, 6 s settle (2.5 s at 1M), then heatmap and bars, N = 20 each: every aggregate computed (the M3 exit-gate method) |
| create, cached, no inspector | 10 cached heatmaps with the commit inspector off (its overhead) |
| **brush** | 4 charts (line, bars, histogram, heatmap) + grid, a 300 ms mouse brush on the histogram, N = 20, recorded from the release; the press and drag before it as `brushStart` |
| **select** | one ArrowDown/ArrowUp in the grid with those 4 charts and a brush on screen, N = 20 |
| CPU profile | CDP `Profiler` (100 µs sampling) over 10 cached heatmap creates and 10 brushes; self time inside the [input, presented] windows |
| trace | Electron `contentTracing` (devtools.timeline) over 10 cached creates, 10 brushes, 10 key presses; renderer main-thread self time by trace event |

### What is instrumented (`GLASSGRID_RENDER_PERF=1` only)

`apps/desktop/src/renderer/src/render-perf-core.ts` (+ `render-perf.ts` for
the React side). Every call site is behind `if (__GG_RENDER_PERF__)`, a Vite
`define` that is `false` in ordinary builds, so the code is dead and dropped
(checked in the built bundle: what remains is an identity `perfRegion()`
and the charts' existing null-checked perf hook, now also around the model
build). After `e2e:render`, `out/` holds the instrumented build until the
next ordinary build (`pnpm e2e` rebuilds first).
The flag also swaps in `react-dom/profiling` (Profiler timings) and turns
minification off (readable profiles and component names).

- **Phase marks** `glassgrid:<interaction>:<phase>` (performance marks, and a
  recording the test reads through `window.__ggRenderPerf`): `input` (the
  DOM event's timeStamp: drop, pointerdown/up, keydown), `dispatch` (app calls
  the command), `notify` (store listeners), `render` (first App render after
  it), `commit-end` (every React commit), `query` (a chart's aggregate effect
  ran), `request` (posted to the engine port), `reply` (port message, with
  engine time and bytes), `validated` (reply schema-checked), `decoded`
  (`tableFromIPC`), `resolved`, `data-render` (ChartView renders the new
  result), `adapt` (`chartColumnsFromArrow`), `model` (chart model built),
  `layers` / `paint` (canvas), `drawn` (`onDrawn`), `raf` (next animation
  frame) and `presented` (a task after that frame rendered).
- **React Profiler regions** (`App`, `TopBar`, `ColumnList`, `GridPanel`,
  `ChartsPanel`, `Chart:<mark>` per card): render time per region and commit,
  layout-effect time.
- **Commit inspector**: a minimal React DevTools hook (installed before
  react-dom loads) that, after each commit, walks the re-rendered parts of the
  fiber tree and records each rendered component, its region, its own render
  time and why it rendered: `mount`, `state`, `context`, `props`, or —
  **wasted** — `same-props` (all props identical: `React.memo` would skip it)
  or `unstable-props` (props equal by value, only new callback/object
  identities: memo plus stable props would skip it).

**Overhead.** Plain vs instrumented builds, non-engine time drop → drawn
(p50 / p95): fresh heatmap 7.8 / 10.6 vs 7.7 / 10.7 (1M), 8.6 / 12.3 vs
9.4 / 11.8 (10M); cached heatmap 13.3 / 18.8 vs 11.4 / 18.7 (1M), 10.0 / 17.6
vs 13.2 / 19.5 (10M). No consistent direction; the spread between runs (±3
ms) is larger. The inspector's own walk is 0.1 ms per create (0.3 per brush).
Read single sub-millisecond phases as ±0.2 ms.

**Caveats.** Software compositing under Xvfb on 2 vCPUs makes frame
production (style, layout, paint, compositor commit, raster) slower and
burstier than on a desktop GPU: the `drawn → presented` numbers are
environment-heavy. The exit-gate measure (`glassgrid:chart-create`) ends at
`drawn`, not at the frame.

## Headline

Drop → drawn (the app's `glassgrid:chart-create`), ms, p50 / p95, medians of 3
runs × 20 samples. "Non-engine" = per sample (drop → drawn) − engine time.

| | rows | drop → drawn (plain build) | engine | non-engine, plain | non-engine, instrumented | drop → frame presented |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| heatmap, fresh | 1M | 46.4 / 67.9 | 39.4 / 52.4 | **7.8 / 10.6** | 7.7 / 10.7 | 57.1 / 73.8 |
| heatmap, fresh | 10M | 205.5 / 233.9 | 195.4 / 224.4 | **8.6 / 12.3** | 9.4 / 11.8 | 208.9 / 271.2 |
| heatmap, cached | 1M | 13.4 / 19.0 | 0.1 | **13.3 / 18.8** | 11.4 / 18.7 | 26.4 / 38.4 |
| heatmap, cached | 10M | 10.2 / 17.9 | 0.2 | **10.0 / 17.6** | 13.2 / 19.5 | 30.0 / 38.0 |
| bars, fresh | 1M | 28.7 / 37.7 | 21.9 / 29.1 | 5.7 / 9.8 | 6.1 / 9.3 | 30.5 / 41.1 |
| bars, fresh | 10M | 84.3 / 118.7 | 78.4 / 110.5 | 6.1 / 8.5 | 7.8 / 11.5 | 93.7 / 118.4 |
| bars, cached | 1M | 9.4 / 13.9 | 0.1 | 9.3 / 13.8 | 9.0 / 12.8 | 14.2 / 24.8 |
| bars, cached | 10M | 6.9 / 12.0 | 0.1 | 6.8 / 11.9 | 10.2 / 16.3 | 22.9 / 27.8 |

A cached create's non-engine time is *larger* than a fresh one's: its reply
comes back while the main thread is still busy with the empty card's frame
and a second whole-tree render (see below), so `request → reply` is 3.7–5 ms
for an answer the engine produced in 0.1 ms. With a fresh query the main
thread is idle when the reply lands (`request → reply − engine` 0.7–0.9 ms).

| Interaction | rows | input → first commit | input → last view (app measure) | input → frame | React commits | render ms | commit ms | component renders (wasted) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| brush release, 4 charts | 1M | 4.3 / 6.0 | 59.3 / 75.8 | 71.0 / 86.0 | 8 | 10.2 / 16.8 | 8.1 / 15.3 | 220 (177 = 80 %) |
| brush release, 4 charts | 10M | 4.9 / 6.8 | 69.7 / 92.8 | 80.7 / 104.8 | 8 | 12.1 / 25.8 | 9.7 / 18.6 | 220 (177 = 80 %) |
| brush press + 300 ms drag | 10M | 1.7 / 2.4 | – | 14.0 / 16.6 | 2 + 11 during the drag | 0.8 + 5.5 | 0.1 + 1.0 | 17 (14) + 81 (65) |
| grid ArrowDown, 4 charts | 1M | 3.8 / 5.2 | – | 7.0 / 13.3 | 2 | 2.1 / 3.2 | 0.8 / 1.0 | 88 (80 = 91 %) |
| grid ArrowDown, 4 charts | 10M | 3.8 / 6.6 | – | 7.0 / 14.3 | 2 | 2.0 / 3.1 | 0.8 / 1.4 | 88 (80 = 91 %) |

## Phase breakdown: heatmap create

ms after the drop event, segment by segment, p50 / p95 (instrumented build,
medians of 3 runs). One chart on an otherwise empty panel, 4 columns.

| Segment | What runs | 1M cached | 1M fresh | 10M cached | 10M fresh |
| --- | --- | ---: | ---: | ---: | ---: |
| input → dispatch | drop event to `addChartFor` (React synthetic event) | 0.1 / 0.2 | 0.1 / 0.2 | 0.1 / 0.3 | 0.1 / 0.2 |
| dispatch → notify | `addChart`: validate, default chart rules, Immer, history | 0.4 / 0.7 | 0.4 / 0.5 | 0.5 / 0.9 | 0.4 / 0.5 |
| notify → render | React schedules the sync render | 0.1 / 0.2 | 0.1 / 0.1 | 0.1 / 0.2 | 0.1 / 0.1 |
| render → shell commit | **whole-tree render** (App, TopBar, column rows, grid panel, the new ChartView/ChartCard): ~40 component renders, 25 wasted | 1.1 / 1.8 | 1.2 / 1.6 | 1.1 / 1.7 | 1.3 / 2.4 |
| shell commit | DOM for the empty card | 0.2 / 0.4 | 0.3 / 0.4 | 0.3 / 0.4 | 0.3 / 0.4 |
| → query → request | passive effect, spec zod-validated, `postMessage` | 0.3 / 1.0 | 0.3 / 0.6 | 0.3 / 0.9 | 0.3 / 0.9 |
| request → reply | engine (plus IPC; see the note above for cached) | 3.7 / 5.7 | 36.8 / 47.3 | 5.0 / 7.6 | 195.8 / 252.4 |
| *of which beyond engine time* | IPC, engine host, main thread busy | *3.6 / 5.6* | *0.7 / 1.9* | *4.9 / 7.3* | *0.9 / 3.4* |
| reply → validated | `EngineResponseSchema.safeParse` | 0.0 / 0.1 | 0.1 / 0.1 | 0.0 / 0.1 | 0.1 / 0.2 |
| validated → decoded | `tableFromIPC` (360 cells, ~7 KB) | 0.3 / 0.7 | 0.3 / 0.5 | 0.4 / 0.9 | 0.3 / 0.5 |
| decoded → resolved → data render | promise hops, `setData`, React schedules (default lane) | 0.2 / 1.4 | 0.2 / 0.3 | 0.3 / 1.6 | 0.2 / 0.3 |
| data render | ChartView (+ `chartColumnsFromArrow` 0.1 ms), ChartCard chrome, Heatmap, ChartFrame **without a width yet** (no model) | 0.9 / 3.1 | 0.8 / 1.1 | 1.3 / 3.3 | 0.9 / 1.3 |
| data commit | DOM; ChartFrame's layout effect measures its width (forced layout 0.4 ms) and sets state | 0.6 / 2.0 | 0.8 / 1.6 | 0.6 / 1.1 | 1.0 / 1.5 |
| → draw commit start | **second, synchronous render** of ChartFrame: model built (0.6–0.7 ms) | 0.8 / 1.8 | 0.7 / 1.2 | 0.9 / 2.4 | 0.9 / 1.8 |
| draw commit → drawn | layers (axes + marks, 0.9–1.0 ms), composite (0.6 ms), `onDrawn` | 1.7 / 2.5 | 1.5 / 1.9 | 1.8 / 2.3 | 1.7 / 2.0 |
| **drop → drawn** | | **11.5 / 18.8** | **44.3 / 54.8** | **13.3 / 19.6** | **203.9 / 260.9** |
| drawn → next animation frame | waits for the compositor; for cached creates the empty card's frame is still in flight | 5.1 / 19.1 | 1.3 / 23.9 | 6.1 / 20.6 | 1.5 / 1.9 |
| frame → presented | style, layout, paint, compositor commit of that frame | 3.4 / 4.7 | 3.1 / 6.9 | 3.6 / 5.3 | 3.9 / 7.3 |
| **drop → presented** | | 26.4 / 38.4 | 57.1 / 73.8 | 30.0 / 38.0 | 208.9 / 271.2 |

Totals per create (p50): 5–6 commits from the drop to the frame, render 4.5–6.5
ms, commit 3.0–3.8 ms, **95–97 component renders of which 64–66 wasted
(67 %)**. Before the drop, the drag itself costs 3 more whole-tree commits
(61 renders, 55 wasted, 1.5 ms). After the frame of a fresh create, one
deferred commit renders the hidden screen-reader table (ViewData, 300 rows:
1.8–3.2 ms p50, up to 7 ms p95); for cached creates it lands inside the
frame window.

One fresh 10M create, commit by commit (run 1, sample 6):

| at (ms after drop) | render | commit | renders (wasted) | what |
| ---: | ---: | ---: | ---: | --- |
| 1.7 | 1.0 | 0.3 | 40 (25) | `addChart` + `chartsOver=false`: the whole tree, plus the new card |
| 5.1 | 0.9 | 0.2 | 40 (32) | `dragend` → `draggingColumn=null`: the whole tree again (while the query runs) |
| 244.9 | 1.2 | 1.2 | 13 (7) | the result: ChartView, ChartCard chrome (3 ShelfChips, Menu, Popover, Button), Heatmap, ChartFrame with width 0 |
| 247.2 | 0.8 | 2.0 | 2 (1) | ChartFrame measured: model, layers, paint → `drawn` at 249.1 |
| 254.6 | 0.5 | 1.6 | 2 (1) | `useFontsVersion` bumps 0 → 1 on mount (fonts were loaded long ago): **model rebuilt and redrawn** |
| 258.5 | 2.0 | 0.1 | 2 (0) | deferred hidden table (ViewData) |

Bars follow the same path (a passive-effect draw instead of a layout-effect
one): drop → request 1.9–2.7 ms, reply → drawn 2.8–3.8 ms, 5 commits, 96–98
renders (65–67 wasted); BarChart measures its width and reads the font
version the same way (two extra BarChart commits after the draw).

## React renders per interaction

Mean component renders per interaction (wasted in brackets), 10M, medians of
3 runs. "Wasted" = re-rendered with props equal by value and no
state/context change.

| Component | create heatmap (drop → frame) | brush release | grid key press | why it re-renders |
| --- | ---: | ---: | ---: | --- |
| ShelfChip | 9 (4) | 32.9 (32.9) | 12 (12) | inline `onDropColumn`, new `menu` arrays from ChartView |
| Popover | 15 (11) | 30.9 (27.9) | 13 (12) | new `onClose`/children from Menu, TypeMenu |
| Menu | 11 (10) | 26.9 (26.9) | 11 (11) | new `items` arrays (card ⋯ menu, Y-aggregate menus) |
| Button | 15 (13) | 24.9 (23.9) | 11 (11) | inline `onClick`/`onKeyDown` |
| ChartView | 3 (0) | 10.9 (4.0) | 4 (4) | `chips.filter(…)`, `position={{…}}`, `onRemove` inline; `compileColumns` recomputed on every state change |
| ChartCard | 3 (0) | 10.9 (4.0) | 4 (4) | `menu`, `shelves`, `viewData` rebuilt by ChartView |
| ChartFrame | 3 (0) | 8.9 (5.0) | 3 (3) | new `dataTable` / `legend` elements from Heatmap/LineChart/Histogram |
| DeferredTable | 3.5 (2) | 14.8 (7.0) | 5.8 (3) | its parent re-rendered |
| Switch | 3 (2) | 10.9 (10.9) | 4 (4) | same props |
| TypeMenu, ColumnListRow | 8 + 8 (8 + 7) | 8 + 8 (all) | 4 + 4 (all) | inline `onChange`, `onTypeChange`, `onActivate` per row |
| CanvasGrid | 2 (2) | 3 (2) | 1 (0) | inline grid callbacks |
| TopBar, FilterEditor, AgentIndicator, WebGLOverlayProvider, FilterChip | 2 each (mostly wasted) | 2 each | 1 each | the whole `state` / new callbacks |
| LineChart, Heatmap, Histogram, BarChart, RampLegend | 1 (mount) | 2–3 each (1–2 wasted) | 1 (1) each | same props |
| App | 2 | 2 | 1 | `useSyncExternalStore(store.getState)` + local UI state |
| **all** | **95 (64)** | **220 (177)** | **88 (80)** | |

Whole-tree commits (App re-renders): create 2 after the drop (`addChart`,
`dragend`) + 3 during the drag; brush 2 (the `brush` command, then the row
count's reply → `setCount`); key press 1. With 4 charts a whole-tree commit
is 85 component renders, 2.0–3.1 ms render + 0.8–1.4 ms commit; with one
chart 40 renders, 1.0–1.3 + 0.2–0.3 ms. ChartView's own render is the most
expensive single component: 0.34 ms per render (3.6–4.4 ms per brush over
10.9 renders), because building its ⋯ menu calls `markAllowed` for 5 other
marks, each compiling the chart's SQL and, for marks the columns cannot make,
throwing and catching an error (`MarkError` is 0.7 ms of self time per brush
in the CPU profile).

Brush release, 10M, commit by commit (run 1, sample 6): 1.5 ms after release
the whole tree (85 renders, 68 wasted; 3.1 ms render, 1.4 ms commit) — the 5
requests go out only after it, at 6.7 ms; replies land at 35–53 ms, each
re-renders its ChartView and card chrome (12–14 renders, 0.9–1.5 ms render,
0.2–2.6 ms commit); the count's reply re-renders the whole tree again (85
renders, 83 wasted; 2.2 ms + 1.7 ms); after the last draw, the deferred
tables (2.9 ms render). During the 300 ms drag before the release, the brush
header updates once per frame by re-rendering the brushed ChartView and its
chrome: 11 commits, 81 renders (65 wasted), 5.5 ms.

## Where main-thread time goes

**CPU profile** (CDP, 100 µs sampling), self time per interaction inside the
[input, presented] windows, medians of 3 runs (1M / 10M):

| Category | cached heatmap create | brush release |
| --- | ---: | ---: |
| `(program)`: browser-native work outside JS (style, layout, paint, compositor, IPC) | 8.8 / 12.0 | 20.5 / 21.4 |
| native builtins called from JS (canvas `setTransform`/`drawImage`/`getContext`/`fillText`, `performance.now`, `postMessage`) | 3.2 / 3.8 | 8.1 / 6.2 |
| React (reconciler, DOM updates) | 2.9 / 3.6 | 5.7 / 5.4 |
| charts (`packages/ui/src/charts`: model, hit index, layers, ViewData) | 1.8 / 2.0 | 2.2 / 2.4 |
| grid (`packages/ui/src/grid`) | 0.1 / 0.1 | 3.9 / 3.4 |
| core (queries, chips, mark checks) | 0.3 / 0.5 | 2.1 / 2.1 |
| app (`src/renderer`) | 0.6 / 0.3 | 1.8 / 1.6 |
| Arrow decode | 0.6 / 0.3 | 1.2 / 1.4 |
| zod (request/reply validation) | 0.2 / 0.2 | 0.7 / 0.7 |
| idle (waiting for the engine) | 0.4 / 1.1 | 4.0 / 5.1 |
| sampled total | 20.6 / 28.4 | 53.0 / 52.5 |

Top self-time functions (10M unless noted): create — `setTransform` 0.8 ms
(canvas sizing of new canvases), `measure` in `charts/hooks.ts` 0.5 ms (the
`clientWidth` read in `useElementWidth`: a forced layout), `drawImage` 0.4–0.5,
`getContext` 0.15–0.3, `setTextContent` 0.3 (hidden table), ChartView 0.3,
`parseColor` 0.2, zod parse 0.13; brush — **`setVirtualTop` (grid controller)
2.0 ms**: it writes the scroll spacer's height and then reads `scrollTop`, a
forced synchronous layout whenever the filtered row count changes;
`drawImage` 1.8; `setTextContent` 0.8–1.2 (hidden tables, grid mirror);
`formatOther` (grid cell text) 0.6–0.9; `MarkError` 0.7; ChartView 0.5–0.6;
`formatAggregate` 0.5; zod 0.3–0.4; `decode` 0.3. The raw profiles
(`benchmarks/render/*.cpuprofile`) open in DevTools → Performance.

**Trace** (main thread, devtools.timeline, self time per interaction, 1M /
10M):

| | cached heatmap create | brush release | grid key press |
| --- | ---: | ---: | ---: |
| main thread busy (input → presented) | 24.2 / 26.9 | 45.6 / 47.0 | 8.0 / 8.5 |
| script (FunctionCall, rAF, microtasks) | 11.4 / 13.5 | 24.2 / 23.9 | 4.8 / 5.2 |
| layout | 3.2 / 4.3 | 8.0 / 8.2 | 0 / 0 |
| of which forced by script (count) | 0.3 / 0.4 (1) | 1.7 / 1.9 (2) | 0 |
| style (UpdateLayoutTree) | 1.4 / 1.5 | 0.3 / 0.2 | 0.1 |
| paint & composite (PrePaint, Paint, Layerize, compositor Commit) | 4.3 / 5.4 | 8.7 / 9.4 | 2.0 / 2.2 |
| task overhead, IPC receive, other | 3.0 / 3.4 | 4.4 / 5.4 | 0.7 |

So for a cached create the browser's own frame work (≈ 10 ms: layout 3–4,
compositor commit 2.5–3, style 1.4, pre-paint 1–1.4, paint 0.5) is as large as
React's render + commit (≈ 10 ms including the canvas draws), and two frames
are produced (the empty card, then the chart).

## Ranked opportunities

Estimated savings are for this VM, p50, and assume the item alone (they
overlap; see notes). "Create" = fresh heatmap drop → drawn unless said
otherwise; the realistic ceiling for the renderer on that path is ~4–5 ms of
the ~9 ms.

| # | Change | Evidence | Est. savings | Files |
| ---: | --- | --- | --- | --- |
| 1 | **Selector subscriptions; split `App.tsx` into panels.** App subscribes to the whole state (and history) and also holds UI state (`draggingColumn`, `chartsOver`, `count`, `toast`, `active`), so every dispatch and every UI-state change re-renders TopBar, every column row, the grid panel and every card. Give each panel a `useWorkspace(selector)` subscription (memoized derivations: chips per chart, `compileColumns` from `state.columns` only) and keep drag/count state inside the panel that shows it. | whole-tree commits: create 2 (+3 during the drag), brush 2, key press 1; 85 renders each with 4 charts, 80–98 % wasted | create −0.7 (shell render 1.1–1.3 → ~0.4) and −0.8 more on cached (no `dragend` re-render while the reply waits); brush −3 to −5 main thread (−1.5 to −2 before the requests go out; the count reply's 2.2 + 1.7 ms commit gone); key press −2 of 2.9 (≈ 7 → 5 ms to frame); drag: 3 commits → ~0 | `apps/desktop/src/renderer/src/App.tsx` → new `views/ColumnsPanel.tsx`, `views/GridPanel.tsx`, `views/ChartsPanel.tsx`; `workspace.ts` (selector hook); `views/TopBar.tsx` (history only) |
| 2 | **Send queries from the store, not from React effects.** Chart aggregates, the count and grid pages are requested in passive effects after the render and commit that the state change caused; a query manager subscribed to the store (`viewQueries` per notify) can post them synchronously, with React only subscribing to results. | brush: input → first request 5.4 ms p50 (7.5 p95), of which 4 ms is the whole-tree render/commit; create: 2.0 ms | create −1.5 (request at ~0.6 ms instead of 2.0); brush −4 (−2 if #1 lands first) | new `apps/desktop/src/renderer/src/query-manager.ts`; `views/chart-data.ts` (`useChartQuery` → subscription); the count/grid effects in `App.tsx` (after #1, in `GridPanel.tsx`); `views/crossfilter-tracker.ts` |
| 3 | **Cheap, memoized ChartView and card chrome.** `React.memo(ChartView)` with stable props (chips per chart memoized, `position` as primitives, `onRemove(chartId)`); memoize mark availability per (spec, columns) with a non-throwing check instead of compiling SQL and catching errors for 5 marks per render; memoize the ⋯ menu, shelves and `viewData`; `React.memo` on ShelfChip, Menu, Popover, Button, Switch. | ChartView 0.34 ms/render (3.6–4.4 ms per brush); `MarkError` 0.7 ms/brush; each result re-renders 12–14 chrome components (7–9 wasted) | create −0.5 (data render 0.9–1.3 → ~0.4); brush −3 to −4 main thread, −1 to −1.5 after the last reply; key press −1 | `apps/desktop/src/renderer/src/views/ChartView.tsx`; `packages/core/src/crossfilter/defaults.ts` (a non-throwing `canMake(spec, mark, columns)` next to `specForMark`); `packages/ui/src/components/{ChartCard,ShelfChip,Menu,Popover,Button}.tsx`. The ChartView call site in App.tsx belongs to #1 |
| 4 | **Draw a new chart in its first commit.** ChartFrame (and BarChart) start with width 0, measure in a layout effect (forced layout), re-render synchronously, then draw; and `useFontsVersion` bumps 0 → 1 on every mount (fonts loaded long ago), rebuilding the model and redrawing 5–7 ms later. Seed the width from the panel (the charts list width is already known: a context from `WebGLOverlayProvider` or an `initialWidth` prop) and start the font version at "ready" when `document.fonts.status === 'loaded'`. | data commit → draw commit 0.7–0.9 ms + forced layout 0.4 ms; font-bump commit 0.5–2 ms render + 0.4–1.6 ms commit per new chart | create −1 to −1.3 on drop → drawn; −1.5 to −3 main thread after the draw (on the frame path for cached creates); bars −0.5 | `packages/ui/src/charts/hooks.ts`, `packages/ui/src/charts/ChartFrame.tsx`, `packages/ui/src/components/BarChart.tsx`, `packages/ui/src/charts/webgl/WebGLOverlayProvider.tsx` (width context) |
| 5 | **No forced layout in the grid on a row-count change.** `GridController.setVirtualTop` writes the spacer height and then reads `scroller.scrollTop`. Keep reads before writes (or use the tracked `expectedScrollTop`). | 2.0 ms self per brush (profile); trace: 1.9 ms forced layout, 2 per brush | brush −1.5 to −2 (main thread, often on the path of the last chart's reply) | `packages/ui/src/grid/controller.ts` |
| 6 | **Hidden screen-reader table off the hot path.** The deferred ViewData (300 formatted rows) still renders right after the paint, once per new chart and once per repainted chart after a brush, and DeferredTable re-renders whenever its parent does (new `dataTable` elements). Memoize the `dataTable` element per data, render it at idle (or on focus, with an a11y check), cap or virtualize rows. | 1.8–3.2 ms p50 (7 ms p95) per create; 2.9 ms per brush; DeferredTable 14.8 renders per brush | −2 to −3 main thread per create, −3 to −6 per brush (not on drop → drawn; frees the main thread for the next reply/input) | `packages/ui/src/charts/{ChartFrame,Heatmap,LineChart,Histogram,ScatterChart,ViewData}.tsx` (same owner as #4: ChartFrame.tsx) |
| 7 | **Cheaper frames: CSS containment, fewer layers, no empty-card frame for fast results.** Each create produces two frames (empty card, then chart); each costs layout 1.5–2, compositor commit ~1.5, style, pre-paint. `contain: layout paint style` on cards and panels, `content-visibility: auto` for off-screen cards; check that each chart's two canvases + the overlay are not separate composited layers needlessly; for creates, mount the card when the first result arrives or after ~50 ms, whichever first. | trace: layout 3.2–4.3, paint & composite 4.3–5.4, style 1.4 ms per cached create; drawn → frame 5–6 ms (19–21 p95) for cached creates | 1–3 ms per frame (uncertain; environment-heavy); cached/fast creates up to ~5–15 ms to frame; not counted by the exit-gate measure | `apps/desktop/src/renderer/src/app.css`, `packages/ui/src/styles.css`; the shell deferral in `views/ChartView.tsx` (coordinate with #3) |
| 8 | **React Compiler** (alternative to hand-memoizing #3/#9). Auto-memoizes JSX and callbacks, which removes the `unstable-props` renders (ShelfChip, Popover, Menu, Button, TypeMenu, ColumnListRow, ChartCard: ~75 % of the wasted renders). The code already passes the compiler's lint rules (eslint-plugin-react-hooks 7). App would still re-render on every store change, cheaply. | wasted renders: 64/95 create, 177/220 brush, 80/88 key press | ≈ the render half of #1 + #3: create −0.5 to −1, brush −3 to −5, key press −1.5 to −2 | `apps/desktop/electron.vite.config.ts` (and a `packages/ui` build path for tests), `package.json` (babel-plugin-react-compiler; check `@vitejs/plugin-react` 6 can run it). Decide #8 vs #3/#9 before starting either |
| 9 | **Column list rows memoized.** `ColumnListRow` gets inline `onTypeChange`/`onActivate` per row, so every App render re-renders every row with its TypeMenu, Popover and Button. Pass the column name to one stable handler; `React.memo` the row. | 8 renders (7 wasted) per create with 4 columns; linear in column count | ~0.2 ms with 4 columns; ~1–3 ms per interaction on 50–100-column files | `packages/ui/src/components/{ColumnListRow,TypeMenu}.tsx` (call site: #1) |
| 10 | **Canvas details.** New charts size four canvases and create their contexts (`setTransform` 0.8 ms, `getContext` 0.15–0.3, `drawImage` 0.4–0.5 self per create); `paintNow` re-sizes both on-screen canvases and rewrites their CSS size every frame; the marks layer is composited even without a brush. Skip unchanged style writes, reuse/lazily create offscreen layers, draw marks straight to the base canvas when nothing is brushed. | layers 0.9–1.0 + paint 0.6 ms per draw | −0.3 to −0.8 per draw (uncertain) | `packages/ui/src/charts/canvas.ts`, `packages/ui/src/charts/ChartFrame.tsx` (owner of #4) |
| 11 | **IPC / engine host.** Beyond engine time a fresh reply takes 0.7–0.9 ms p50 (1.9–3.4 p95); the 3.6–5 ms on cached creates is the renderer's main thread being busy, not IPC (#1, #4, #7 fix it). Measure engine-side spans (request parse in `session.handle`, `send`) before changing anything; reply validation in the renderer is ≤ 0.1 ms. | `request → reply − engineMs` | ≤ 1 ms p50, maybe 2 at p95 | `apps/desktop/src/engine/session.ts`, `apps/desktop/src/renderer/src/engine-client.ts` |
| 12 | **Arrow decode / adapter in a worker or on transfer: not now.** `tableFromIPC` is 0.3 ms (0.5–0.9 p95) and `chartColumnsFromArrow` 0.1 ms for the 360-cell heatmap; a worker hop costs about as much as it saves. Revisit for large results (M4 lines at wide plots, scatter). | decode / adapt work | < 0.5 | `apps/desktop/src/renderer/src/engine-client.ts`, `packages/ui/src/charts/arrow.ts` |

**What it adds up to.** For the exit-gate heatmap (10M, fresh) #1 + #2 + #3 +
#4 take drop → request from 2.0 to ~0.6 ms and reply → drawn from ~5 to ~3
ms: non-engine ~9 → ~5 ms p50 (12 → ~7 ms p95). That does not bring the
heatmap's p95 under 250 ms by itself (engine p95 251 ms). For brushes the
same items save ~6–10 ms of main-thread work and ~5 ms of latency (p50
59–70 ms); for a grid key press ~2–3 ms of its 7 ms to the frame; for cached
creates ~4 ms to drawn and more to the frame (#7).

### Parallel work: disjoint file sets

| Stream | Items | Owns | Depends on |
| --- | --- | --- | --- |
| A — app structure | #1, call sites of #3/#9 | `App.tsx`, new `views/{ColumnsPanel,GridPanel,ChartsPanel}.tsx`, `workspace.ts`, `views/TopBar.tsx` | – |
| B — query manager | #2 | new `query-manager.ts`, `views/chart-data.ts`, `views/crossfilter-tracker.ts` | A for the count/grid effects (or do charts first) |
| C — chart card | #3 (or #8) | `views/ChartView.tsx`, `packages/ui/src/components/{ChartCard,ShelfChip,Menu,Popover,Button,Switch}.tsx`, `packages/core/src/crossfilter/defaults.ts` | agree ChartView's props with A |
| D — chart frame & canvas | #4, #6, #10 | `packages/ui/src/charts/**` (hooks, ChartFrame, canvas, marks' `dataTable`, ViewData, WebGLOverlayProvider), `packages/ui/src/components/BarChart.tsx` | – |
| E — grid | #5 | `packages/ui/src/grid/controller.ts` | – |
| F — frame cost | #7 (CSS) | `apps/desktop/src/renderer/src/app.css`, `packages/ui/src/styles.css` | the shell deferral needs C |
| G — column list | #9 | `packages/ui/src/components/{ColumnListRow,TypeMenu}.tsx` | A for the call site |
| H — engine IPC | #11 | `apps/desktop/src/engine/session.ts` | – |

To check a change: run `pnpm --filter @glassgrid/desktop e2e:render` (and
`:10m`) three times before and after, and compare with
`render-perf-medians.ts`; the per-component tables show whether a wasted
render is gone, the segments where the time went.

## Files

- Instrumentation: `apps/desktop/src/renderer/src/render-perf-core.ts`
  (recorder, commit inspector), `render-perf.ts` (Profiler regions, chart
  draw hook), `perf.ts` (types), call sites in `main.tsx`, `App.tsx`,
  `engine-client.ts`, `views/ChartView.tsx`, `views/chart-data.ts`; the
  `model` event of `packages/ui/src/charts/perf.ts`; build flag in
  `apps/desktop/electron.vite.config.ts`.
- Benchmark: `apps/desktop/e2e/render-perf.spec.ts`, `render-analysis.ts`
  (milestones, segments, commits, profiles, traces),
  `render-perf-medians.ts`, shared driving in `e2e/charts.ts`.
- Results: `docs/benchmarks/render/render-perf-{1000000,10000000}-linux-x64-run{1,2,3}.json`
  (instrumented; per-sample milestones and commit totals, commit timelines for
  the first 3 samples of each variant, compact JSON), `render-perf-plain-*`
  (ordinary build: the app's measures only), `render-perf-medians-linux-x64.json`,
  and one CPU profile each of cached heatmap creates and brushes at 10M.
