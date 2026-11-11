# Live flights L3: the map view

Branch `l3-map`, dated 2026-11-10. Milestone L3 of the live-flights
feature, map side: a MapLibre GL JS map over a self-hosted Bay Area
basemap, with the aircraft and their trails drawn in a custom WebGL layer
and moved between fixes by dead reckoning. It builds on
[L0](live-flights-l0.md) (the flight schema and fixtures) and
[L2](live-flights-l2.md) (the feed in the engine). The data and app side
(queries, the view in `@glassgrid/app`) is built in parallel on another
branch and uses the component through the contract below; until then the
map runs on a test page, `?map-demo`.

| Goal | Result |
| --- | --- |
| Map component | `@glassgrid/ui/map`: the contract's types and `loadMapView()`, which imports the component, MapLibre, its CSS and its worker as one lazy chunk (**293.0 kB gzip** JS, 10.3 kB CSS, 148.0 kB worker). |
| First load | `/` first-load JS **256.3 kB gzip** (255.8 kB before): +0.5 kB, from the new map and altitude design tokens. MapLibre is not in it. After the merge with `l3-data`: 262.0 kB; after the review fixes (the app's altitude key, status line and error boundaries): **264.4 kB**. |
| Basemap | Natural Earth 10m (land, lakes, urban areas, places) and OurAirports (13 airports, 30 runways), clipped to the flights box + 0.25°, pinned to commit SHAs: **137,052 bytes** in all, of which the GeoJSON is 56,224 (12.4 kB gzip) and the one glyph range 76,044. |
| CSP | **Unchanged.** MapLibre 6.16.0's worker is emitted by Vite as a same-origin module script and set with `setWorkerUrl`, so MapLibre never makes a `blob:` worker; its CSS goes through the bundler. The E2E loads the map under the production headers with no violation. |
| Aircraft | One custom layer (`CustomLayerInterface`): planes as signed-distance glyphs rotated by track, coloured by six altitude bands (tokens, CVD-checked), ground traffic as rings, the selection ringed and bigger, 5-minute fading trails. Click to select, Escape to clear. |
| Dead reckoning | Pure module with 15 unit and property tests: zero speed never moves, easing converges, positions stay finite, the 60 s cap holds. |
| Frame time | Headless Chromium on SwiftShader (software WebGL), 1280×800, 2 vCPUs shared with another build, 183 aircraft with trails while panning and zooming: frame interval p50 66.6 ms, **p95 66.8 ms**, against a target of 16.7 ms: **not met here**. The basemap alone has the same p95 (66.7 ms; p50 50.0); the aircraft layer's own CPU time is 0.2 / 0.7 ms (p50 / p95). At 640×400: p50 16.7, p95 33.4 ms. Needs a GPU to check. |

## The component contract

```ts
import { loadMapView, type MapViewProps } from '@glassgrid/ui/map';
const MapView = await loadMapView(); // a lazy chunk: MapLibre, its CSS and worker
<MapView {...props} />;
```

`packages/ui/src/map/types.ts` is the contract as agreed, unchanged:
`MapAircraft`, `MapTrailPoint`, `MapBounds`, `MapViewProps`. (L4 added one
optional prop, `selectedTrack`, below and in
[L4](live-flights-l4.md#selected-aircraft-track); everything else is as
it was.)
`packages/ui/src/map/index.ts` exports those types and `loadMapView()`
(memoised; a failed import can be retried), plus a few things that cost
nothing without MapLibre:

| Export | What |
| --- | --- |
| `AltitudeLegend` (`{ theme, className?, label? }`) | The colour key as a list: six bands (high first), "On the ground" (a ring), "Altitude unknown". Plain DOM and SVG; styled by `.gg-map-legend` in `styles.css`. The app's map card shows it over the map's top-left corner (`.map-card__legend`). |
| `altitudeLegend(theme)`, `ALTITUDE_BANDS`, `altitudeClass(ft, onGround)`, `altitudeFt(a)` | The same as data, for a legend of your own; the band rules. |
| `mapRenderStats()`, `resetMapRenderStats()` | Per-frame CPU time and counts of the aircraft layer (the benchmark reads them). |

How each prop is used:

| Prop | Behaviour |
| --- | --- |
| `aircraft` | One glyph per `hex` (a duplicate hex is ignored after the first). Barometric altitude, else geometric, picks the band; `onGround` draws a ring. Drawn ground first, then by altitude, so higher traffic is on top; the selected aircraft last. |
| `trails` | Only for aircraft in `aircraft`. Points older than `dataClockMs − 5 min` are dropped, the rest thinned to one per 8 s, or one per 2 s or more where the trail turns by over 10° (each trail keeps its last point), and a gap over 60 s breaks the line. Sorted input is used as is; unsorted input is sorted. A connector joins each trail's last point to the drawn aircraft. |
| `dataClockMs`, `playing`, `speed` | Dead reckoning (below). New rows restart the wall clock. `speed` defaults to 1; 0 stands still; negative or non-finite counts as 1. |
| `initialView` | Read at mount only. Default centre (−122.25, 37.62), zoom 8.6. The map cannot pan outside the basemap's bounds (zoom 7 to 16). Rotation and pitch are off. |
| `attribution` | Plain text (escaped), shown first in MapLibre's attribution control, then the basemap's own credits ("Natural Earth · OurAirports", linked). |
| `onViewportChange` | `{ west, south, east, north }`, 200 ms after a move ends (`moveend`, so after inertia too), and once after the map has loaded. |
| `onSelect` | A click within 14 px of a glyph centre selects the nearest (the topmost on a tie); a click elsewhere calls `onSelect(null)`, and so does Escape on the focused map while something is selected. |
| `selectedHex` | Controlled: the map shows what it is given. |
| `selectedTrack` (L4, optional) | The selected aircraft's whole track up to `dataClockMs` (`MapTrailPoint`s, ordered by ts; unsorted input is sorted). Only points whose `hex` is `selectedHex` are drawn: a solid, opaque line in `chart.selectionStroke`, 3.5 px wide (trails are 2 px and fade), above the trails and below the glyphs; thinned like trails (one point per 8 s, more in turns), at most the newest 5,000 points, broken where two fixes are more than 5 minutes apart. Absent or empty: no track. The root's `data-track` counts the points given for the selected aircraft. |
| `theme` | Paint properties change in place (no style reload), and the aircraft colours follow. The root carries `data-gg-theme`, so the tokens' CSS variables apply inside it. |
| `assetsBase` | Where `apps/web/public/map/` is served, e.g. `withBase('map/')` (`/glassgrid/map/` under the portfolio). Resolved against the page; anything on another origin is refused (the map shows a message), as the CSP's `connect-src 'self'` would. |

Layout and states: the component fills its parent (`width` and `height`
100%, at least 200 px), so the parent needs a height. Its root has
`data-testid="map-view"`, `data-state` `loading | ready | error` and
`data-aircraft`. Errors (no `basemap.json`, no WebGL) show a short message
in the map and a `[glassgrid] map:` warning; when only the aircraft layer
fails (no WebGL2), the basemap still draws.

Teardown: on unmount (or a new `assetsBase`) the map effect's cleanup
calls `map.remove()`, which itself calls `onRemove` on every control (the
attribution) and, through `setStyle(null)`, on the aircraft layer, and
takes MapLibre's listeners, `ResizeObserver`, worker and WebGL context with
it. After that MapLibre allows no other call: a second `removeControl`
throws (`AttributionControl.onRemove` reads its cleared `_map`), and so
does `addLayer`. React runs the map effect's cleanup before the other
effects' cleanups, and in the render that swaps the map an effect can run
once more with the old one, so MapView records every map it removed
(`usable(map)`, a `WeakSet`) and every other effect checks it first: the
attribution cleanup (also `hasControl`), the repaints on new rows, playback
and selection, the theme's paint properties, the canvas label and the
animation loop (its `tick` and `start`). The Escape listener on the canvas
is removed before the map; the hover frame and the viewport timer are
cancelled and check `cancelled`. Nothing removes layers or sources by hand.
Before this fix (found in the integration review) every unmount threw a
`TypeError` from the attribution cleanup and React unmounted the app's
root: the map card's Remove, undoing the flights workspace and opening a
file over it all left a blank page.

Keyboard and screen readers: MapLibre's canvas is focusable
(`tabindex="0"`, `role="region"`); its `aria-label` is replaced with
"Live flights map, 183 aircraft[, UAL123 selected]. Arrow keys pan, plus
and minus zoom." MapLibre's keyboard handler pans and zooms. The ARIA
table of aircraft is L5.

## Files

| File | What |
| --- | --- |
| `packages/ui/src/map/types.ts` | The contract |
| `packages/ui/src/map/index.ts` | `@glassgrid/ui/map` (new `exports` entry `./map`) |
| `packages/ui/src/map/MapView.tsx`, `map.css` | The component (the lazy chunk): MapLibre, worker URL, events, attribution, the animation loop |
| `packages/ui/src/map/aircraft-layer.ts` | The custom WebGL2 layer: shaders, buffers, draws |
| `packages/ui/src/map/scene.ts` | The layer's state without WebGL: fixes, ease offsets, the clock, trail thinning, vertex data |
| `packages/ui/src/map/dead-reckoning.ts` | Extrapolation, the playback clock, easing (pure) |
| `packages/ui/src/map/altitude.ts`, `AltitudeLegend.tsx` | Bands, palettes, the legend |
| `packages/ui/src/map/basemap.ts`, `style.ts` | The basemap descriptor and the MapLibre style built from it |
| `packages/ui/src/map/mercator.ts`, `hit.ts`, `stats.ts` | Web Mercator and the relative-to-origin matrix; picking; benchmark counters |
| `packages/ui/tokens/build-tokens.js` (+ generated files) | New tokens `chart.altitude.1–6`, `chart.altitude-ground`, `chart.altitude-unknown`, `chart.aircraft-outline`, `map.*`, with contrast and colour-vision checks |
| `tools/datasets/src/basemap.ts`, `src/lib/basemap.ts` | `pnpm --filter @glassgrid/datasets basemap` |
| `apps/web/public/map/` | The basemap, its descriptor, glyphs, `OFL.txt` and manifest |
| `apps/web/src/map-demo/` | `?map-demo`: the test page on synthetic traffic |
| `apps/web/e2e/map.spec.ts`, `map-perf.spec.ts`, `map-support.ts` | The E2E and the benchmark |
| `apps/web/hosting.ts`, `vercel.json` | Content types for `map/*.geojson` and `map/*.pbf` |
| `apps/web/scripts/size.ts` | Also reports the lazy map chunk |
| `apps/web/src/main.tsx`, `routes.ts` (+ `routes.test.ts`) | The `?map-demo` route (its own lazy chunk) |
| `apps/web/playwright.config.ts`, `e2e/serve.ts`, `package.json` | `GLASSGRID_E2E_PORT`; content types for the map files; the `e2e:map-perf` script |
| `packages/ui/src/styles.css` | `.gg-map-legend` |
| `tools/datasets/src/lib/download.ts` | Content-Length checked only for uncompressed responses |
| `scripts/third-party-notices.js`, `THIRD_PARTY_NOTICES.md` | Rows for the basemap and the glyphs, MapLibre under "Bundled at build time", the new packages |
| `package.json` (root) | `lint` with a 4 GB heap (see Tests and gates) |
| `docs/benchmarks/l3/` | The benchmark JSON |

Dependencies (exact versions, as the repo pins them):

| Package | Version | Where | Licence |
| --- | --- | --- | --- |
| `maplibre-gl` | 6.16.0 (published 2026-10-25; 6.17.0 was three days old) | `@glassgrid/ui` dependencies | BSD-3-Clause |
| `@maplibre/maplibre-gl-style-spec` | 26.6.0 (the version maplibre-gl resolves to) | `@glassgrid/ui` devDependencies: `style.test.ts` validates the style | ISC |
| `fast-check` | 4.10.2 (as core) | `@glassgrid/ui` devDependencies | MIT |

MapLibre brings 24 transitive packages (MIT, ISC, BSD-2/3, one
MIT-or-Apache-2.0); `THIRD_PARTY_NOTICES.md` lists them all and
`node scripts/third-party-notices.js --check` passes.

## Basemap

`pnpm --filter @glassgrid/datasets basemap` (add `-- --latest` to resolve
each repository's HEAD with `git ls-remote` first). Every input is a raw
file at a pinned commit; the manifest (`basemap.manifest.json`) records
each URL, size and SHA-256, and the outputs' sizes and SHA-256. Two runs
gave identical bytes; a rerun refuses an input whose hash differs from the
manifest's.

| Source | Commit | Files (SHA-256 prefix) | Licence |
| --- | --- | --- | --- |
| [nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector) | `ca96624a56bd078437bca8184e78163e5039ad19` | `geojson/ne_10m_land` (`1ac90796`), `_minor_islands` (`8c933ca7`), `_lakes` (`2d036f53`), `_lakes_north_america` (`76f49d4b`), `_urban_areas` (`5136ffd8`), `_populated_places_simple` (`fd3fa867`) | Public domain |
| [davidmegginson/ourairports-data](https://github.com/davidmegginson/ourairports-data) | `480cb340247e7dfd6c22e31d309895ef003e3d80` | `airports.csv` (`b311ab03`), `runways.csv` (`bb0e928b`) | Public domain |
| [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets) | `028c18f713baecad011301ff7a69acc39bcc2ae7` | `fonts/Noto Sans Regular/0-255.pbf` (`62c6d49b`), `fonts/OFL.txt` (`7713cfc8`) | SIL OFL 1.1 |

What the tool does:

- **Area.** `BAY_AREA_BBOX` (37.0–38.5° N, 123.0–121.5° W) plus 0.25° on
  every side: [−123.25, 36.75, −121.25, 38.75].
- **Polygons** (land with minor islands, lakes, urban areas): clipped to
  the area (Sutherland–Hodgman per ring), Douglas–Peucker at 0.0002°
  (about 20 m, below Natural Earth 10m's own detail), rounded to 5 decimals
  (about 1 m), slivers under about 100 m × 100 m dropped. Holes go with
  their outer ring.
- **Places:** Natural Earth's populated places in the area (10, San
  Francisco to Stockton), biggest first so label collision keeps them.
- **Airports:** OurAirports' `large_airport` and `medium_airport` in the
  area: 13. Large: SFO, OAK, SJC and, at the north-east corner, SMF;
  medium: San Carlos (KSQL), Palo Alto, Moffett, Buchanan (Concord), Santa
  Rosa, Travis, and Sacramento's Executive, Mather and McClellan.
- **Runways:** their open runways (SJC's closed 11/29 is left out), 30,
  each as a rectangle from both runway ends and `width_ft` and as a
  centreline. The style draws the centrelines (0.75 px at z8 to 5 px at
  z13) below z13 and the rectangles from z12, so runways are visible at
  every zoom: SFO's four, OAK's four, SJC's two and KSQL's 12/30 are
  checked by `basemap-fixture.test.ts`.
- **Glyphs:** only the 256-codepoint ranges the labels use; every label is
  Latin-1, so one range, `0-255`.
- **Outputs** (`apps/web/public/map/`): `basemap.geojson` (one feature per
  line, a `layer` property per feature), `basemap.json` (the descriptor),
  `fonts/Noto Sans Regular/0-255.pbf`, `fonts/OFL.txt`,
  `basemap.manifest.json`.

| File | Bytes |
| --- | ---: |
| `basemap.geojson` (land 5, water 1, urban 24, place 10, runway 30, runway-line 30, airport 13 features) | 56,224 (12,402 gzip) |
| `basemap.json` | 410 |
| `fonts/Noto Sans Regular/0-255.pbf` | 76,044 |
| `fonts/OFL.txt` | 4,374 |
| **Total** (plus the 6,674-byte manifest, which the page never loads) | **137,052** |

`fetchCached` (tools/datasets) compared Content-Length with the decoded
body, which fails on GitHub's gzip responses; it now checks the length
only for uncompressed bodies.

### The style

`style.ts` builds the style at runtime from `basemap.json` and the theme's
tokens (`map.land`, `map.water`, `map.urban`, `map.runway`, `map.label`,
`map.label-halo`); every URL in it is absolute and under `assetsBase`
(tested, and validated with MapLibre's style-spec validator). Layers:
background (water), land, urban areas, lakes, runway centrelines, runway
rectangles, airport dots (below z10), place labels, airport labels (the
IATA code, plus the name from z11), then the aircraft layer on top.

The style module is written for a vector basemap too: `basemap.json` with
`kind: "vector"` names a tile source (`tiles`: a TileJSON URL, or
`pmtiles://<file>`), maps each logical layer (land, water, urban, place)
to a source layer and an optional filter, and keeps airports and runways
in a GeoJSON `overlay` in the same format. That path is unit-tested (a
valid style, `source-layer`s, the overlay) but not run in a browser.

### Replacing the basemap with OpenStreetMap (PMTiles)

Natural Earth 10m is a 1:10 million dataset: its shoreline is generalised
by hundreds of metres to a kilometre or more (San Carlos's runway, on the
bay's edge, draws well inland; SFO's runway ends on fill are drawn on
plain land), and it has no roads. A real OpenStreetMap extract fixes that. It needs
`build.protomaps.com`, which this environment cannot reach, so it is not
done here. On a machine that can:

```sh
# go-pmtiles: https://github.com/protomaps/go-pmtiles/releases (or `brew install pmtiles`)
pmtiles extract https://build.protomaps.com/20261109.pmtiles apps/web/public/map/bay-area.pmtiles \
  --bbox=-123.25,36.75,-121.25,38.75 --maxzoom=14
pmtiles show apps/web/public/map/bay-area.pmtiles   # check layers, zooms, size (expect tens of MB at z14; --maxzoom=12 is smaller)
```

Then:

1. Add the `pmtiles` npm package (BSD-3-Clause) and register its protocol
   in `MapView.tsx` before the map is created
   (`addProtocol('pmtiles', new Protocol().tile)`); it reads the archive
   with HTTP Range requests on the same origin (`connect-src 'self'`
   allows it; `e2e/serve.ts` and Vercel serve Range).
2. Write `basemap.json` as `kind: "vector"`: `tiles:
   "pmtiles://bay-area.pmtiles"`, `overlay: "basemap.geojson"` (keep the
   airports and runways), and layers for the Protomaps schema, e.g.
   `land: { sourceLayer: "earth" }`, `water: { sourceLayer: "water" }`,
   `urban: { sourceLayer: "landuse", filter: [...] }`, `place:
   { sourceLayer: "places", filter: ["==", ["get", "kind"], "locality"] }`.
3. Credit OpenStreetMap: add `{ "text": "© OpenStreetMap contributors",
   "url": "https://www.openstreetmap.org/copyright" }` to `credits` (the
   map shows it in the attribution control), a row in
   `THIRD_PARTY_NOTICES.md` (ODbL 1.0), and a notice next to the file, as
   for the flight fixtures.
4. Serve `*.pmtiles` with `Content-Type: application/vnd.pmtiles` and a
   versioned file name (it can then be cached as immutable), in
   `hosting.ts`.

## CSP

The policy is unchanged:
`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'`
(plus `font-src`, `object-src`, `base-uri`, `form-action`,
`frame-ancestors`, as before).

- **What MapLibre 6.16.0 ships.** `dist/` holds `maplibre-gl.mjs`
  (the main bundle), `maplibre-gl-worker.mjs` (the worker, a separate ES
  module), their `-dev` variants and `maplibre-gl.css`. There is no
  separate CSP build in this version, and its README says nothing about
  CSP; the answer is in the code (`src/util/web_worker.ts`,
  `workerFactory`): the worker URL is `setWorkerUrl(url)`, else
  `maplibre-gl-worker.mjs` next to `import.meta.url`. A same-origin URL is
  started with `new Worker(url, { type: 'module' })` (a `.cjs` URL as a
  classic worker); only a cross-origin one is wrapped in a `blob:` module
  (`import "<url>"`), which `worker-src 'self'` would refuse.
- **What we do.** `MapView.tsx` imports
  `maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url`: Vite bundles it as
  an ES module worker (`worker.format: 'es'`, already set) and emits
  `assets/maplibre-gl-worker-<hash>.js` (519 kB, 148 kB gzip); the import
  is its URL, passed to `setWorkerUrl` before any map exists. Without it,
  the bundled `import.meta.url` would point MapLibre at a file next to the
  chunk that does not exist.
- **The worker's own policy.** It is a same-origin script served with
  the header CSP, so its fetches (the GeoJSON) are under `connect-src
  'self'` too.
- **`eval` in the worker** is only in `importScriptInWorkers`, for plugin
  scripts (`src/source/worker.ts`, `loadScript`: `eval` for classic
  scripts, a `blob:` import for ESM fetched from a non-`.mjs` URL), which
  we never call.
- **CSS.** `import 'maplibre-gl/dist/maplibre-gl.css'` and `map.css` go
  into the lazy chunk's stylesheet (`assets/MapView-<hash>.css`, 72 kB,
  10 kB gzip), which Vite links when the chunk loads (`style-src 'self'`).
  Its control icons are `data:` SVGs (`img-src 'self' data:` already
  allows them). MapLibre positions elements through `element.style`
  (CSSOM), which `style-src` does not restrict.
- **Everything same-origin.** Basemap, descriptor, glyphs and the worker
  come from `assetsBase`; there are no remote tiles, sprites or fonts.
- **Proof.** `apps/web/e2e/map.spec.ts` loads `?map-demo` on the
  production build served with the production headers and fails on any
  CSP violation, console error, failed request or `[glassgrid]` warning
  (`support.ts`). It also checks that the worker is the emitted file on
  the page's origin and never a `blob:`, that every request is
  same-origin, and that the canvas shows land, water and aircraft of
  several altitude bands (pixel counts of the token colours in a
  screenshot), in both themes. It passes at the root and under
  `GLASSGRID_BASE=/glassgrid/`.

`hosting.ts` now types `map/*.geojson` as `application/geo+json` and
`map/*.pbf` as `application/x-protobuf` (`vercel.json` regenerated).

## Aircraft layer

`AircraftLayer` implements MapLibre's `CustomLayerInterface` (2D mode) and
draws into MapLibre's WebGL2 context after the labels:

- **Positions** are computed on the CPU every frame (dead reckoning,
  below), converted to Web Mercator and written relative to a fixed origin
  at (−122.25, 37.75). The layer folds that origin into MapLibre's
  `defaultProjectionData.mainMatrix` in float64 (`relativeMatrix`), so the
  float32 vertices keep sub-pixel precision at every zoom.
- **Glyphs:** one indexed draw, 4 vertices per aircraft (position, corner,
  angle, radius, kind, RGBA8: 32 bytes). The vertex shader rotates each
  quad by `track − bearing`; the fragment shader draws a plane as the
  union of signed distance fields (a capsule fuselage, swept wings, a
  tail) with a 1.1 px outline in `chart.aircraft-outline`, or a ring for
  ground traffic. The selected aircraft is 14 px instead of 11 and has a
  ring in `chart.selectionStroke`. Not colour alone: ground traffic differs
  by shape, the selection by size and ring.
- **Trails:** one indexed draw of screen-space extruded quads (2 CSS px
  wide, anti-aliased), coloured by each point's altitude band and fading
  linearly to nothing at 5 minutes of age. The fade is computed in the
  vertex shader from a `u_now` uniform, so the trail buffer is uploaded
  only when rows, the selection or the theme change; the connectors to the
  aircraft (one segment each) are uploaded every frame.
- **Not instanced:** plain indexed draws, because the chart overlay
  measured instanced draws at about 17 µs per instance on SwiftShader
  (`docs/m3-charts.md`), and the vertex counts are small (183 aircraft,
  about 6,900 trail segments after thinning).
- **Repo helpers:** colours parse with `charts/colors.ts` (`parseColor`)
  from `tokensFor(theme)`; the shader compile/link and failure handling
  follow `charts/webgl/scatter.ts`. The chart overlay manager itself is not
  used: MapLibre owns the context, the viewport and the frame.
- **Picking** is on the CPU: on click, each drawn position goes through
  `map.project`, and the nearest within 14 px wins (`hit.ts`). The cursor
  becomes a pointer over an aircraft.
- **Failure:** no WebGL2, or a shader that does not compile, disables the
  layer once with a message and a warning; the basemap keeps working.
- **The symbol-layer fallback** was not needed.

### Altitude colours

Six bands: below 1,000 ft, 1,000–4,999, 5,000–9,999, 10,000–19,999,
20,000–29,999, and 30,000 ft and above; barometric altitude, else
geometric. The ramp is plasma-like (orange to indigo in light, yellow to
purple in dark), with lightness monotonic in altitude so the order reads
under every colour-vision type. They are design tokens
(`--gg-chart-alt-1…6`, `chart.altitude` in the resolved JSON), and
`tokens/checks.json` records, per theme, each band's contrast on map land
and water and the smallest CIEDE2000 distance between neighbouring bands:

| | normal | protan | deutan | tritan |
| --- | ---: | ---: | ---: | ---: |
| light, min ΔE00 between neighbours | 11.4 | 5.3 | 10.0 | 9.4 |
| dark | 14.5 | 11.1 | 7.6 | 9.3 |

Contrast against the basemap ranges from 1.3:1 (the lowest band on light
water) to 12:1, which is why every glyph has an outline (11.7:1 or more
against land and water in both themes, a recorded check). Runways have
6.2:1 against land.

## Dead reckoning

`dead-reckoning.ts`, pure. For a fix (lat, lon, ground speed `gs` kt,
track `θ`, time `ts`) shown at wall time `now`:

```
wall      = carried + (now − receivedAt) × speed        while playing (carried: what accumulated before a pause or speed change)
          = carried                                     while paused
elapsed   = clamp((dataClockMs − ts) + wall, 0, 60 s)
d         = gs × 1852/3600 × elapsed / 1000             metres
lat'      = lat + (d cos θ / R) × 180/π
lon'      = lon + (d sin θ / (R cos lat)) × 180/π       R = 6,371,008.8 m
```

- **No extrapolation** on the ground, without a ground speed, without a
  track, or for a negative or non-finite speed; the fix is drawn as it
  is.
- **The flat-earth step** is accurate to under a metre over the 60 s cap
  (18.5 km at 600 kt).
- **The cap is on the fix's age, in data time**: a fix more than 60 s
  older than the data clock is drawn at its 60 s position, never beyond.
- **New rows** (`setData`) restart the wall clock (`receivedAt = now`),
  keeping play state and speed. For each aircraft that was drawn, the
  offset `drawn(now) − target(now)` (latitude, longitude, and track the
  short way round) is added back with weight `1 − easeOutCubic((t −
  now) / 1 s)`, so the glyph starts where it was and arrives on its
  extrapolated path after 1 s. An offset over 5 km snaps (a new leg, a bad
  fix); new aircraft just appear.
- **The rAF loop** runs while playing (speed > 0) and the tab is visible,
  calling `map.triggerRepaint()` each frame. It also runs for the at most
  1 s an ease needs after new rows arrive while paused; otherwise a paused
  map renders only when MapLibre does (input, loading). It stops on
  `visibilitychange` to hidden and resumes when visible. The E2E checks
  that a paused, idle map draws no frames over a second, and that Play
  starts them again.

Property tests (fast-check) in `dead-reckoning.test.ts`: zero ground speed
never moves (any fix, any elapsed time); positions are finite for any
inputs, NaN and ±∞ included; the distance moved is at most 60 s at the
ground speed, and beyond 60 s it is exactly the 60 s position; the clock
never runs backwards; easing converges monotonically and lands exactly on
the target after 1 s, starting from the drawn position; `angleDelta` stays
in (−180, 180]. `scene.test.ts` adds that every vertex the scene writes is
finite for arbitrary rows and trails.

## Numbers

### Bundle

`pnpm --filter @glassgrid/web size` (gzip level 9; kB = 1,000 bytes):

| | Raw | Gzip |
| --- | ---: | ---: |
| `/` first-load JS (budget 400 kB) | 864.1 kB | **256.3 kB** (was 255.8 kB) |
| `/` first-load JS after the merge with `l3-data` / after the review fixes | 881.1 / 887.8 kB | 262.0 / **264.4 kB** |
| Map chunk JS (`MapView-*.js`: MapLibre and the component) | 1,082.2 kB | **293.0 kB** (293.1 kB after the review fixes) |
| Map chunk CSS (MapLibre's and `map.css`) | 72.2 kB | 10.3 kB |
| MapLibre worker (`maplibre-gl-worker-*.js`) | 519.3 kB | 148.0 kB |
| Basemap fetched on first map view | 137 kB | about 59 kB (GeoJSON 12.4 kB, glyphs 45.9 kB) |

The 0.5 kB first-load growth is the new tokens in the resolved theme JSON
the entry already imports. `size.ts` now lists the lazy map chunk
separately.

### Frame times

`pnpm --filter @glassgrid/web e2e:map-perf` (`apps/web/e2e/map-perf.spec.ts`;
JSON: [benchmarks/l3/map-perf-chromium-linux-x64.json](benchmarks/l3/map-perf-chromium-linux-x64.json)):
the production build with the production headers, `?map-demo` at
1280×800, DPR 1; after a 1.5 s warm-up, about 10 s of scripted input per
run (4 wheel zooms of 6–12 ticks, 5 mouse drags at 60 moves a second);
rAF intervals and the aircraft layer's per-frame CPU time; 3 runs per
scenario, samples pooled.

Conditions: a Linux VM with 2 vCPUs (Xeon @ 2.1 GHz) and 8 GB; Chromium
153.0.8010.12 headless; WebGL is ANGLE on SwiftShader (Vulkan, software:
no GPU); another agent's builds and tests were running on the same VM
(load average 1.6 to 2.2 during the run). rAF intervals on this machine
come in steps of 16.7 ms.

| Scenario | Frame interval p50 / p95 / max (ms) | Frames | Aircraft layer CPU p50 / p95 (ms) |
| --- | --- | ---: | --- |
| 183 aircraft, trails (6,859 segments), playing | 66.6 / 66.8 / 100.1 | 650 | 0.2 / 0.7 |
| 183 aircraft, no trails, playing | 50.0 / 66.7 / 100.0 | 708 | 0.1 / 0.5 |
| Basemap only (one stationary aircraft, paused) | 50.0 / 66.7 / 100.0 | 862 | 0.1 / 0.3 |
| 640×400, 183 aircraft with trails (2 runs) | 16.7 / 33.4 / 50.0 | 1,086 | 0.1 / 0.4 |
| 640×400, basemap only (2 runs) | 16.7 / 16.8 / 50.0 | 1,270 | 0.0 / 0.1 |

- **The 16.7 ms p95 target is not met on this machine**, and the
  aircraft are not why: the basemap alone, paused, with one aircraft, runs
  at the same frame rate. Every frame is rasterized by SwiftShader (no
  GPU) on two vCPUs that another build was using at the same time (load
  average 1.6 to 2.2). The aircraft layer's JavaScript and GL calls take
  0.2 ms at the median and 0.7 ms at p95. The glyphs add nothing
  measurable; the trails cost one 16.7 ms step at the median (66.6 against
  50.0 ms), which is SwiftShader rasterizing their quads.
- **Trail thinning was set by this benchmark.** With one point per 4 s
  (13,631 segments) the trails scenario measured p50 66.6 / p95 83.3 ms;
  one per 8 s (6,859 segments) brought p95 to 66.8 ms. Turns keep extra
  points (every 2 s or more past 10°), so curves stay round at high zoom.
- **Needs a GPU to check** (the macOS CI runners, as for the 1M-point
  scatter in M3).
- **Fill rate:** at 640×400 (a quarter of the pixels) the basemap meets
  the target (p95 16.8 ms) and the full scenario is at p50 16.7 / p95
  33.4 ms: the cost follows the pixel count, as software rasterization
  does. JSON for that run:
  [benchmarks/l3/map-perf-chromium-linux-x64-640x400.json](benchmarks/l3/map-perf-chromium-linux-x64-640x400.json).

## Tests and gates

| Suite | Count | New here |
| --- | ---: | --- |
| `packages/ui` (Vitest) | 275 | 46 in `src/map/`: dead reckoning (15, 6 of them fast-check properties); scene, Mercator, altitude, picking (11, 2 properties); style and descriptor (8); MapView's wiring against a fake MapLibre: fetch, style, layer, labels, selection, viewport debounce, credits, theme, origin check, unmount (10); the entry's import boundary and `loadMapView` (2) |
| `tools/datasets` | 40 | 16: clipping, simplification, runway rectangles, CSV, glyph ranges (11, 2 properties); the committed basemap against its manifest (5) |
| `apps/web` (Vitest) | 39 | 1 (the `?map-demo` route); `hosting.test.ts` covers the new map types |
| `apps/web` E2E | 10 + 1 skipped (12 + 1 after the merge and the review fixes) | 2 in `map.spec.ts`; `map-perf.spec.ts` runs only with `GLASSGRID_E2E_MAP_PERF=1`; `flights.spec.ts` removes the map card, undoes it and the workspace, and opens a CSV over it |

**The fake MapLibre** (`MapView.test.tsx`) behaves as 6.16 does where
MapView depends on it: `addControl` calls the control's `onAdd`;
`remove()` calls `onRemove` on every control and layer and clears them;
after it, every method MapView uses throws (and is recorded in
`callsAfterRemove`) except `hasControl`; `removeControl` calls `onRemove`
even for a removed control; the fake `AttributionControl.onRemove` reads
`this._map.off`, as the real one does. With it, every test that unmounts
failed on the old cleanup. Two tests were added: unmounting a playing map
with its control and layer (nothing throws, no call after `remove()`, the
control's `_map` cleared, no stray frame or timer within 50 ms), and a new
`assetsBase` in the same render as new rows, theme and credits (the old map
is never called after its removal; the new one gets one attribution
control).

Gates on this branch: `pnpm lint`, `pnpm typecheck`, `pnpm test` (all
packages), `pnpm e2e:web` (also with `GLASSGRID_BASE=/glassgrid/`),
`pnpm --filter @glassgrid/web size` and
`node scripts/third-party-notices.js --check` pass.

- **`pnpm lint` ran out of memory.** ESLint's typed lint (the TypeScript
  project service over every package's tsconfig) peaked at about 2,030 MB
  of heap without this branch's map code, against Node's default limit of
  about 2,096 MB; the map code (MapLibre's 756 kB of type declarations
  among it) pushed it over. The root `lint`
  script now runs ESLint with `--max-old-space-size=4096`.
- **`GLASSGRID_E2E_PORT`** (playwright.config.ts) picks another port than
  4173 for the web E2E server, for two checkouts testing at once.

## Integration notes for the app

- Import from `@glassgrid/ui/map`, not `@glassgrid/ui`: the root entry
  does not re-export the map.
- Call `loadMapView()` when the map view is first wanted (or on intent,
  as the engine starts), and render a placeholder until it resolves.
- Pass `assetsBase={withBase('map/')}` in the web shell. The desktop shell
  would need the folder copied into its renderer's assets and its own CSP
  to allow the worker (`worker-src 'self'`): not done or tested here.
- Keep `aircraft` and `trails` referentially stable between queries: each
  new array is "new rows" (a restart of the wall clock and an ease).
- `attribution` is text; put adsb.lol's credit there (e.g. core's
  `ADSBLOL_ATTRIBUTION`).
- Show `AltitudeLegend` with the map (the app's card does, top-left, clear
  of the attribution), and keep the map under an error boundary: the
  component is third-party WebGL in a lazy chunk.

## Unverified and deferred

- **An OpenStreetMap basemap** (PMTiles), blocked here; the steps are
  above.
- **Frame time on a GPU**, and Firefox and Safari: only headless Chromium
  with SwiftShader was available.
- **Globe projection:** the layer uses the Mercator main matrix; the map
  never switches projection, but a globe would need `projectTile` in the
  shaders.
- **WebGL1:** the layer needs WebGL2 and otherwise disables itself (the
  basemap still draws).
- **Touch:** pinch and drag work through MapLibre; tapping an aircraft
  uses the same 14 px radius and was not tested on a device.
- **Label density:** at low zoom, ground rings at an airport overlap
  their label; airport labels collide only with each other.
- **The ARIA aircraft table** is L5.
