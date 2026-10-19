# M3 notes: chart layer (`m3-charts`)

The chart renderers for M3, in `@glassgrid/ui` (`packages/ui/src/charts`),
dated 2026-10-18. Cross-filtering state (`FilterStore`, commands) is built
on the parallel `m3-xfilter` branch; this branch only renders and reports
selections. Nothing here imports Electron or Node.

## Components

| Component | Result columns (Arrow, per [m1-compiler.md](m1-compiler.md)) | Selection |
| --- | --- | --- |
| `BarChart` (existing API kept) + `barDataFromArrow(table)` | `x, y` [+ `color`, `color_other`] | click / Enter toggles a category (`onToggle`) |
| `LineChart`, `AreaChart` (`LineChart mark="area"`) | `x, y` [+ colour]; M4 rows drawn as they are | 1-D x brush |
| `Histogram` | `x, x_end, y` [+ colour, stacked] | 1-D x brush, snapped to bin edges |
| `Heatmap` (also the scatter fallback) | `x, x_end, y, y_end, count` | 2-D brush, snapped on both axes |
| `ScatterChart` | `x, y` [+ colour] | 2-D brush |
| `ViewData` | any of the above | – |
| `WebGLOverlayProvider` | wraps the charts panel | – |

Shared props of the brushable marks (`ChartCommonProps`):

```ts
table: Table;                  // the aggregate result as Arrow
data?: ChartColumns;           // optional: chartColumnsFromArrow(table, mark), shared with ViewData
tokens: ResolvedTokens;        // tokensFor(theme)
label: string;                 // accessible name (card title)
xLabel, yLabel: string;        // shelf expressions: 'day(pickup_datetime)', 'count(*)'
colorLabel?: string;
height?: number;               // plot height, default 160
selection?: IntervalSelection | null;   // controlled: this chart's own selection
onBrush?: (selection: IntervalSelection | null, phase: 'move' | 'end') => void;
formatValue?: (n: number) => string;    // measures; default core's formatMeasure (see Number formatting)
colorKeys?: readonly string[];          // series keys in palette order (stable colours)
testId?: string;
```

`IntervalSelection` is data space: `{ x: [lo, hi], y?: [lo, hi] }`, ordered.
Bounds are numbers on numeric axes and ISO text on time axes
(`'2023-01-09'` at midnight, else `'2023-01-09 12:30:00[.fff]'`, UTC wall
clock), which `RangeFilter` accepts as is. Histogram and heatmap brushes are
snapped to bin edges by default (`snap={false}` turns it off) and are
half-open: `lo <= v < hi`, so the filter needs `maxInclusive: false`. Line,
area and scatter brushes are closed intervals. Incoming `selection` values
may also be epoch-ms numbers on time axes.

### Brush contract

- `move` fires while dragging, only when the brush changed. The overlay is
  already drawn on the next animation frame from the chart's own draft;
  nothing waits for props. Commit `move` to the store at most once per frame.
- `end` fires on release, on every keyboard change, on double-click or
  Escape (`null`), and on a click outside the brush (`null`).
- After `end` the chart keeps showing its draft until the `selection` prop
  changes (compared by value) or 1 s passes, so an asynchronous command
  round trip does not flicker and a rejected brush snaps back.
- Keyboard on the focused plot (`role="img"`, one tab stop): Enter/Space
  creates a brush in the middle fifth, arrows move it (one bin when
  snapped, else 2% of the axis), Shift+arrows resize its upper edge,
  Escape clears (unhandled, and so left to the page, when there is none).
  Up/Down only act on 2-D brushes. Changes are announced in a polite live
  region.

### What each chart renders

- Marks outside the selection are drawn at `chart.unselectedOpacity`, and
  the brush has an outline plus handles (bars at the 1-D edges, squares at
  the 2-D corners): never colour alone. Bars keep the outline + bold label.
- Hover tooltips show exact values from the result rows (line: every series
  at the nearest x; histogram: per series plus total; heatmap: both ranges
  and the count; scatter: both coordinates), titled at the time bucket's
  resolution (`Fri, Jan 20, 2023`), and flip at the chart's edges.
- Accessible name: summary (mark, fields, row count) plus the current
  selection; brush instructions via `aria-describedby`; a visually hidden
  `ViewData` table (first 300 rows) next to the image.
- Colour: series ranked like the compiler ranks them (largest total first,
  NULL after equal totals, Other last, neutral `chart.other`), palette in
  that order unless `colorKeys` pins slots. A legend lists the series.
  Heatmaps use the sequential ramp (sqrt by default) with a ramp legend.

## Arrow input

`chartColumnsFromArrow(table, mark)` returns typed arrays, one entry per
row, with no per-row objects: `x`, `y`, `xEnd`, `yEnd`, `count` as
`Float64Array` (NULL → NaN; DATE/TIMESTAMP of any unit → epoch ms; BIGINT
and DECIMAL → number), `series: Uint8Array` with `seriesList`, bar
`categories` (key = JSON of the filter value, label from the shared
formatter), and `order`/`seriesStart` (rows grouped by series, sorted by x
for line, area and histogram). Colour values are matched without decoding
strings (UTF-8 bytes, dictionary indices). Data-only preparation (bin
indexes, extents, colour buckets) is cached per `ChartColumns` object, so
pass the same object across renders; a new result is a new object.

## Rendering

- Canvas 2D on d3-scale / d3-shape, drawn at `devicePixelRatio`. Each chart
  caches its background (gridlines, axes, ticks) and marks as offscreen
  layers; a brush or hover frame is only a composite (blit, dimmed blit,
  clipped blit, brush strokes) on two stacked canvases.
- Line/area: sparse series are stroked with round joins. Dense series (at
  least one row per two CSS px, i.e. M4 output) fill the envelope of each
  device-pixel column (the min…max every segment covers there, plus half the
  line width), which is the pixel-faithful M4 picture and rasterizes in one
  polygon fill. NULL measures break the line; isolated points get a dot.
- Heatmap: regular bin grids draw as one nearest-neighbour-scaled bitmap
  (one pixel per cell); uneven grids (month bins) as rectangles batched by
  ramp step.
- Scatter up to 10,000 points (`webglThreshold`): splatted into `ImageData`
  with an anti-aliased disc mask. Above it, inside a `WebGLOverlayProvider`,
  points go to the panel's single WebGL2 canvas: one draw call, positions
  (float32 relative to an origin, so epoch-ms stay precise) and RGBA8
  colours in instance buffers, domain/brush/opacity as uniforms (a brush
  drag uploads nothing). On software renderers (SwiftShader, llvmpipe) the
  same buffers feed one non-instanced `POINTS` draw, because any instanced
  draw there costs ~17 µs per instance (`scatterStrategy` prop, `auto` by
  default). Without a provider, without WebGL2, after a failed shader or
  after context loss the scatter falls back to the canvas splat; on
  `webglcontextrestored` it moves back.
- The overlay canvas covers the provider's root (`position: absolute`,
  `z-index: 1`, no pointer events); each scatter's viewport and scissor
  come from its plot rectangle, clipped to the root, recomputed on scroll
  (captured), resize and every invalidation. Chart base canvases sit below
  it, brush/hover canvases (`z-index: 2`) and tooltips (`z-index: 10`) above.

## Integration checklist

1. Wrap the charts panel's scroll viewport (not the scrolling element
   itself) in `<WebGLOverlayProvider>`; one per window. Keep positioned
   elements with a z-index ≥ 1 (sticky headers) outside it or above 2.
2. Per chart card, adapt once: `const data = useMemo(() => chartColumnsFromArrow(table, mark), [table])`
   (or `barDataFromArrow(table)` for bars), and render the mark with
   `table`, `data`, `tokens`, the shelf expressions and `label`.
3. Selection: map the chart's own `FilterStore` entry to `selection`; on
   `onBrush(sel, 'move')` commit once per frame (rAF), on `'end'` dispatch
   the `brush` command (`null` → `clearFilter`). Build the range filter from
   `sel.x` (and `sel.y` on the y column for heatmap/scatter) with
   `maxInclusive: false` for histogram and heatmap.
4. "View data": `<ViewData data={data} mark={mark} label={...} xLabel yLabel colorLabel />`
   in `ChartCard`'s `viewData.table` (first 1,000 rows, with a caption when cut).
5. Scatter: when the engine answers a scatter spec with the heatmap
   fallback (`scatterAsHeatmap`), render `Heatmap` with the scatter's
   field names.
6. Keep `colorKeys` per chart across re-queries (e.g. the first result's
   `seriesList.map(s => s.key)`) so series do not change colour while other
   charts filter this one.
7. `formatAggregate` moved to `charts/format.ts`; it is still exported (also
   from `BarChart`), and the desktop `ChartView` keeps working unchanged.

## Benchmark

`pnpm --filter @glassgrid/ui bench:charts [-- --runs 3 --dpr 1 --scenarios line,heatmap]`
(Chromium from `PLAYWRIGHT_BROWSERS_PATH`, never downloaded; results in
`bench/results/charts-latest.json`, about 25 minutes with 3 runs because
the 1M software-WebGL frames are slow).

Run on 2026-10-18: shared 2-vCPU Xeon VM, 8 GB, no GPU; Chromium 1194
headless, WebGL = ANGLE on **SwiftShader** (software); plot 1,000 CSS px at
DPR 1; 3 runs per scenario, samples pooled. "Redraw" = a theme change
(React render, model and hit index, both layers, composite), synchronous;
"new result" also re-adapts the Arrow table (no cached preparation);
"drag composite" = ChartFrame's per-frame work while a brush is dragged.

| Scenario | Rows | Redraw p50 / p95 ms | New result p50 / p95 ms | Drag composite p50 / p95 ms | Drag frame interval p50 / p95 ms |
| --- | ---: | --- | --- | --- | --- |
| line (M4, 4 × 4,000) | 16,000 | 5.1 / 9.2 | 10.2 / 22.8 | 0.1 / 0.2 | 16.7 / 16.7 |
| histogram | 44 bins | 0.7 / 1.1 | 1.1 / 2.4 | 0.1 / 0.2 | 16.7 / 16.7 |
| heatmap 100 × 100 | 10,000 | 1.2 / 2.4 | 7.1 / 17.7 | 0.1 / 0.2 | 16.7 / 16.7 |
| bar | 20 | 0.6 / 1.0 | 0.6 / 2.2 | 0.4 / 0.7 (hover) | 16.7 / 16.7 |
| scatter, Canvas 2D | 10,000 | 6.7 / 13.2 | 14.4 / 25.4 | 0.1 / 0.2 | 16.7 / 16.8 |
| scatter, WebGL overlay | 1,000,000 | 29.7 / 61.1 | 157.8 / 183.0 | 0.1 / 0.2 | 900 / 1,117 |

- **Brushing keeps 60 fps for every canvas mark**: the per-frame work is a
  composite of 0.1–0.4 ms, independent of the mark count.
- **Canvas redraw < 8 ms**: met at the median for every canvas mark; p95
  is over for line (9.2) and the 10K scatter (13.2) on this noisy VM. A
  new result (adapter included) is 10–14 ms at the median for those two.
- **1M scatter at 60 fps: not met here.** GPU-finished overlay frames are
  938 ms (p50) as one `POINTS` draw and 18.8 s as instanced quads on
  SwiftShader; the drag runs at ~1 fps. The JavaScript side of a frame is
  0.1 ms (uniforms only). This needs a hardware GPU to verify. The 1M
  "redraw" (29.7 ms) rebuilds the instance buffers because a theme change
  hands the chart new colour objects.
- First render (page start to first layers, includes React mount):
  45–145 ms for canvas marks; the adapter on a cold JIT is 18 ms for the
  16K line and 115 ms for 1M scatter points.

## Number formatting

Added on `pres-polish`. One module, `packages/core/src/number-format.ts`
(pure, unit-tested), decides how every number on screen reads: bar
labels, tooltips, "View data", axis values, filter chips and history
labels, row counts and the column list. The grid keeps DuckDB-like cell
text (ungrouped, so IDs and years stay `2023`) but shares the noise
trimming.

| Where | Rule | Example |
| --- | --- | --- |
| Missing values | NULL, undefined, NaN → `–`; ±Infinity → `∞`/`-∞`; `-0` and negatives that round to zero → `0` | |
| Integers, counts, row counts | exact, grouped; bigint (BIGINT, HUGEINT) formatted from the bigint | `2,000,000` |
| Float noise | trimmed to 15 significant digits first | `39015093.429999996` → `39015093.43` |
| Measures (tooltips, "View data", bar labels) | by aggregate and the aggregated column's type, one mode per result so a column of labels is consistent: `count` and integer columns → integers; `avg` → two fixed decimals; DECIMAL → its scale (≤ 6, from the result's Arrow type); `min`/`max` of a float → the column's own precision (≤ 6 decimals); a float `sum` → two fixed decimals unless every value of the result is whole; below 1, three significant digits | `9,399,854.36`, `4.29`, `0.0123` |
| Bar labels | compact (three significant digits) once the chart's largest value reaches a million, or a billion for whole numbers; tooltips keep the full value | `39.0M`, `1,375,980` |
| Axis ticks | d3 picks precision from the step; SI suffixes written like Intl's (`K`, `M`, `B`) | `100K`, `2.5M` |
| Axis values, bin edges, scatter coordinates | the value's own precision, ≤ 6 decimals | `52.016 – 52.018` |
| Range chips and brush summaries | both bounds share decimals: as many as they need, at least two on float and DECIMAL columns (the design's `2.00 – 6.00`), and no more than the span warrants | `5.00 – 16.00`, `3.14 – 7.20` |
| Grid cells, FLOAT/DOUBLE | noise trimmed, and the numbers of one page padded to the same decimals (≤ 6) so digits line up | `4.2`, `4`, `4.28` → `4.20`, `4.00`, `4.28` |
| Tiny or huge | a short exponent where grouping would mislead | `1.23e-7`, `4.00e21` |

`Intl.NumberFormat` instances are created once per option set. Grid text
is formatted once per page as it arrives (`tableToColumns`), never while
painting.

## Limitations

- WebGL budgets cannot be checked on this VM: its only WebGL is SwiftShader.
  1M points take about a second per frame there (instanced quads ~18 s),
  so the 60 fps target needs a real GPU (the CI macOS runners). On a
  software renderer a dense scatter blocks the main thread while it draws;
  the app may want to lower `webglThreshold` or fall back to the heatmap
  sooner when `manager.renderer` is software.
- Redraw times above are the JavaScript side plus Chromium's raster of the
  layers on a shared 2-vCPU VM (GPU-less, so Canvas 2D also rasterizes
  through SwiftShader); medians are stable, p95 is noisy.
- Dense line envelopes thicken slanted segments by at most √2, so steep
  parts can look slightly thinner than a true stroke.
- The hidden screen-reader table lists the first 300 rows; "View data"
  the first 1,000.
- Bars do not brush (category selection only); axes are not labelled with
  field names (the shelves carry them, as in the design).
