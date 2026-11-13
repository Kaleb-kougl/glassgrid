import { type ChartSpec } from '../spec/chart.js';
import { type CrossfilterDimension, type CrossfilterHint } from '../spec/crossfilter.js';
import { type Filter } from '../spec/filter.js';
import { type CubeColumn } from '../sql/cube.js';
import { GRID_VIEW_ID, type Selection, type SelectionClause, type WorkspaceState } from '../state/workspace.js';
import { axisDimension, resolveAxis, stateColumns } from './axes.js';
import { mapViewportFilters } from './map-selection.js';

/*
 * The cross-filter model: one selection per view (chart id or "grid") plus
 * filters not tied to a view. Each view queries with every selection except
 * its own, plus every user filter, so a brushed chart keeps showing its full
 * distribution while everything else narrows.
 *
 * Since L4 a map view's viewport is a selection too (`mapViewportFilters`:
 * ranges on its lat and lon columns, while its "Filter to map view" is on);
 * it lives on the map (`maps[i].viewport`), not in `selections`, because it
 * is view state (never saved, no undo entry per pan). And the charts and
 * the grid may follow the time cursor (`timeFilter`, crossfilter/time.ts).
 */

type ModelState = Pick<WorkspaceState, 'charts' | 'columns' | 'selections' | 'userFilters'> & {
  /** Map views; their viewports filter the other views (absent: no maps). */
  readonly maps?: WorkspaceState['maps'];
};

type ComposeState = Pick<ModelState, 'charts' | 'selections' | 'userFilters' | 'maps'>;

/** Filters that are not a view's selection but apply to the charts and the grid (L4: the time cursor's window). */
export interface ContextFilters {
  /** `timeWindowFilter(state, column, T)`: while charts follow the cursor, the window up to T. Not applied to maps. */
  readonly timeFilter?: Filter | null;
}

/** The engine's `viewId` for a workspace view: `grid`, or `chart:<id>` (so newer requests supersede older ones). */
export function engineViewId(viewId: string): string {
  return viewId === GRID_VIEW_ID ? GRID_VIEW_ID : `chart:${viewId}`;
}

/** The filters a selection applies to the other views. */
export function selectionFilters(selection: Selection): Filter[] {
  return selection.clauses.map((clause) => clause.filter);
}

/** Views that own a selection, in a stable order: charts as listed, the grid, then any other ids sorted. */
export function selectionOrder(state: Pick<ModelState, 'charts' | 'selections'>): string[] {
  const known = [...state.charts.map((chart) => chart.id), GRID_VIEW_ID];
  const extra = Object.keys(state.selections)
    .filter((id) => !known.includes(id))
    .sort();
  return [...known, ...extra].filter((id) => Object.hasOwn(state.selections, id));
}

interface Composed {
  readonly filters: Filter[];
  /** Where each other view's selection starts in `filters` (by view id). */
  readonly offsets: ReadonlyMap<string, number>;
}

function compose(state: ComposeState, viewId: string | null, extra: Filter | null = null): Composed {
  const filters = state.userFilters.map((entry) => entry.filter);
  if (extra !== null) filters.push(extra);
  const offsets = new Map<string, number>();
  for (const owner of selectionOrder(state)) {
    if (owner === viewId) continue;
    const selection = state.selections[owner];
    if (!selection) continue;
    offsets.set(owner, filters.length);
    filters.push(...selectionFilters(selection));
  }
  // Map viewports, after every other selection (a map is never the brushed view of a cube hint).
  for (const map of state.maps ?? []) {
    if (map.id === viewId) continue;
    const viewport = mapViewportFilters(map);
    if (viewport.length === 0) continue;
    offsets.set(map.id, filters.length);
    filters.push(...viewport);
  }
  return { filters, offsets };
}

/**
 * The filters `viewId` queries with: every user filter, then every other
 * view's selection (never its own), then every other map's viewport. Pass
 * null for a consumer that is not a view (e.g. an export of the filtered
 * rows), which gets every selection. `context.timeFilter` is added for
 * charts, the grid and such consumers; pass none for a map (it is "as of T"
 * by its data clock instead).
 */
export function effectiveFilters(state: ComposeState, viewId: string | null, context: ContextFilters = {}): Filter[] {
  return compose(state, viewId, context.timeFilter ?? null).filters;
}

/** The dimension a view's single-clause selection is made in, for cross-filter cubes; null if none applies. */
export function selectionDimension(
  state: Pick<ModelState, 'charts' | 'selections'>,
  viewId: string,
  columns: readonly CubeColumn[],
): CrossfilterDimension | null {
  const selection = state.selections[viewId];
  if (!selection || selection.clauses.length !== 1) return null;
  const [clause] = selection.clauses as [SelectionClause];
  return clauseDimension(state, viewId, clause, columns);
}

function clauseDimension(
  state: Pick<ModelState, 'charts'>,
  viewId: string,
  clause: SelectionClause,
  columns: readonly CubeColumn[],
): CrossfilterDimension | null {
  if (viewId === GRID_VIEW_ID || clause.channel === null) {
    return { column: clause.filter.column, bin: { kind: 'value' } };
  }
  const chart = state.charts.find((candidate) => candidate.id === viewId);
  if (!chart) return null;
  const axis = resolveAxis(chart.spec, clause.channel, columns);
  if (!axis || axis.column.name !== clause.filter.column) return null;
  return axisDimension(axis);
}

export interface ViewQuery {
  /** Workspace view id: a chart id, or "grid". */
  readonly viewId: string;
  /** What to pass as the engine request's `viewId`. */
  readonly engineViewId: string;
  /** Filters for the request (grid: rows and count; charts: already in `spec.filters`). */
  readonly filters: Filter[];
  /**
   * Set while another view is the active brush: lets the engine answer from
   * a cube (`aggregate`/`count` requests take it as `crossfilter`).
   */
  readonly crossfilter: CrossfilterHint | null;
  /** Stable identity of the query's inputs: re-query when it changes. */
  readonly key: string;
}

export interface ChartViewQuery extends ViewQuery {
  readonly chartId: string;
  /** The chart's spec with its own filters followed by `filters`. */
  readonly spec: ChartSpec;
}

export interface ViewQueries {
  readonly grid: ViewQuery;
  readonly charts: ChartViewQuery[];
}

export interface ViewQueryOptions extends ContextFilters {
  /**
   * The view being brushed (the last one whose selection changed, see
   * `changedSelectionView`). Other views then carry a cross-filter hint for
   * its selection, so brushing it again is answered from cubes.
   */
  readonly activeView?: string | null;
  /**
   * The grid's time window when it differs from the charts' (`timeFilter`):
   * while the cursor plays, the app moves it on less often, so the grid is
   * not re-queried, and its rows replaced under the reader, every second.
   */
  readonly gridTimeFilter?: Filter | null;
}

function hintFor(
  composed: Composed,
  offset: number,
  activeView: string | null,
  dimension: CrossfilterDimension | null,
): CrossfilterHint | null {
  if (activeView === null || dimension === null) return null;
  const start = composed.offsets.get(activeView);
  return start === undefined ? null : { filter: offset + start, dimension };
}

/**
 * Per-view query inputs for the current state: the grid's filters and, per
 * chart, its spec with cross-filters applied, each with a stable key.
 */
export function viewQueries(state: ModelState, options: ViewQueryOptions = {}): ViewQueries {
  const columns = stateColumns(state);
  const activeView = options.activeView ?? null;
  const dimension = activeView === null ? null : selectionDimension(state, activeView, columns);

  const timeFilter = options.timeFilter ?? null;
  const gridComposed = compose(state, GRID_VIEW_ID, options.gridTimeFilter !== undefined ? options.gridTimeFilter : timeFilter);
  const grid: ViewQuery = {
    viewId: GRID_VIEW_ID,
    engineViewId: GRID_VIEW_ID,
    filters: gridComposed.filters,
    crossfilter: activeView === GRID_VIEW_ID ? null : hintFor(gridComposed, 0, activeView, dimension),
    key: JSON.stringify([GRID_VIEW_ID, gridComposed.filters]),
  };
  const charts = state.charts.map((chart): ChartViewQuery => {
    const composed = compose(state, chart.id, timeFilter);
    const spec: ChartSpec = { ...chart.spec, filters: [...chart.spec.filters, ...composed.filters] };
    const crossfilter =
      activeView === chart.id || spec.mark === 'scatter' ? null : hintFor(composed, chart.spec.filters.length, activeView, dimension);
    return {
      viewId: chart.id,
      chartId: chart.id,
      engineViewId: engineViewId(chart.id),
      filters: composed.filters,
      spec,
      crossfilter,
      key: JSON.stringify([engineViewId(chart.id), spec]),
    };
  });
  return { grid, charts };
}

export type CrossfilterTarget =
  | { readonly kind: 'aggregate'; readonly viewId: string; readonly engineViewId: string; readonly spec: ChartSpec }
  | { readonly kind: 'count'; readonly viewId: string; readonly engineViewId: string; readonly filters: Filter[] };

export interface CrossfilterPlan {
  /** The view about to be brushed. */
  readonly viewId: string;
  readonly dimension: CrossfilterDimension;
  /**
   * What every other view will ask for while the brush moves, without the
   * brushed view's selection: the inputs of the cubes to build (the engine's
   * `prepareCrossfilter`). The grid's count is included; its rows cannot be
   * pre-aggregated.
   */
  readonly targets: CrossfilterTarget[];
}

/**
 * At brush start (pointer down on a chart), the cubes the other views will
 * need: built while the person drags, they answer the brush's commit and
 * every later brush on the same axis. Null when the channel cannot be
 * brushed (e.g. a bar chart's categories along y).
 */
export function crossfilterPlan(state: ModelState, viewId: string, channel: 'x' | 'y' = 'x', context: ContextFilters = {}): CrossfilterPlan | null {
  const columns = stateColumns(state);
  const chart = state.charts.find((candidate) => candidate.id === viewId);
  if (!chart) return null;
  const axis = resolveAxis(chart.spec, channel, columns);
  if (!axis) return null;
  const withoutBrush: ModelState = { ...state, selections: Object.fromEntries(Object.entries(state.selections).filter(([id]) => id !== viewId)) };
  const queries = viewQueries(withoutBrush, context);
  const targets: CrossfilterTarget[] = [
    ...queries.charts
      .filter((query) => query.chartId !== viewId && query.spec.mark !== 'scatter')
      .map((query): CrossfilterTarget => ({ kind: 'aggregate', viewId: query.viewId, engineViewId: query.engineViewId, spec: query.spec })),
    { kind: 'count', viewId: GRID_VIEW_ID, engineViewId: GRID_VIEW_ID, filters: queries.grid.filters },
  ];
  return { viewId, dimension: axisDimension(axis), targets };
}

/** The first view whose selection differs between two states (added, changed or removed), or null. */
export function changedSelectionView(
  before: Pick<ModelState, 'charts' | 'selections'>,
  after: Pick<ModelState, 'charts' | 'selections'>,
): string | null {
  const ids = new Set([...Object.keys(before.selections), ...Object.keys(after.selections)]);
  for (const id of ids) {
    if (JSON.stringify(before.selections[id] ?? null) !== JSON.stringify(after.selections[id] ?? null)) return id;
  }
  return null;
}
