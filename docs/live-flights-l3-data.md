# Live flights L3 (data and app): map views over `flight_states`

Branch `l3-data` (from `live-flights` at 0e56f12), dated 2026-11-10. The
data and app half of milestone L3 ("Map view"): the live feed's table
becomes a table like any opened file, a `map` view spec joins charts in
core (compiler, commands, the workspace format), and the app renders map
views from `@glassgrid/ui/map`. The MapLibre component itself, the
basemap assets, the CSP and the web build config are the other half
(another branch); here a stand-in component takes their place. It builds
on [L2](live-flights-l2.md) (the feed and `flight_states`) and
[L0](live-flights-l0.md) (the schema and fixtures).

| Goal | Result |
| --- | --- |
| `flight_states` queryable | Opened under a reserved handle (`fh_live-flight-states` → `tb_live-flight-states`), with the fixtures' column types, its row count and a constant fingerprint. The grid, counts, profiles, charts, cross-filter cubes and map queries all run on it through the existing requests. |
| Caches per batch | Every ingested batch moves the table's version on and drops its cached results, cubes, sort indexes and profile statistics **before** the batch is reported; a result keyed with an older version is never served and is not stored when it finishes late. Proven on both drivers (`live-table.test.ts`). The table has no Parquet copy (`not_implemented`). |
| A `map` view spec | `MapSpecSchema` (`{ kind: 'map', lat, lon, id, time, filters, trailMinutes }`, Zod, strict) validated in commands, the workspace file and the engine request; `compileMapLatestQuery` and `compileMapTrailsQuery` with snapshot tests. |
| Latest and trails on the real fixture | At three clocks in the busiest half hour, 187 / 171 / 186 aircraft, each equal to an independent `count(DISTINCT hex)` over the 90 s before the clock, at its newest fix; trails equal the independent count of (aircraft, bucket) pairs, end at the aircraft's marker, at most 101 points each. Native and DuckDB-WASM. |
| Workspace format 2 | `workspace.maps`; layout cards may name maps. Migration v1 → v2 (no maps), the v1 schema kept, a new `v2-flights` fixture byte for byte, the future fixture moved to v3. The three web samples re-saved as v2. |
| Commands | `addMapView`, `updateMapView`, `removeMapView`: state commands, tier `edit`, Immer patches (undo/redo tested), `mcp: true`. The parity test passes with no new exemption. |
| App | `MapCard` lazy-loads `loadMapView()`, shows "Loading map…", feeds aircraft, trails and the clock from one consistent pair of queries, re-queries on every live batch and on filter changes, drops stale replies; `playing`, `speed`, `dataClockMs`, theme, `assetsBase`, attribution; `onSelect` → selected aircraft (UI state); `onViewportChange` kept, no filter yet (since L4 the viewport is the map's selection: [L4](live-flights-l4.md)). |
| Web demo | `?sample=flights` (also on the start screen) starts a replay of `flights-bay-30min.parquet` and opens a map, an altitude histogram and a category bar over `flight_states`; `?live=1` does the same with the live relay. A Chromium E2E covers the replay. |
| Desktop | Typechecks and its tests pass; it gets `mapQuery` in its engine client but no `Platform.map`, so a map card there says maps are not available yet (below). |

## What was built

| File | What |
| --- | --- |
| `packages/core/src/spec/map.ts` | `MapSpecSchema`, the bounds (`MAP_FRESHNESS_MS`, `MAX_MAP_AIRCRAFT`, `MAP_TRAIL_BUCKETS`, `MAX_MAP_TRAIL_POINTS`, trail defaults), `MAP_AIRCRAFT_FIELDS`, `MAP_TRAIL_FIELDS`, the row types, `mapSpecColumns` |
| `packages/core/src/sql/map.ts` (+ test, snapshots) | `compileMapLatestQuery`, `compileMapTrailsQuery` |
| `packages/core/src/flights/table.ts` | `LIVE_FLIGHTS_HANDLE`, `LIVE_FLIGHTS_TABLE_ID`, `LIVE_FLIGHTS_TABLE_NAME`, `LIVE_FLIGHTS_FINGERPRINT`, `isLiveFlightsTable` |
| `packages/core/src/protocol/engine.ts` | `MapRequestSchema` (`kind: 'map'`, view scoped, answered `arrow`), `MapQueryKindSchema` |
| `packages/core/src/state/workspace.ts` | `MapViewStateSchema`, `WorkspaceState.maps`, `MAX_MAP_VIEWS` (8) |
| `packages/core/src/workspace-file/*` | Format 2: `maps` in the persisted subset, restore (`map_dropped`), `file-parts.ts` (the schemas outside the workspace block, shared by versions), `WorkspaceFileV1Schema` and `migrateV1ToV2` |
| `packages/core/src/commands/builtins/maps.ts` | `addMapView`, `updateMapView`, `removeMapView` |
| `packages/engine/src/query-service.ts` | The live table: `liveTable`, `buildLiveTable`, `liveIngested`, `forgetLive`, `versionOf`, `remember` |
| `packages/engine/src/live/live-feed.ts` | `onIngested` and `onStoreClosing` hooks (awaited), `idle()` |
| `packages/engine/src/session.ts` | `runMapQuery` and the `map` request |
| `packages/engine/src/client/*`, `apps/desktop/src/renderer/src/engine-client.ts` | `EngineClientApi.mapQuery` (`MapQueryRequest`) |
| `packages/app/src/views/MapCard.tsx`, `map-data.ts`, `map-viewport.ts`, `MapBoundary.tsx` | The card (status line, altitude key), the data hook and Arrow mapping, the viewport store, the error boundary |
| `packages/app/src/flights.ts` | `useLiveState`, `mapClock` (with the feed's state), `feedLabel`, `feedStatusLine`, `shortFeedError`, `liveFlightsWorkspace`, `FLIGHTS_SAMPLE_REPLAY`, `openLiveFlightsWorkspace` |
| `packages/app/src/views/TopBar.tsx` | The live table's rows and feed state in place of a file size |
| `packages/app/src/platform.ts` | `PlatformMap` (`assetsBase`, `attribution`), `Platform.map` |
| `apps/web/src/flights.ts`, `web-engine.ts`, `web-platform.ts`, `app-route.tsx` | The flights sample, `?live=1`, `webMap()` |
| `packages/ui/src/map/index.ts`, `types.ts` | **Stand-in** for the map agent's component (marked `L3-STUB`), plus the `"./map"` export in `packages/ui/package.json` |

No dependency was added.

## Design

```
engine (worker or utility process)                                   page
──────────────────────────────────                                   ────
LiveFeed ── batch ──▶ FlightStore.ingest (BEGIN … COMMIT)
   │                    └─ onIngested ─▶ QueryService.liveIngested:
   │                         version ← store generation . batch count
   │                         drop results, cubes, sort indexes, stats
   │                         event tableUpdated (rowCount)
   └─ then ─▶ event liveState (lastBatch) ─────────────────────────▶  useLiveState → batch key changed
                                                                       → dataVersion + 1 (same render)
open(fh_live-flight-states) ─▶ views over flight_states  ◀── grid, count, profile, aggregate, cubes
map(spec, 'latest' | 'trails', dataClockMs) ─▶ compileMap*Query ─▶ aggregate cache  ◀── MapCard
```

### The live table

- **Identity.** One reserved handle, `fh_live-flight-states`, whose table
  id `tb_live-flight-states` follows `tableIdForFile` like any other. File
  handles are `fh_<uuid>`, so nothing can collide. The app records it with
  `openFile` / `loadWorkspace` as the data source, so the grid, the column
  list, charts and cross-filter work unchanged.
- **Fingerprint: constant.** Size 0, mtime 0, fixed digests. The
  fingerprint names "the feed's table", whatever source fills it. A
  fingerprint that changed per poll would make the workspace's data source
  stale twice a minute and tell the person their data "changed since the
  workspace was saved" on every open. What changes per batch is versioned
  inside the engine instead.
- **The state.** `QueryService` builds a `TableState` over the feed's
  current `FlightStore` on first use: views in the store's own database
  (`gg_tb_live-flight-states`, `_raw`, `_ord`), `source: { kind: 'live' }`,
  the row count from the store. Type overrides work as on a file.
- **A new source is a new state.** The feed empties the table by making a
  new store (another source, another fixture, a replay restarted). Before
  the old store closes, `onStoreClosing` lets `QueryService` forget the
  state, drop its caches and interrupt its queries. The next request builds
  a state over the new store with the next generation number. The feed's
  database is the feed's: closing the table (`closeTable`, the app opening
  another file) forgets the views, never the rows.
- **After an engine restart** the app starts the feed again before views
  re-query. A request that arrives while a start is still queued waits for
  it (`LiveFeed.idle()`) instead of failing with `unknown_table`.

### Cache invalidation per batch

The engine caches four things per table, all keyed by the table's
`version` (part of `QueryService.key`, the coalescing key, cube keys and
sort index names):

| Cache | On each batch |
| --- | --- |
| Result cache (pages, counts, top-K blocks, aggregates, map queries) | `invalidateTable`; later results under an older key are not stored (`remember`) |
| In-flight coalescing | keys carry the version, so no request joins a query of another batch |
| Cross-filter cubes | removed and their tables dropped; a build that finishes under an older version is dropped (existing check) |
| Sort indexes | dropped; new names follow the version |
| Profile statistics | cleared; a scan that raced a batch does not write its statistics (retried up to 3 times) |
| Parquet cache | none: `ensureParquetCache` answers `not_implemented` |

`versionOf(state)` is the overrides' digest plus `~live<generation>.<batch>`
for the live table, so a version never repeats, across batches or stores.

**Ordering.** `LiveFeed` awaits `onIngested` after the batch's `COMMIT`
and before it reports the batch (`liveState`), and `QueryService` emits
`tableUpdated` there. So a client that re-queries on the event never gets a
result of an earlier batch. A query keyed with version *v* reads at least
batch *v*'s rows: the version moves on only after the commit. It may read a
later batch's rows if that batch commits first; then its key is dropped at
that batch's report. Whatever is cached is never older than its key.

The test (both drivers) caches a filtered count, a sorted page (through a
sort index), a bar aggregate, a map query and the profile, checks the
second round is all `cached`, builds a cube, then ingests a batch and
records, from inside the `liveState` listener, what is still cached:
0 results, 0 cubes, 0 sort indexes, with `tableUpdated` emitted just
before. The same requests then answer uncached, with the new rows, and
agree with SQL on the store's own connection.

### The map spec

```ts
{ kind: 'map', lat: 'lat', lon: 'lon', id: 'hex', time: 'ts', filters: Filter[], trailMinutes: 5 }   // defaults shown
```

- **The four named columns** are what a map needs: a position, an aircraft
  and a fix time. They default to the flight-point layout, so `{ kind:
  'map' }` is the whole spec over `flight_states` or a flights Parquet file;
  another table names its own (`id` text or integer, `time` a timestamp,
  `lat`/`lon` numeric; checked by the compiler with paths).
- **Attributes** (callsign, type, category, altitudes, speed, track,
  vertical rate, on-ground) are read by their `FlightPoint` names when the
  table has them, through `TRY_CAST`, and are null (on-ground false)
  otherwise.
- **No `color` channel.** The component contract has no colour input, and
  a persisted field nothing reads would be a promise the format cannot
  keep. Adding one later is a format change like any other.
- **`filters`** are the map's own; the app appends every view's selection
  and the user filters, as a chart does with `viewQueries`. A map owns no
  selection yet. (L4: it does now, its viewport, applied to every other
  view and never to itself; [L4](live-flights-l4.md#map--cross-filter).)
- **`trailMinutes`**: whole minutes, 0 to 30, default 5; 0 skips the trails
  query.
- **Where it lives in the state**: `WorkspaceState.maps`, next to `charts`,
  each `{ id, spec, title? }` with a layout card. Not a chart mark: every
  chart path (shelves, `setMark`, cubes, axes) assumes a chart spec, and a
  map is a different kind of view.

### The queries

**Latest fix per aircraft** (snapshot in `sql/__snapshots__/map.test.ts.snap`).
L4 changed two things here ([L4](live-flights-l4.md#the-map-queries-l4-changes)):
the newest fix is now an `arg_max` of the row by `(ts, -lat, -lon)` (the
same fix as the window below, faster on DuckDB-WASM), the trails query no
longer applies the spec's filters (the component draws only the shown
aircraft's trails, so a brush leaves the trails query cached), and the
latest query also returns `registration`:

```sql
WITH latest AS (
  SELECT * FROM <view>
  WHERE "ts" > epoch_ms($clock - 90 s) AND "ts" <= epoch_ms($clock)
    AND "hex" IS NOT NULL AND "lat" IS NOT NULL AND "lon" IS NOT NULL
  QUALIFY row_number() OVER (PARTITION BY "hex" ORDER BY "ts" DESC, "lat", "lon") = 1
),
shown AS (SELECT * FROM latest WHERE <filters> ORDER BY "ts" DESC, "hex" LIMIT 2000)
SELECT CAST("hex" AS VARCHAR) AS "hex", …, CAST("lat" AS DOUBLE) AS "lat", …, CAST(epoch_ms("ts") AS DOUBLE) AS "ts"
FROM shown ORDER BY 13 DESC, 1
```

- **Freshness: 90 s** before the data clock (`MAP_FRESHNESS_MS`). It was
  60 s, L0's "aircraft in view" rule, but the fixtures have many gaps of
  60 to 70 s between one aircraft's fixes, and those aircraft blinked out
  for a batch. An aircraft that lands, leaves the box or stops reporting is
  gone 90 s after its last fix; the map extrapolates a fix for at most 60 s
  (`dead-reckoning.ts`, unchanged), so for its last 30 s it stands still at
  its 60 s position instead of flying on. Limiting the scan to those 90 s
  before the window function gives the same aircraft and the same newest
  fix as ranking every fix, and scans 90 s instead of the table.
- **Not after the clock.** Fixes later than the clock are ignored, so a
  query at a clock means the same on a table that only reached it (a
  running replay) and on one that holds the whole day (a Parquet file, a
  replay with retention off). That is what lets the tests replay the
  fixture to the end and then query any clock.
- **Filters apply to the latest fix**, after the window: a map shows where
  aircraft are now, so "above 10,000 ft" means aircraft that are above it
  now, not ones that once were (whose older position would otherwise be
  drawn). Filtering before the window would be the other reading.
- **Bounded**: at most 2,000 aircraft (the freshest); the Bay Area peaks
  under 200.
- **Types**: DECIMAL positions and INTEGER altitudes come back as DOUBLE,
  `ts` as DOUBLE epoch milliseconds (exact below 2^53), text as VARCHAR,
  so Arrow decodes them to plain JS numbers, strings and booleans and the
  app maps rows to `MapAircraft` without conversions of its own.

**Trails**: the same two CTEs, then the fixes of the shown aircraft
(`"hex" IN (SELECT "hex" FROM shown)`) in (clock − trailMinutes, clock],
thinned with `QUALIFY row_number() OVER (PARTITION BY "hex",
floor(epoch_ms("ts") / bucket) ORDER BY "ts" DESC) = 1` where `bucket =
trail / 100` (3 s for 5 minutes, 18 s for 30). So a trail has at most 101
points and always its newest fix (the marker), ordered by hex then ts,
capped at 2,000 × 101 = 202,000 rows. On the fixture: 6,840 points for 186
aircraft at 5 minutes, 8,509 at 30.

Both queries run through `QueryService.aggregate`, so they are cached by
SQL and bound values (the clock is a bound value) under the table's
version.

### Workspace format 2

- **The change**: `workspace.maps` (array of `{ id, spec, title? }`, at
  most 8), after `charts`; layout cards may name a map id (the field keeps
  its name, `chartId`, so v1 layouts stay valid); one id names one view
  (a chart and a map may not share an id).
- **Migration v1 → v2** adds `maps: []` and changes nothing else. The v1
  schema stays in `migrations.ts` (`WorkspaceFileV1Schema`) and validates
  the migration's input; v0 files migrate through v1.
- **Fixtures** (never regenerated): `v1-full` now migrates (its test checks
  that only the version and the empty map list differ from what the taxi
  workspace saves today), new `v2-flights` (two maps, two charts, a brush;
  byte for byte), `future-v2` became `future-v3` (a newer file is now 3).
- **Restore** drops a map whose columns the data no longer has
  (`map_dropped`) and its card, and repairs layouts over charts and maps.
- **The web samples** (`apps/web/public/samples/*.glassgrid`) were
  re-saved in format 2 by parsing and serializing them with core (the
  same serializer `tools/datasets/src/samples.ts` uses, now with `maps:
  []`), and their `workspaceSha256` updated in the manifest. The Parquet
  files are unchanged.
- **What is not saved**: the selected aircraft and the viewport (view
  state).

A workspace over the live table can be built in state like any other, but
it is not saved anywhere in this milestone: the web demo cannot save
workspaces, and the desktop has no live feed. Saving one would also need
the data block to say "the live table" instead of a file path, which is a
format change for whoever wires live data to the desktop.

### Commands

| Command | Input | Notes |
| --- | --- | --- |
| `addMapView` | `{ spec?, title? }` | Default spec: the flight-point layout. Fails without a file, over a table without the columns (the compiler's message and path, e.g. `spec.lat`), or past 8 maps. Adds a card. |
| `updateMapView` | `{ mapId, trailMinutes?, filters?, lat?, lon?, id?, time?, title? }` | At least one field; checks the result with the compiler; `title: null` resets. |
| `removeMapView` | `{ mapId }` | Removes the map and its card. |

All three are state commands (Immer patches, one undo entry each), tier
`edit`, `mcp: true`; the registry's list and the parity test include them.
`openFile` clears maps; `loadWorkspace` restores them. History labels:
"Added a map", "Set the map trail to 30 min", "Removed a map".

### The app

- **Rendering.** Map cards come first in the charts panel, before the
  chart cards; "+ Map" in the panel header adds one when the table has
  `lat`, `lon`, `hex` and `ts`. A card loads the component once per page
  with `loadMapView()` (a lazy chunk in the real implementation) and shows
  "Loading map…" until it resolves, an alert if it fails (retried on the
  next mount), and "Maps are not available in this app yet." on a shell
  without `Platform.map`.
- **Data** (`useMapData`). Two engine requests per map and inputs, view
  scoped (`map:<id>:latest`, `map:<id>:trails`), taken together: the
  component always gets aircraft, trails and the clock they were computed
  for. A reply for inputs that are no longer current is dropped (the
  engine also supersedes the older request). The previous snapshot stays
  on screen while the next loads.
- **When it re-queries.** The key is (table, spec with filters, data clock,
  data version). On the live table every new batch (a new `lastBatch` in
  the `liveState` events) bumps the data version in the same render that
  moves the clock, so each batch is one pair of requests, and every other
  view (grid, count, profile, charts) re-queries with it. Filter changes
  (brushes, chips, an agent's `addFilter`) change the spec.
- **Props**:

  | Prop | From |
  | --- | --- |
  | `aircraft`, `trails` | the latest-fix and trails queries; before the first snapshot, the same frozen empty arrays every render (a new array is "new rows" to the map: a restarted wall clock and an ease) |
  | `dataClockMs` | the live table: `lastBatch.dataClockMs`; another table: the time column's profile max (a still picture at its newest fix) |
  | `playing` | the feed's status is not `stopped` and it is not `paused` |
  | `speed` | a replay's `speed` (default 1); absent for live data and files |
  | `initialView` | the Bay Area box's centre at zoom 8 on the live table |
  | `attribution` | the feed's `attribution` (the fixture's ODbL line, or the relay's), else `ADSBLOL_ATTRIBUTION`, then `Platform.map.attribution` |
  | `theme` | the app's resolved theme |
  | `assetsBase` | `Platform.map.assetsBase` (web: `<base>map/`) |
  | `selectedHex`, `onSelect` | one selected aircraft for every map, React state (not the workspace); cleared when no map's latest snapshot has it (it landed, left or stopped reporting) and when the table or the workspace changes (another file, a workspace loaded or undone) |
  | `onViewportChange` | stored per map in a ref (`useMapViewport`); since L4 recorded as `maps[i].viewport` (`setMapViewport`) and, while "Filter to map view" is on, a lat/lon selection of the map ([L4](live-flights-l4.md#map--cross-filter)) |

- **The status line** (in the card's header) says what the live feed is
  doing, in L2's states, then the aircraft count: "Starting the replay…",
  "Connecting to the live feed…", "Replay 5× · 186 aircraft", "Live · …",
  "Stale data · …", "Retrying in 14 s · HTTP 404" (counting down to the
  feed's `nextAttemptAt`, with its last error, the endpoint URL left out),
  "Stopped", "Replay ended" (", paused" while the page is hidden). A
  visually hidden `aria-live="polite"` region beside it announces the same
  state once per change, without the countdown or the count ("Bay Area
  traffic: The live feed is unavailable after 3 failed attempts: HTTP 404.
  Next try at 15:02:32."). `?live=1` without a relay now shows that instead
  of "Waiting for data…" forever. Other tables show only the count.
- **The altitude key**: `AltitudeLegend` from `@glassgrid/ui/map` over the
  map's top-left corner (the attribution is bottom-right), on the raised
  background with primary text in both themes, hidden while the map shows
  its own error message there. It does not take pointer events.
- **The top bar** shows the live table's row count and the feed's state
  ("12,345 rows · Replay 5×", "0 rows · Retrying") instead of a file size:
  its fingerprint's size is a constant 0.
- **Failures stay in the card.** `MapBoundary` (an error boundary) wraps
  the component inside each card: an error while it renders or in an
  effect shows "The map stopped working: …" with "Restart the map". A
  second one wraps all the map cards, because an error thrown while a card
  is being removed goes to the nearest boundary that stays mounted ("A map
  stopped working." with "Show the maps again"). Either logs a
  `[glassgrid] map:` warning. Before, such an error unmounted the React
  root and left the page blank (the review's finding: MapView's teardown
  threw on every Remove; fixed in MapView, see the map doc).
- **The live feed's state** comes from the engine's `liveState` events
  (`useLiveState`), read only while the live table is open, since asking a
  lazy engine for its state would start it.

### The web demo

- `?sample=flights`, and a fourth sample on the start screen ("Live
  flights (replay)"): `startLive { source: 'replay', fixture:
  'flights-bay-30min', intervalSeconds: 2, speed: 5 }` (10 s of fixture
  every 2 s; the fixture plays in about 6 minutes), then `open` of the live
  table and one `loadWorkspace` with a map ("Bay Area traffic", 5-minute
  trails), "Barometric altitude (ft)" (histogram) and "Fixes by emitter
  category" (bar). The link stays in the address bar like the other
  samples'.
- `?live=1`: the same with `{ source: 'live' }` (the site's
  `/api/flights`, every 20 s). Vite's preview server has no such route, so
  there the source backs off on 404s; since L4 the dev server proxies it to
  the portfolio's dev server ([L4](live-flights-l4.md#live-data-locally)).
  Since L4, `?sample=flights` loads the fixture whole instead of replaying
  it ([L4](live-flights-l4.md#time-scrubber-and-history)).
- **Built in code, not a sample file.** A `.glassgrid` sample names a data
  file the page fetches and relinks (`samples.ts`); this workspace reads
  the engine's live table, which is started, not fetched. So the workspace
  is `liveFlightsWorkspace(columns)` in the app, over the columns the
  engine reports for the table, and the samples manifest is unchanged.
- **Basemap**: `Platform.map = { assetsBase: withBase('map/'), attribution: [] }`.
  The platform adds no credit of its own: MapView appends the basemap's
  credits (Natural Earth, OurAirports) from
  `apps/web/public/map/basemap.json` after the data's line. (Before the
  merge this was a guessed OSM credit; the basemap has no OSM data.)

### Desktop

The desktop typechecks and its 91 tests pass. Its `EngineClient` gained
`mapQuery`, and its engine host answers `map` requests (the session is
shared), so a map view over a flights file opened like any other would
query correctly; but the desktop platform has no `Platform.map` (no
basemap assets, CSP or MapLibre chunk are wired there), so a map card on
the desktop says maps are not available yet, and "+ Map" still adds one.
The desktop has no live feed (L2), so the live table never opens there.

## Contract assumptions the map component must honour

- `@glassgrid/ui/map` resolves to `packages/ui/src/map/index.ts` (the
  `"./map"` export added to `packages/ui/package.json`), and importing it
  is cheap: it exports the types and `loadMapView()`, and only
  `loadMapView()` pulls MapLibre (a dynamic import). The app imports it
  statically from `MapCard`.
- `loadMapView()` may be called once per page and its promise reused; a
  rejected promise is retried on the next mount.
- The component sizes itself to its container: `.map-card__view`, 360 px
  high, full card width, `position: relative`, `overflow: hidden`.
- Props change on every batch (new `aircraft` / `trails` arrays and
  `dataClockMs`); `onViewportChange`, `onSelect` and `attribution` are new
  function / array identities on most renders. The component should not
  reset its camera on new props (only `initialView` at mount).
- `aircraft` is ordered newest fix first; `trails` by hex then ts, each
  trail ending at its aircraft's current fix.
- `attribution` is the data's credit then the basemap's; the component
  shows the lines it is given (the app does not add its own credit UI).
- `speed` is absent for live data and files; `playing` is false for
  files, a stopped feed and a hidden page.

## Numbers

Linux VM, 2 vCPUs, Node 22, native DuckDB 1.5.6, DuckDB-WASM 1.32.0.

| Measured | Value |
| --- | ---: |
| Aircraft on the map at 23:30:00 / 23:45:00.5 / 23:58:00 UTC (fixture), 90 s freshness | 187 / 171 / 186 (173 / 164 / 177 at 60 s; L0: median 169 in view) |
| Trail points at 23:58, 186 aircraft: 5-minute / 30-minute trails | 6,840 / 8,509 |
| `live-table.test.ts` / `map-queries.test.ts`, both drivers together (Vitest wall time, replay included) | 3.5 s / 4.9 s |
| `flights.spec.ts` in Chromium: `?sample=flights` to rows growing, 20+ aircraft, both charts drawn | 8.3 s |

## Unverified and known gaps

- **The real map component** came with the `l3-map` merge; in
  `App.map.test.tsx` it is still replaced by a recording stand-in, and the
  real one is covered by its own tests and the E2E.
- **The grid resets to the top on every batch** of the live table (a new
  data version is a new grid view). Keeping the scroll position across
  batches needs the grid source to refresh pages in place: later.
- **Charts re-query every batch** (2 s in the sample). Each is a scan of at
  most about 140,000 rows (a 60-minute window of the day fixture at 120x)
  and answers in milliseconds natively; on DuckDB-WASM it was not measured
  beyond the E2E run.
- **Live data in the browser** (`?live=1`) is tested only up to the feed's
  start: there is no relay in the test environment (L2). Against the E2E
  server (which answers `/api/flights` with 404) the card shows "Retrying
  in 16 s · HTTP 404", counting down, and the top bar "0 rows · Retrying";
  the grid still says "The file has no rows".
- **`pnpm lint`** passed, but one run on this VM died with a V8 heap
  out-of-memory at the default heap (about 2 GB); the next passed in 1 min
  50 s. The unmodified branch also needs close to that limit (it passed in
  1 min 36 s, and its in-process peak was 2.9 GB with a larger heap).

## Tests

Totals after this branch: core 373, engine 341 passed and 16 skipped (both
projects), app 80, web 42, desktop 91, ui 229, datasets 24; web E2E 9
(Chromium). After the merge with `l3-map` and the review fixes: core 373,
engine 343 and 16 skipped, app 86, web 43, desktop 91, ui 275, datasets
40; web E2E 12 and 1 skipped (Chromium, also under
`GLASSGRID_BASE=/glassgrid/`). Gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm e2e:web` and `node scripts/third-party-notices.js --check` pass.

| Suite | What |
| --- | --- |
| `core/src/sql/map.test.ts` (8, 3 snapshots) | Spec defaults and bounds; latest query (window, QUALIFY, filters after it, limit) and its params; columns named by the spec, absent attributes null, `TRY_CAST`; the 90 s window, from 0 at an earlier clock; errors with paths (unknown column, types, clock); trails (window, bucket, semi-join, order, cap); bucket sizes; no trail |
| `core/src/commands/map-commands.test.ts` (6) | Tier, MCP, JSON Schema; add with defaults and a card, undo/redo by patches; full spec, title, compiler errors with paths, strict input; no file, no flight columns, the limit; update (trail, filters, title, undo, errors); remove, undo, `openFile` clears |
| `core/src/protocol/engine.test.ts` (+2) | The `map` request (view scoped, validated spec and clock, no SQL); the reserved live handle |
| `core/src/commands/workspace-commands.test.ts` (+1) | `loadWorkspace` restores maps; a map change is unsaved work; undo |
| `core/test/workspace-file.fixtures.test.ts` (11) | A fixture per version 0 to 2; v1-full migrates (only version and maps differ); v2-flights byte for byte, restore, a dropped map; v0 → v1 → v2; future-v3 refused |
| `core/test/workspace-file.property.test.ts` (2 × 300) | Random workspaces now include map views: round trip and restore |
| `engine/src/live/live-table.test.ts` (4, native and wasm) | Opening the live table (types, fingerprint, row count; `unknown_table` before a feed); **per-batch invalidation of results, cubes, sort indexes and the profile, before the batch is reported**; a new source is a new table, closing keeps the rows; `open` and `map` through the protocol |
| `engine/src/live/map-queries.test.ts` (8, native and wasm) | **On the replayed fixture**: the latest query at three clocks against independent SQL (count, newest fix, values); **every 61–89 s gap between an aircraft's fixes (the first 40) keeps it on the map at its earlier fix, and an aircraft that stopped reporting is there 89 s after its last fix and gone at 90 s** (fails at 60 s); filters on the latest fix, trails at 5 and 30 minutes against an independent bucket count (order, window, marker), an empty early clock, the clock in the cache key |
| `app/src/App.map.test.tsx` (11) | **The stub component's props after a batch** (aircraft, trails, clock, playing, speed, both credits, theme, assets base, initial view); the flights workspace opens over the live table; stale replies dropped; selection is UI state, the viewport filters nothing; filters re-query; + Map, Remove, Undo; no basemap. Review fixes: **a component that throws in its cleanup on Remove leaves the app running** (the list boundary), one that throws while rendering shows the card's fallback and restarts; the altitude key in the card; the top bar's rows and feed state (no size); the status line through connecting, backoff (countdown, error, polite region that does not tick), live, stale, stopped; the same empty arrays before the first snapshot; the selection cleared when no map has the aircraft and on a workspace change |
| `apps/web/src/flights.test.ts` (4) | The links; the basemap under the base; the flights sample starts the replay and loads the workspace; a feed that cannot start |
| `apps/web/e2e/flights.spec.ts` (2, Chromium) | `?sample=flights` on the production build: rows grow batch after batch, aircraft on the map, the status line, the altitude key and the top bar's rows, both charts drawn, no problems; **Remove the map card (the app stays, no page error), Undo (the map is back and `ready`, with aircraft), Ctrl+Z of the workspace (the start screen), Redo, then open a CSV (the map goes)**, no problems |

## Reproduce

```sh
pnpm --filter @glassgrid/core test
pnpm --filter @glassgrid/engine exec vitest run src/live/live-table.test.ts src/live/map-queries.test.ts   # both drivers
pnpm --filter @glassgrid/app test
pnpm e2e:web                                                                                              # includes flights.spec.ts
```
