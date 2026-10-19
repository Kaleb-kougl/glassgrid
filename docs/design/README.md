# Design implementation notes

The Claude Design export (Glassgrid mockups A–E, the component sheet and the
token rationale) is reference material in the gitignored `/design` folder.
Its token system now lives in `packages/ui/tokens` (single source:
`build-tokens.js`; regenerate with `pnpm --filter @glassgrid/ui tokens`, check
for drift with `--check` or `pnpm test`). Nothing in the app imports from
`/design`, and the Claude Design runtime (`support.js`) is not redistributed.

## Side by side

Each image puts the design frame (left) next to the app (right), both
1440×900. The app side comes from the E2E suite (`xvfb-run -a pnpm e2e`),
the real Electron app on Linux:

- **A · populated** (refreshed in M3): `crossfilter.spec.ts` on the
  generated 1,000,000-row trips fixture (`pickup_at`, `payment_type`,
  `trip_distance`, `fare_amount`). Columns dragged onto the charts panel
  make a line over time, a bar chart and a histogram (plus a heatmap below
  the fold); the Cash bar is clicked and the histogram brushed from 2 to 6,
  so the chips, the row count and the other charts are cross-filtered; the
  pointer rests on the line for a tooltip.
- **B · empty**: `count-rows.spec.ts` before a file is opened (unchanged
  since M2).

`compose-screens.py` (Pillow) builds the images:
`python3 docs/design/compose-screens.py --app apps/desktop/e2e-results`
after an E2E run. It reuses the design half of the existing images unless
`--design` points at frames rendered from the gitignored `/design` export
(each `[data-screen-label]` frame of `Glassgrid.dc.html` screenshotted at
1440×900).

| State | Dark | Light |
| --- | --- | --- |
| A · populated | [A-populated-dark.png](screens/A-populated-dark.png) | [A-populated-light.png](screens/A-populated-light.png) |
| B · empty | [B-empty-dark.png](screens/B-empty-dark.png) | [B-empty-light.png](screens/B-empty-light.png) |

[gallery.png](screens/gallery.png) is the component sheet as `apps/web`
renders it (`pnpm dev:web`), both themes side by side.

The design frames use the NYC taxi file (9 columns, 10M rows, three charts);
the fixture has 4 taxi-like columns and four charts, so content differs while
layout, spacing, type and colour are meant to match.

## Intentional deviations

- **No aggregate shelf.** The aggregate lives in the Y chip (`count(*)`,
  `sum(fare_amount)`), matching `ChartSpec.y.aggregate`; its caret menu
  switches the aggregate (`setShelf`). The design already shows it this way.
- **Shelves name spec fields, not screen axes.** For the horizontal bar
  chart the design labels the value axis X and the category Y; the app keeps
  X = the grouped column and Y = the aggregate for every mark, so a chip
  always means the same `ChartSpec` field.
- **The line's automatic time unit is the finest that fits.** The design's
  "Trips per day" line is daily; the default chart rules pick the finest of
  hour/day/month with at most 20,000 buckets, so a month of trips is drawn
  hourly (`hour(pickup_at)`, M4 per pixel column). A day is one `setShelf`
  away (`x: { column, timeUnit: 'day' }`); there is no unit menu on the X
  chip yet.
- **Default titles name the fields, not the subject.** "Rows over
  pickup_at", "Rows by payment_type", "Distribution of trip_distance",
  "Rows by trip_distance and fare_amount" instead of "Trips per day" and
  "Trip distance": the app does not know what a row is. Titles can be
  renamed (click the title).
- **Shelves show resolved bins and units** (`bin(trip_distance, 1)`,
  `hour(pickup_at)`), computed from the profile like the compiler does,
  rather than the spec's `auto`.
- **Ranges have no units** ("2.00 – 6.00", not "2.00 – 6.00 mi"): columns
  carry no unit metadata.
- **Two-column charts.** The design drops a second column on a card. Here a
  column dropped on a card goes to Y (numbers), X (dates) or Color
  (categories); a two-column default chart (e.g. the heatmap of two numbers)
  is made by selecting both columns in the grid and dragging either (or
  "+ New chart").
- **Mark switcher in the card's ⋯ menu** (Bar, Line, Area, Histogram,
  Heatmap, Scatter as radio items; marks the columns cannot make are
  disabled). The design has no mark control.
- **The "+ Filter" editor is ours.** A popover with Column, Condition and
  value fields (validated as typed, errors next to the field), using the
  menu and input tokens; the design shows only the button.
- **One skeleton for every mark.** A query over 300 ms shows the bar-shaped
  skeleton on that card ("Updating…"); the design only draws it for bars.
- **Heatmaps have no Color shelf drop**: cells are coloured by count (the
  shelf says so in its tooltip).
- **Null share is not drawn in the column list.** The design's rows show
  the distinct count only; the profile's null fraction is the row's tooltip
  and part of its accessible name ("12.5% null").
- **"Agent · not connected" uses the secondary text colour**, not the
  disabled one: it is status text, and the disabled colour measured 4.37:1
  on the light title bar (axe colour-contrast, WCAG 1.4.3 needs 4.5:1).
- **The file name is the page heading.** It is an `h1` styled like the
  design's title text, so the populated screen has a level-one heading
  (axe page-has-heading-one); nothing changes visually.
- **Title bar on Linux and Windows.** The 80px traffic-light inset is macOS
  only (`titleBarStyle: 'hiddenInset'`); elsewhere the native frame keeps
  its controls and the file name starts at the 12px padding. Shortcut hints
  read `Ctrl+O` instead of `⌘O`.
- **Profiling is one query.** The engine profiles all columns at once, so
  every column shows the profiling indicator until it finishes and the
  header says "Profiling…" rather than "Profiling 5 of 9". Sorting and
  filters are not locked while the file is read.
- **Distinct counts** are grouped below a million and compact above
  (`8.41M`), as in the design. They are exact on small tables and for
  text and boolean columns; elsewhere they are HyperLogLog estimates and
  read `≈1.7M` (see m4-web-demo.md, known issues).
- **Agent (state E) is v2.** Only the inactive AgentIndicator is wired; the
  "by AI" variants of HistoryItem, ShelfChip and ChartCard exist and are
  tested, the activity panel is not built.
- **Parse-error card copy.** The design's error shows a CSV line and column;
  the engine reports compiler and DuckDB messages, which the card shows
  verbatim (with the offending spec path as the detail line).
