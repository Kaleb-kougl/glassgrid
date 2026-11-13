# Live flights L4: cross-filter and history

Branch `live-flights` (from 0f83716), dated 2026-11-11. Milestone L4 of the
live-flights feature: the map joins the cross-filter (its viewport is its
selection, and the charts' brushes filter it back), a time scrubber moves the
views through the recorded data, and the selected aircraft shows its whole
track and its details. Plus a dev-server proxy, so `pnpm dev:web` shows live
traffic. It builds on [L3 data](live-flights-l3-data.md) (the map spec and
queries), [L3 map](live-flights-l3-map.md) (the component) and
[L2](live-flights-l2.md) (the feed), and keeps M3's cross-filter model
([M3 notes](m3-xfilter-notes.md)) and M1's command rules
([M1 commands](m1-commands.md)).

| Goal | Result |
| --- | --- |
| Dev proxy | `vite` (dev only) proxies exactly `/api/flights` to `GLASSGRID_FLIGHTS_PROXY` (default `http://localhost:3000`, the portfolio's Next dev server). `vite preview` and the build get no proxy and never read the variable (a malformed one stops only the dev server); production headers and CSP unchanged. Tested against a mock upstream through the real dev server, and by hand: `?live=1` on the dev server showed "Live · 40 aircraft" from a mock relay. |
| Map → cross-filter | The viewport is the map's selection: `lon` and `lat` ranges applied to every other view (charts, grid, other maps), never to the map itself. "Filter to map view" switch on the card, **on by default**, and a chip (`Map view`, its box in its accessible name and tooltip: `Bay Area traffic view 37.359–38.139°N, 122.87–121.63°W`). Pans record **no undo entry** (`setMapViewport`, view state); the switch is one entry each way (`setMapViewFilter`). MCP parity green (one new, reasoned exemption). |
| Charts → map | Verified: altitude brushes, category clicks and the new **vertical-rate histogram** filter the map's latest-fix query and the grid; clearing restores everything (unit, app and E2E tests). |
| Time scrubber and history | A whole fixture loads at once (`startLive { source: 'archive' }`, retention off) and the map's data clock becomes a view parameter T ("as of T"): a seek is a re-query, never a re-ingest. Keyboard slider (arrows, Page Up/Down, Home/End), UTC and local time, the data range, Play/Pause and 1×–120×, a Live switch for live data, "Load full day", "Charts follow time". `setTime` (no undo entry) and `setChartsFollowTime` (undoable), both MCP. |
| Selected aircraft track | A `track` map query (its fixes up to T, at most 2,001 points), drawn as a solid line in the selection colour (`selectedTrack`, one optional prop added to the contract), and a details strip (callsign, type, registration, altitude, speed, vertical rate, last seen). |
| Gate: brush → every view painted, p95 < 100 ms | **Not met on this VM** (2 vCPUs, software WebGL): 30-minute fixture p50 106.9 / p95 157.0 ms (an earlier run: 87.6 / 104.0); day fixture p50 97.6 / p95 125.7 ms. Map and charts alone: p95 108.3 / 105.6 ms. Engine work per brush is about 50 ms; the rest is main-thread rendering (numbers and profile below). |
| First load | `/` first-load JS **271.3 kB** gzip of 400 (264.4 before); map chunk 293.9 kB (293.1). |

## What was built

| File | What |
| --- | --- |
| `apps/web/dev-proxy.ts` (+ `dev-proxy.test.ts`), `vite.config.ts` | The `/api/flights` dev proxy; `preview.proxy: {}` |
| `packages/core/src/state/workspace.ts` | `MapBoundsSchema`; `MapViewState.filterToView?`, `.viewport?`; `TimeCursorSchema`, `DEFAULT_TIME_CURSOR`, `WorkspaceState.time?`, `.chartsFollowTime?` (all view state, optional) |
| `packages/core/src/crossfilter/map-selection.ts` | `roundBounds`, `mapViewportFilters`, `mapFiltersView`, `viewportCondition` |
| `packages/core/src/crossfilter/time.ts` | `TIME_FOLLOW_WINDOW_MS`, `timeCursor`, `resolveTime`, `playedToEnd`, `timeWindowFilter` |
| `packages/core/src/crossfilter/model.ts`, `chips.ts` | Map viewports composed like selections; the `timeFilter` context; viewport and time chips |
| `packages/core/src/commands/builtins/maps.ts`, `time.ts`, `mcp-exemptions.ts`, `all.ts` | `setMapViewport`, `setMapViewFilter`, `addMapView { filterToView }`, `setTime`, `setChartsFollowTime`; the `setMapViewport` exemption |
| `packages/core/src/commands/builtins/live.ts`, `flights/live.ts` | The `archive` source (`{ source: 'archive', fixture }` → `{ kind: 'archive', fixture }`) |
| `packages/core/src/spec/map.ts`, `sql/map.ts`, `protocol/engine.ts` | `compileMapTrackQuery`, the track bounds, `registration` in the latest query, the `arg_max` latest fix, unfiltered trails; `MapRequest.query: 'track'` with `aircraft` |
| `packages/core/src/workspace-file/persisted.ts`, `commands/builtins/open-file.ts`, `workspace.ts` | `PersistedMapViewSchema` (format 2 unchanged); view state reset on open and load |
| `packages/engine/src/live/archive-source.ts`, `flight-store.ts`, `live-feed.ts` | `ArchiveSource`, `FlightStore.loadParquet`, the feed's archive path |
| `packages/engine/src/session.ts`, `client/*`, `apps/desktop/src/renderer/src/engine-client.ts` | The track query through the protocol and both clients |
| `packages/ui/src/map/types.ts`, `MapView.tsx`, `scene.ts`, `aircraft-layer.ts` | `selectedTrack`; its thinning, geometry and draw; `data-track` |
| `packages/app/src/App.tsx` | The time cursor, viewport recording and timing, map paint timing, the scrubber's handlers, autoplay and end of play |
| `packages/app/src/views/TimeScrubber.tsx`, `AircraftDetails.tsx`, `MapCard.tsx`, `map-data.ts`, `map-viewport.ts`, `time-format.ts` | The scrubber, the details strip, the card's switch and toolbar, `useMapTrack`, viewport reports, time formatting |
| `packages/app/src/flights.ts`, `perf.ts`, `describe.ts`, `app.css` | `dataTimeRange`, `FLIGHTS_SAMPLE_ARCHIVE`, `FLIGHTS_DAY_ARCHIVE`, `VERTICAL_RATE_CHART`; `TIME_SEEK_MEASURE`; history labels; styles |
| `apps/web/src/flights.ts`, `web-engine.ts`, `app-route.tsx` | The sample loads the archive |
| `apps/web/e2e/flights.spec.ts`, `flights-perf.spec.ts` | The L4 E2E; the gate benchmark |
| `docs/benchmarks/l4/flights-perf-chromium-linux-x64.json` | The benchmark's JSON |

No dependency was added. `node scripts/third-party-notices.js --check` passes unchanged.

## Live data locally

```sh
# the portfolio (Next.js on :3000, which serves the real /api/flights):
GLASSGRID_SKIP=1 npm run dev
# here:
pnpm dev:web            # then open http://localhost:5173/?live=1
GLASSGRID_FLIGHTS_PROXY=http://127.0.0.1:3100 pnpm dev:web   # another upstream
```

- **What is proxied.** Exactly `/api/flights` with or without a query string
  (the key is the regular expression `^/api/flights(?:\?.*)?$`; a plain
  string key would also match `/api/flightsfoo`). The path stays at the
  site's root, outside the `/glassgrid/` base, as in production.
- **The target** is an http(s) origin; anything else fails the config with a
  message. `changeOrigin` sends the upstream its own Host.
- **Dev only.** `server.proxy` in `vite.config.ts`; `preview.proxy` is set to
  `{}` because Vite's preview otherwise inherits `server.proxy`. The build is
  untouched: `hosting.ts`, `csp.ts` and `vercel.json` did not change. The page
  still makes a same-origin request, so `connect-src 'self'` holds in dev too.
- **Tests** (`apps/web/dev-proxy.test.ts`, run by `pnpm --filter @glassgrid/web
  test`): the target rules, the key, that the resolved config has the proxy
  for `serve` and none for preview or build, then the real dev server from
  `vite.config.ts` in front of a mock upstream on a random port: `/api/flights`
  and `?probe=1` reach it (body, `Cache-Control`, the upstream's Host), other
  paths never do.
- **By hand:** a mock relay serving 40 synthetic aircraft, `pnpm dev:web`
  with `GLASSGRID_FLIGHTS_PROXY` pointing at it, Chromium on `?live=1`: "Live
  · 40 aircraft" after the first poll, polls every 20 s. (The real portfolio
  route was not run here.)

## Map → cross-filter

**The model.** A map's viewport lives on the map (`maps[i].viewport`, the box
its component last reported, rounded outwards to 1e-5°, the stored
precision) with `maps[i].filterToView` (absent: on). `compose` (core's
cross-filter model) appends, after every view's selection, each other map's
viewport as two inclusive ranges (`lon` channel x, `lat` channel y). So the
rule stays M3's: a view queries with every selection but its own. The map
queries with the charts' and grid's selections, the user filters and other
maps' viewports, never its own. `filterChips` lists one chip per filtering
map; removing it turns that map's filter off (clearing only the box would
bring it back on the next pan).

Why on the map and not in `selections`: `selections` is the analysis, saved
in workspace files and undone with every brush. The viewport is view state.
It is not saved (the camera is not), and it is written after every pan.
Keeping it beside the map means saving, the dirty check and undo all leave it
alone. Removing the map takes its viewport with it, and Undo brings both back.

**Default: on.** The plan expects the map to filter, and the filter is visible
where it acts: the switch sits in the map card's header, and a chip in the
filter bar names the box. Pans are debounced to 200 ms after `moveend`, so the
charts change once per gesture, not continuously. And at the initial view
the box covers most of the Bay Area (in the sample, 52,154 of 71,595 rows at
a 450 px card), so nothing jumps on open. People who find it distracting
turn it off once, and the switch says what it does. `addMapView
{ filterToView: false }` starts a map without it.

**Zoomed all the way out, the box covers all the data.** MapLibre keeps the
view inside the map's max bounds. With only the basemap's box (2° × 2°) a
card wider than tall could not show the data's north and south edges, so
the filter dropped fixes even at full zoom-out. The max bounds now grow
around the data's extent (`mapMaxBounds`: a square in Mercator, 10 % margin,
fitting cards up to 1.8 : 1 either way; the live feed's box, or a file's
lat/lon profile). Zoomed out, the chip reads 36.965–38.524°N,
123.50–121.00°W and the grid shows 71,595 of 71,595 rows. Beyond the
basemap the map is its background colour.

**Undo: pans are not undoable.** There was no coalescing in the registry
(M3's brushes are one entry per release because the UI dispatches on release
only), and none was added:

- `setMapViewport` is `undoable: false`, like `setSelection` and
  `setColumnProfiles`. It records no entry and keeps the redo stack. 100
  pans leave the history as it was (tested).
- Coalescing consecutive pans into one entry was rejected. Undo cannot move
  the camera: the component takes `initialView` at mount only. An undone
  viewport would therefore filter by a box the map no longer shows. The
  invariant is that the filter is what the map shows.
- `setMapViewFilter` (the switch) is a decision about the analysis, so it is
  one undo entry each way. Undo flips it back and keeps the newest box.
- When an undo restores an older box anyway (removing one of two maps and
  undoing that restores the other map as it was at the removal), the app
  records the camera's last report again (`useMapViewport` keeps it).

**MCP.** `setMapViewFilter` is exposed. `setMapViewport` is exempt
(`MCP_EXEMPTIONS.setMapViewport`): only the map can say what it shows, and
an agent cannot move the camera. Agents read the box from `get_state`
(`maps[i].viewport`) and filter by area with `addFilter` on `lat`/`lon`.
The parity test passes with this one new, reasoned entry.

**Cubes: deliberately bypassed.** A viewport is a two-clause selection with
arbitrary edges. M3's cubes answer one binned dimension exactly. A lat/lon
cube would be bins² large and still need the edge strips scanned to stay
exact. So a pan sends no hint and the views run plain SQL. In the app, a
change of a map's box (or of the time window) clears the active view, so a
histogram's hint is not sent against base filters its cubes were not built
for (the engine would otherwise build a cube to answer once). The next brush
start prepares cubes over the new box. Brushes after a pan are still answered
from cubes (60 of 60 cube-eligible answers in the benchmark). Pan timings
are below. On the 30-minute fixture a pan meets 100 ms at p50 (78 ms). On
the day fixture (1.46M rows) a pan costs five scans in single-threaded
DuckDB-WASM, 50 to 75 ms each.

**Timing.** A pan with the filter on is timed like a brush: report → every
other view painted (`glassgrid:crossfilter`, source `map:<id>`). Maps now take
part in the cross-filter timing as `map:<id>`, painted the frame after their
component got the snapshot.

## Charts → map

- It already worked in L3 (the map spec carried every view's selection). It
  is now covered at every level: core (a histogram brush is in the map's
  filters and its latest query compiles), the app (an agent's `addFilter`
  re-queries the map), and the E2E (brushing the altitude histogram above
  ~13,000 ft lowers the map's aircraft count, and the brush timing includes
  `map:map_1`). Undo restores everything.
- **The vertical-rate chart** (`VERTICAL_RATE_CHART`, added to the flights
  workspace when the table has `baroRateFpm`):
  - It is a histogram of `baroRateFpm` in 500 ft/min bins, with its own
    filter of −6,000 to 6,000 ft/min. That keeps 99.9 % of the fixes. The
    archive holds absurd values (down to −142,136) that would stretch an
    automatic axis into one bar.
  - A histogram, not a line of the mean rate over time. A brush on it reads
    directly as "climbing", "level" or "descending" (a range on the rate),
    and a cube answers it. A mean over time cancels climbs against descents,
    and its brush would select a time range, which the scrubber already
    owns.

### The map queries (L4 changes)

- **Latest fix: an aggregate instead of a window.** `arg_max(row, (time,
  -lat, -lon)) GROUP BY id`. It picks the same fix as L3's `row_number()
  OVER (PARTITION BY id ORDER BY time DESC, lat, lon) = 1`: the newest, ties
  broken by the smallest latitude, then longitude. On DuckDB-WASM (Node,
  one thread) over the 90 s window at 23:45, the window took 11 to 28 ms
  and the aggregate 6. Natively both take about 4. The engine tests compare
  it with independent SQL at many clocks on both drivers (`map-queries`,
  `archive`).
- **Trails ignore the spec's filters.** The trails are those of every aircraft
  seen in the window. The component already draws only the trails of the
  aircraft it is given. A brush, a click or a pan therefore changes only the
  latest-fix query, and the trails come from the result cache (same SQL and
  clock). On WASM that saved 20 to 30 ms per brush.
- **`registration`** is a 14th column of the latest query (after `ts`), for
  the details strip. The component ignores it.

## Time scrubber and history

**The as-of-T model.** L3's queries already took the data clock as a bound
value and ignored later fixes ("not after the clock"). L4 makes that clock a
view parameter T:

- The map shows each aircraft at its latest fix ≤ T, with its trail and the
  selected track up to T.
- A seek is a re-query at the new T, cached by T under the table's version.
  Nothing is ingested again.
- **`archive` source** (`ArchiveSource`; `startLive { source: 'archive',
  fixture }`): the whole fixture goes into an empty `flight_states` without
  retention, in one transaction, as `INSERT INTO flight_states SELECT
  <casts> FROM read_parquet(...) ORDER BY ts, hex` (`FlightStore.loadParquet`).
  - Time order lets the map's windows prune by zone maps.
  - No dedup: the fixtures are unique archive rows at stored precision
    (L2's gate). A fixture held in memory (tests, the WASM Node runtime)
    goes through the normal ingest as one batch.
  - It is reported like a batch, so the live table's caches are versioned
    as in L3.
  - States: `connecting`, then `live` once loaded (data clock: the last
    fix), `backoff` and a retry after 10 s on a failure that may pass, and
    `stopped` with its error on one that cannot (out of memory, a missing
    file, no Parquet): `isPermanentLoadFailure`. A failed load leaves the
    table empty (its INSERT rolled back) and still versions it, so nothing
    cached while it loaded survives. A start that fails (the file cannot be
    registered) reports the same `stopped` state over an empty table.
- **L2's replay is kept but no longer used by the UI.** The flights sample
  (`?sample=flights`, the start screen) now loads the 30-minute archive and
  plays it. `startLive { source: 'replay' }` still works, for agents and for
  L2's replay gate, which is unchanged. The live source is unchanged. Same
  commands, same tiers (`startLive` is `write`), no new exemption.

**The cursor** (`WorkspaceState.time`, view state):

- **Modes.** `{ mode: 'live' | 'paused' | 'playing', atMs, since, speed }`.
  `resolveTime` gives T: the data's end when live; `atMs` when paused;
  `atMs + (now − since) × speed` when playing. T is clamped to the data's
  range: the time column's profile minimum to the last batch's data clock.
  On a feed with retention the range starts no earlier than the batch's
  clock minus the retention, known with the batch, so the map is never
  queried at rows a batch just expired while the profile catches up.
  Paused longer than the retention, T shows the oldest fix kept and the bar
  says "Paused · older data has expired" (the cursor keeps the time it was
  paused at; Go live clears it).
- **Live data.** "Live" is the feed's clock. Turning the switch off holds T
  while the feed keeps polling and ingesting: each batch re-queries the map
  at the same T. The slider then reaches back over the retained 60 minutes,
  and Go live returns to now. Playing a live feed back catches up and goes
  live.
- **Archives and files** have an end instead. An archive opens playing from
  its first fix at 10× (30 minutes in 3) once the profile names that fix.
  Playing to the end pauses there; Play at the end starts over.
- **`setTime`** is `undoable: false`, like the grid selection. Scrubbing and
  playing never flood the history, and Undo steps through edits, not
  positions. Tier `edit`, MCP-exposed: an agent can look at a given time as
  a person scrubs.
- **Reset and saving.** `openFile` and `loadWorkspace` reset the cursor
  (undo restores it). Neither the cursor nor `chartsFollowTime` is saved
  (format 2 is unchanged).

**Dead reckoning stays consistent.** The map gets `playing: true` only while
T moves: following a running feed, or the cursor playing and not at the end.
Its `speed` is the cursor's speed, or the feed's for a replay.

- While the cursor plays, the app moves T on once per second of wall time
  (`TIME_TICK_MS`), re-queries, and the component's dead reckoning
  extrapolates at the same speed in between.
- Paused, there is no motion: each fix is drawn extrapolated to T, as L3
  draws a stopped feed.
- During a drag the cursor is paused. A drag started while playing plays on
  from where it was let go.

**Charts follow T: off by default, a switch to turn on.** With the switch off
(the default), the charts and the grid describe every loaded fix:

- An altitude brush describes the whole half hour or day, and the charts do
  not jitter while the map plays.
- Their cubes stay valid, because playing changes nothing they query.
- The map is the time view.

"Charts follow time" (`setChartsFollowTime`, one undo entry) adds the range
`time` in (T − 5 min, T]:

- 5 minutes, the length of the map's default trails, so the charts describe
  the fixes drawn as trails.
- It applies to the charts and the grid (not to maps, which are "as of T"
  already), with a chip (`ts last 5 min to 2026-11-09 23:45`) whose removal
  turns it off.
- While playing, it re-queries the charts once per tick, and the grid once
  per 4 s of wall time (`GRID_FOLLOW_MS`), so its rows are not replaced
  under the reader every second. Paused, the grid is at T at once. The
  active brush view is cleared each time, so the charts run as plain SQL.

**The grid keeps its place** when only what moves on its own changes: a
pan or zoom of the map, the time window moving on, a live batch. Its
`intent` (`gridIntentKey`: sort, user filters, every other selection, each
map's switch, "Charts follow time", column types) is unchanged, so the
source resets with `keepPosition`: the scroll stays (clamped to the rows
there are, the old row count kept until the new one arrives) and a
selection still in range stays. A brush, a filter, a sort or a switch is a
new intent and goes back to the top with nothing selected, as before. It
keeps the position, not the row: a row's place in a re-filtered view is
not anchored by its sort key.

**The scrubber** (`TimeScrubber`, in the first map card between its header
and the map):

- **Slider.** A `role="slider"` (`aria-valuemin`/`max`/`now` in epoch ms,
  `aria-valuetext` "23:41:05 UTC, 15:41:05 PST").
- **Keys.** Arrows step about 1/200 of the range, Page Up / Page Down about
  1/20 (`scrubSteps`: 10 s and 2 min for 30 minutes, 10 min and 1 h for a
  day), and Home and End jump to the ends.
- **Pointer.** Drags are throttled to one seek per frame.
- **Readouts.** T in UTC and local time, the local date in front when it is
  not the UTC date ("00:00:00 UTC Nov 8, 16:00:00 PST" at the day's start),
  and the data range ("Data: Nov 9, 2026, 23:27:00–23:57:59 UTC (31 min)";
  "Loading…" after another source loads, until its profile is back, never
  the old start with the new end).
- **Controls.** Play/Pause, a speed select (1×, 2×, 5×, 10×, 30×, 60×, 120×),
  the Live switch (`aria-pressed`; live and replay feeds only), "Charts follow
  time", and "Load full day (14.5 MB)" for the 30-minute archive.

**Load full day** starts `{ source: 'archive', fixture: 'flights-bay-day' }`.
The feed empties the table (a new store) and loads the day. The workspace,
the map's box and T are kept: the busiest half hour is inside the day. The
button's place (a fixed minimum width) then says "Loading the full day…",
"Full day loaded", or, if it failed, the error (`role="alert"`) with Retry
and "Back to 30 minutes"; the map card's status says "Didn’t load · …",
cut with an ellipsis so the title, the switch and Remove stay visible.
Loading the day, the half hour and the day again (also across Remove,
Undo and the start screen) frees each store: the live table's filtered,
unsorted grid pages use LIMIT/OFFSET rather than a row-number index (a
copy of the table, which, closed while it was built, leaked about 650 MB
in DuckDB-WASM and made the second day load run out of memory).

| Day fixture, 1,456,777 rows, 14.5 MB | Value |
| --- | ---: |
| Native DuckDB, `loadParquet` (archive test) | 880 ms; `duckdb_memory()` 247.8 MB |
| Native, the 30-minute fixture | 171 ms |
| Chromium, DuckDB-WASM in the worker: click → the table, profile and views on the day (`time-range` shows it) | 3.4 s (3.4–4.5 s over 4 runs; the file from localhost) |
| Chromium renderer RSS before → after (the engine worker runs in it) | 643 → 1,157 MB (+514 MB; WASM memory does not shrink) |

## Selected aircraft track

- **Query** (`compileMapTrackQuery`, `MapRequest { query: 'track', aircraft }`):
  - Every fix of the aircraft in the two hours up to the asked time
    (`MAP_TRACK_SPAN_MS`; the whole 60-minute live window), compared as
    `hex = $1` (no cast of each row). The app asks up to T's next whole
    minute (`MAP_TRACK_STEP_MS`) and leaves out the fixes after T, so a
    playing cursor re-queries once per minute of data time (every 6 s at
    10×), not every tick. Native, on the day table, the busiest aircraft:
    19.0 ms before, 9.4 ms bounded.
  - Thinned to the newest fix per bucket of `max(2 s, span / 2,000)`, where
    the span is that aircraft's own first to latest fix. So at most 2,000
    buckets, and a `LIMIT` of 2,001.
  - The first and the latest fix are always kept, ordered by time.
  - The spec's filters do not apply: the aircraft is the one selected on the
    map.
  - View scoped (`map:<id>:track`), re-queried when the selection, T's
    minute or the data change. The previous track stays on screen while the next loads.
  - Bounds tested on both drivers: the fixture's busiest aircraft (1,721
    fixes) gives exactly its 2 s buckets. A synthetic day of one fix per
    second gives 2,000 points. Before the first fix, and for an unknown
    aircraft, there is no track.
- **The contract change** is one optional prop, `selectedTrack?: readonly
  MapTrailPoint[]` (`types.ts` documents it), so L3 callers are unaffected.
  - Only points of `selectedHex` are drawn, so a stale track is never drawn
    for the wrong aircraft.
  - The line is solid and opaque in `chart.selectionStroke` (near black in
    light, near white in dark), 3.5 px wide against the trails' fading 2 px.
    It is drawn above the trails and below the glyphs, by the trail program
    with its times at `u_now` so nothing fades.
  - It is thinned like trails (one point per 8 s, sooner in a turn past 10°),
    at most the newest 5,000 points are used, and it breaks where fixes are
    more than 5 minutes apart. An aircraft that left coverage, or landed and
    flew again hours later, is not joined by a straight line.
  - The map's root has `data-track` (the count of points given for the
    selected aircraft).
- **Details** (`AircraftDetails`):
  - A strip under the map, so it never covers the aircraft or the map:
    callsign, type (`typeCode`), registration, altitude (or "On the
    ground"), speed, vertical rate (climbing / level / descending), last
    seen ("23:41:05 UTC, 12 s earlier" relative to T), and the track's
    point count.
  - A labelled region ("Selected aircraft UAL123") holding a description
    list, with a close button ("Clear the selection of UAL123"; Escape on
    the map does the same). A polite live region in the card announces
    "Selected UAL123".

## Numbers

Linux VM, 2 vCPUs (Xeon @ 2.1 GHz), 8 GB; Chromium 153.0.8010.12 headless,
WebGL on SwiftShader (software); DuckDB-WASM 1.32.0 (DuckDB 1.4.3) in the
page's worker; native DuckDB 1.5.6.

**The gate** (`GLASSGRID_E2E_FLIGHTS_PERF=1 pnpm --filter @glassgrid/web exec
playwright test e2e/flights-perf.spec.ts`, JSON in
[benchmarks/l4/](benchmarks/l4/flights-perf-chromium-linux-x64.json)):

- **Harness.** In the M3 style: the production build and headers, 1440×1000
  at DPR 1, the flights workspace, T paused at 23:45:59 UTC, "Filter to map
  view" on.
- **Brushes.** 20 brushes on the altitude histogram, each a new range
  (cubes prepared at pointer down, a 300 ms drag, release), timed release →
  every other view painted: the map, the category and vertical-rate charts,
  the grid's count and first page.
- **Pans.** 20 map pans, timed report → every other view painted.
- **Seeks.** 20 scrubber keys (Page Down, Arrow Up alternately), timed
  `setTime` → the map painted as of T.
- **Pauses.** 300 ms between rounds.

| ms (20 rounds each) | p50 | p95 | max | |
| --- | ---: | ---: | ---: | --- |
| **Brush, 30-minute fixture (71,595 fixes)** | **106.9** | **157.0** | 165.0 | earlier run: 87.6 / 104.0 / 108.5 |
| Brush, 30 min: map and charts only | 60.3 | 108.3 | 120.0 | |
| **Brush, day fixture (1,456,777)** | **97.6** | **125.7** | 132.0 | earlier run: 93.4 / 118.8 / 119.8 |
| Brush, day: map and charts only | 64.2 | 105.6 | 115.7 | |
| First brush (cubes built at its pointer down) | 92.5 / 81.2 | | | 30 min / day |
| Pan → every other view, 30 min | 77.8 | 119.5 | 143.8 | plain SQL (no cubes) |
| Pan → every other view, day | 294.3 | 397.0 | 403.3 | five scans of 1.46M rows, one thread |
| Seek → map painted, 30 min | 132.7 | 176.7 | 181.3 | engine 61.8 / 90.9 (latest + trails at a new T, peak traffic) |
| Seek → map painted, day | 60.6 | 76.3 | 149.3 | engine 40.5 / 53.5 (the seeks go back into quieter hours) |

Per view (30 min brushes, p50 / p95 ms painted, engine): map 53 / 84 (23 /
32), category bar 46 / 108 (7 / 18, cube), vertical rate 50 / 99 (6 / 11,
cube), grid count 85 / 136 (3 / 13, cube), grid first page 106 / 149 (17 /
39).

**Reading them.**

- **Where the time goes.** The engine work of a brush is about 50 ms: the
  map's latest-fix query 20 to 30, the grid's first page 15 to 40, the
  cubes' answers 3 to 18. The rest is the main thread.
  - In a CPU profile of eight brushes, JavaScript self time is small. Most
    of the busy time is the browser's own "(program)" work, about 180 ms per
    brush round including the drag: style, layout and paint, and
    SwiftShader's software rasterization of MapLibre's frame and the charts'
    WebGL layers, which `pnpm e2e:map-perf` already measured at 50 to 66 ms
    a frame on this VM (L3).
  - Earlier runs with half the brushes repeated (answers from the result
    cache, engine ≈ 0) still took 30 to 66 ms.
- **Verdict.** The p95 < 100 ms gate is missed here by 5 to 60 ms, and runs
  vary by ±25 % on these two shared vCPUs. As with L3's frame time, it needs
  a GPU machine (the macOS CI runners) to check. The M4 web demo recorded
  brush → every view painted at 115–265 ms on the same VM, so this is in
  line with the web shell's current state, not a regression.
- **Pans** on the day fixture are bound by DuckDB-WASM scanning 1.46M rows
  five times on one thread. A spatial cube with exact edge strips, or a
  second copy clustered by position, would be the fix (not done).
- **Seeks** at peak traffic spend 60 to 90 ms in the engine (latest fix and
  trails, each a scan of a window of the busiest minutes) before the map's
  frame.

## Review fixes (L4 browser review)

| Finding | Fix | Regression test (failed before) |
| --- | --- | --- |
| Stale feed state on reopen | `useLiveState` resets when inactive and takes the last message received, never ordering by data clock | `app/src/flights.test.tsx` |
| Second "Load full day" out of memory | No row-number index for the live table's filtered unsorted pages; permanent load failures stop with their error; failed loads version the table; failed starts report `stopped` over an empty table; the app re-queries when the batch goes away; status clipped with an ellipsis; Retry / "Back to 30 minutes" | `engine/e2e` "the day loaded whole, then the half hour, then the day again" (WASM, memory per step); `engine/src/live/archive.test.ts` (permanent failure, LIMIT/OFFSET pages, failed load, missing file); `App.time.test.tsx` (failure UI, views re-queried) |
| Grid jumps to the top on pans and ticks | `keepPosition` resets for the same intent; grid window every 4 s while playing | `ui/src/grid/CanvasGrid.test.tsx`, `app/src/views/grid-source.test.ts`, `App.time.test.tsx` |
| Chips overlap | Chips wrap, conditions ellipsised, × never shrinks, map chip "Map view"; the side panels give way so the grid keeps 280 px | `ui/src/components/FilterChip.test.tsx`, `App.map.test.tsx`, E2E |
| Minor | Local date; max bounds fit the data (`mapMaxBounds`); fixed slot for "Load full day"; range "Loading…" | `app/src/time-format.test.ts`, `ui/src/map/mercator.test.ts`, `MapView.test.tsx`, `App.time.test.tsx` |
| Plausible | Track bounded, no cast, per-minute horizon; wall clock stops without maps; dev proxy only for the dev server; retention-bounded range and the expired note | `core/src/sql/map.test.ts`, `App.time.test.tsx`, `apps/web/dev-proxy.test.ts` |

## Tests

| Suite | What |
| --- | --- |
| `apps/web/dev-proxy.test.ts` (5) | Target rules, the exact key, dev-only config (preview and build none), the real dev server in front of a mock upstream |
| `core/src/commands/l4-commands.test.ts` (13, one fast-check) | Rounding outwards (no floating-point creep); filters on every other view and never the map's own; compile on the flight columns; a brush in the map's filters; cube targets carry the box; two maps; **property: each view gets every other active viewport once, never its own, and each chip turns its map's filter off** (300 runs); chips; **100 pans: no undo entry, redo stack and saved digest unchanged**; the switch's undo/redo; MCP exposure and exemption, bounds validation; removing a map and undo; `resolveTime`, `playedToEnd`; `setTime` (no entry, MCP, refusals, not saved); charts follow T (window, chip, undo, maps untouched); open and load reset |
| `core/src/sql/map.test.ts` (+2, snapshots) | Track SQL, params, bounds, no lower bound and no filters; refused aircraft ids; the latest query's `arg_max`; trails without filters equal to trails with them |
| `core/src/protocol/engine.test.ts` (+) | A track names its aircraft, and only a track does |
| `engine/src/live/archive.test.ts` (8, native and wasm) | **The 30-minute archive equals the fixture** (native: `EXCEPT ALL` both ways), stored in time order; one batch, state `live`, never ended; starting it again loads nothing; **as of T, seeking in any order: L3's 187 / 171 / 186 aircraft, each at its newest fix ≤ T**, registration, trails up to T; **the track's bounds** (busiest aircraft: one point per 2 s bucket, first to latest, ordered, ≤ T; none before its first fix); a failing load backs off and retries; native: the day loads (time, memory); a day of 1 s fixes thins to 2,000 points |
| `engine` map, live-table tests | Unchanged assertions pass with the new latest query (the field list gains `registration`) |
| `ui/src/map/scene.test.ts` (+1), `MapView.test.tsx` (+1) | Only the selected aircraft's track points, sorted, thinned, opaque in the selection colour, broken at a 10-minute gap, rebuilt only when it changes; the prop reaches the root's `data-track` |
| `app/src/App.map.test.tsx` (13) | The viewport filters the charts and the grid (lat/lon ranges), not the map, with no undo entry and a chip; the switch (one entry each way, pans while off, undo) and the chip turning it off; **select → the track query up to T, the track drawn, the details** (callsign, type, registration, altitude, speed, rate, last seen, points), re-queried on a new T, cleared by Close |
| `app/src/App.time.test.tsx` (5) | An archive loads and plays from its first fix at 10× (the map as of T, dead reckoning on, T 10 s on after a second, Pause, played to the end holds, Play starts over, no undo entries); **the keyboard slider** (End, Page Down, arrows, Home, values, value text); a live feed's Live switch (T holds while batches arrive, the slider reaches back, Go live); **charts follow time** (the window on charts and count, not on the map, chip, undo); Load full day keeps T |
| `apps/web/src/flights.test.ts` | The sample loads the archive and the vertical-rate chart |
| `apps/web/e2e/flights.spec.ts` (3) | The sample loads 71,595 fixes at once and plays (clock moves, three charts); **pan → charts and grid repaint (timed), rows change, chip changes; brush the altitude histogram → fewer aircraft and the map in the timing; scrub → the clock and the drawn aircraft change; Undo; click an aircraft → details, track, announcement; back in time → a shorter track; the switch off → every row**; Remove / Undo / Ctrl+Z / open a CSV still safe |
| `apps/web/e2e/flights-perf.spec.ts` | The gate (opt-in) |

Totals: core 388, engine 362 passed and 17 skipped (both projects), app 93,
web 48, ui 277, desktop 91, datasets 40; web E2E 13 passed and 2 skipped
(the two opt-in benchmarks). Gates: `pnpm lint`, `pnpm typecheck`, `pnpm
test`, `pnpm e2e:web`, `pnpm --filter @glassgrid/web size` and `node
scripts/third-party-notices.js --check` pass.

## Unverified and known gaps

- **The 100 ms gate** is missed on this VM (above); it needs a GPU machine.
- **Pans on the day fixture** take 0.3 to 0.4 s (plain scans on one WASM
  thread). Cubes do not cover a 2-D box.
- **The real portfolio dev server** was not run here; the proxy is tested
  against a mock upstream and by hand with a mock relay.
- **Memory** of DuckDB-WASM itself was not read in the browser (the engine has
  no memory request); the renderer's RSS and native DuckDB's accounting
  stand in.
- **The viewport filter's default** is on for every map, including maps
  restored from L3 workspace files (their `filterToView` is absent). At the
  initial view it filters little.
- **Neither the switch nor the cursor is saved.** A format 3 could save the
  switch; the viewport and T are view state.
- **An agent's area filter** goes through `addFilter`. It cannot set the map's
  box (`setMapViewport` is exempt), so the camera and the filter never
  disagree.
- **The grid keeps its scroll position** across pans, the time window and
  live batches, not the row under it (no sort-key anchor).
- **"Paused · older data has expired"** was tested in the app (a fake
  feed), not in a browser: the real feed is never called here, and a replay
  needs an hour of fixture time to expire anything.
- **Track timings in WASM** were not measured (the Node WASM runtime has no
  Parquet); the native numbers stand in.
- **Firefox and Safari** were not run.

## Reproduce

```sh
pnpm --filter @glassgrid/core test
pnpm --filter @glassgrid/engine exec vitest run src/live/archive.test.ts src/live/map-queries.test.ts   # both drivers
pnpm --filter @glassgrid/app test
pnpm --filter @glassgrid/web test                                                                      # includes the dev proxy
pnpm e2e:web                                                                                           # includes flights.spec.ts
pnpm --filter @glassgrid/web build && GLASSGRID_E2E_FLIGHTS_PERF=1 pnpm --filter @glassgrid/web exec playwright test e2e/flights-perf.spec.ts
```
