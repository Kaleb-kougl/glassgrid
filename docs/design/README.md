# Design implementation notes

The Claude Design export (Glassgrid mockups A–E, the component sheet and the
token rationale) is reference material in the gitignored `/design` folder.
Its token system now lives in `packages/ui/tokens` (single source:
`build-tokens.js`; regenerate with `pnpm --filter @glassgrid/ui tokens`, check
for drift with `--check` or `pnpm test`). Nothing in the app imports from
`/design`, and the Claude Design runtime (`support.js`) is not redistributed.

## Side by side

Each image puts the design frame (left) next to the app (right), both
1440×900. The app side comes from the E2E suite (`xvfb-run -a pnpm e2e`):
the real Electron app on Linux with the generated 1,000,000-row fixture, a
bar chart dragged from the column list, one bar selected, the canvas grid
sorted by `id` (a click on its header) and a cell range dragged on the
canvas, then copied with Ctrl+C. Since M2 the grid is the canvas grid
(`CanvasGrid` in `@glassgrid/ui`); the images were refreshed then.

| State | Dark | Light |
| --- | --- | --- |
| A · populated | [A-populated-dark.png](screens/A-populated-dark.png) | [A-populated-light.png](screens/A-populated-light.png) |
| B · empty | [B-empty-dark.png](screens/B-empty-dark.png) | [B-empty-light.png](screens/B-empty-light.png) |

[gallery.png](screens/gallery.png) is the component sheet as `apps/web`
renders it (`pnpm dev:web`), both themes side by side.

The design frames use the NYC taxi file (9 columns, 10M rows, three charts);
the fixture has 4 columns and one chart, so content differs while layout,
spacing, type and colour are meant to match.

## Intentional deviations

- **No aggregate shelf.** The aggregate lives in the Y chip (`count(*)`,
  `sum(fare_amount)`), matching `ChartSpec.y.aggregate`; its caret menu
  switches the aggregate (`setShelf`). The design already shows it this way.
- **Shelves name spec fields, not screen axes.** For the horizontal bar
  chart the design labels the value axis X and the category Y; the app keeps
  X = the grouped column and Y = the aggregate for every mark, so a chip
  always means the same `ChartSpec` field.
- **Bar charts only until M3.** Line, histogram, heatmap and scatter cards
  (and brushing) arrive with the M3 chart layer. "+ New chart", Enter on a
  column and dragging a column onto the Charts panel all add bar charts.
  The Color shelf is shown but inert (tooltip says so).
- **Null share is not drawn in the column list.** The design's rows show
  the distinct count only; the profile's null fraction is the row's tooltip
  and part of its accessible name ("12.5% null").
- **"Agent · not connected" uses the secondary text colour**, not the
  disabled one: it is status text, and the disabled colour measured 4.37:1
  on the light title bar (axe colour-contrast, WCAG 1.4.3 needs 4.5:1).
- **The file name is the page heading.** It is an `h1` styled like the
  design's title text, so the populated screen has a level-one heading
  (axe page-has-heading-one); nothing changes visually.
- **"+ Filter" is disabled.** The filter editor is not designed yet; bars
  are the way to filter for now.
- **Title bar on Linux and Windows.** The 80px traffic-light inset is macOS
  only (`titleBarStyle: 'hiddenInset'`); elsewhere the native frame keeps
  its controls and the file name starts at the 12px padding. Shortcut hints
  read `Ctrl+O` instead of `⌘O`.
- **Profiling is one query.** The engine profiles all columns at once, so
  every column shows the profiling indicator until it finishes and the
  header says "Profiling…" rather than "Profiling 5 of 9". Sorting and
  filters are not locked while the file is read.
- **Distinct counts** are exact below a million and compact above
  (`8.41M`), as in the design; they are HyperLogLog estimates.
- **Agent (state E) is v2.** Only the inactive AgentIndicator is wired; the
  "by AI" variants of HistoryItem, ShelfChip and ChartCard exist and are
  tested, the activity panel is not built.
- **Parse-error card copy.** The design's error shows a CSV line and column;
  the engine reports compiler and DuckDB messages, which the card shows
  verbatim (with the offending spec path as the detail line).
