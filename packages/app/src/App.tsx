import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import {
  changedSelectionView,
  CommandError,
  crossfilterPlan,
  effectiveColumnType,
  filterChips,
  isNumericType,
  stateColumns,
  tableIdForFile,
  viewQueries,
  type BrushSelectionInput,
  type ChartSpecInput,
  type ColumnState,
  type Filter,
  type FilterChip as FilterChipModel,
  type FilterInput,
  type TableColumnProfile,
  type TableId,
  type UndoEntry,
  type ViewQueries,
  type WorkspaceState,
} from '@glassgrid/core';
import {
  Button,
  CanvasGrid,
  ColumnListRow,
  copySelectionAsTsv,
  draggedColumn,
  FilterChip,
  isColumnDrag,
  Toast,
  tokensFor,
  WebGLOverlayProvider,
  type GridSelection as IndexSelection,
  type ToastAction,
} from '@glassgrid/ui';
import { openFileAction } from './actions/open-file';
import { chartTitle, describeEntry } from './describe';
import { isAbandoned, type RowsResult } from './engine';
import {
  CHART_CREATE_MEASURE,
  COUNT_ROWS_MEASURE,
  CROSSFILTER_PREPARE_MEASURE,
  OPEN_TO_FIRST_ROWS_MEASURE,
  PROFILE_MEASURE,
  SORT_TO_FIRST_ROWS_MEASURE,
  type ChartCreateMeasureDetail,
  type CountRowsMeasureDetail,
  type CrossfilterPrepareMeasureDetail,
  type OpenToFirstRowsMeasureDetail,
  type ProfileMeasureDetail,
  type SortToFirstRowsMeasureDetail,
} from './perf';
import { perfRegion, renderPerf } from './render-perf';
import { useTheme } from './theme';
import type { ChartResult } from './views/chart-data';
import { ChartView } from './views/ChartView';
import { CrossfilterTracker } from './views/crossfilter-tracker';
import { FilterEditor } from './views/FilterEditor';
import {
  displayColumns,
  EngineGridSource,
  fromIndexSelection,
  selectedColumnNames,
  sourceColumns,
  toIndexSelection,
} from './views/grid-source';
import { TopBar } from './views/TopBar';
import { LocateDataDialog, MismatchBanner, RecentWorkspaces, RecoveryOffers } from './views/WorkspaceFileViews';
import { workspaceFilesOf, type Platform } from './platform';
import { createAppWorkspace, type AppWorkspace } from './workspace';
import { isWorkspaceFileName, useWorkspaceFiles } from './workspace-files';

export { describeEntry };

export interface AppProps {
  /** Everything platform-specific: engine, files, clipboard, window, capabilities. Stable for the app's lifetime. */
  platform: Platform;
  /**
   * The workspace (store + command registry). Shells create it outside React
   * (so StrictMode's double mount keeps one undo history, and render-perf
   * builds can install their recorder on its store first); the app makes
   * its own when none is given.
   */
  workspace?: AppWorkspace;
  /**
   * Opened once when the app mounts, exactly like clicking Open with this
   * as the picker (busy state, size limit, error toast with Retry). The web
   * demo passes `() => files.openSample(id)` for `/?sample=<id>` links.
   */
  initialOpen?: () => Promise<unknown>;
}

/** Started by an "Open" click or a drop; finished by the first rows of the new data source painted. */
interface PendingOpen {
  start: string;
  table: TableId;
  openEngineMs: number;
  usingParquetCache: boolean;
}

/** Started by a column dropped on the charts panel (or "+ New chart"); finished by the new chart drawn. */
interface PendingCreate {
  start: string;
  /** Charts that existed before: the first other chart to draw is the new one. */
  before: ReadonlySet<string>;
  columns: string[];
}

/** Started by a header click; finished by the first rows of the sorted view painted. */
interface PendingSort {
  start: string;
  table: TableId;
  sort: string;
}

interface ToastState {
  id: number;
  tone: 'info' | 'error';
  message: string;
  by?: string;
  action?: ToastAction;
}

const numberFormat = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

function measure(name: string, start: string, detail: unknown): number {
  const end = `${name}:end`;
  performance.mark(end);
  const entry = performance.measure(name, { start, end, detail });
  performance.clearMarks(start);
  performance.clearMarks(end);
  return entry.duration;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/** Distinct counts as the column list shows them: exact below a million, then compact (8.41M). */
export function formatDistinct(count: number): string {
  return count < 1_000_000 ? numberFormat.format(count) : compact.format(count);
}

/** The share of NULLs in a column, as the column list reads it out: `no nulls`, `<0.1% null`, `12.5% null`. */
export function formatNulls(fraction: number): string {
  if (fraction <= 0) return 'no nulls';
  if (fraction < 0.001) return '<0.1% null';
  return `${percent.format(fraction)} null`;
}

/** A bar chart over `column` (kept for callers that want a bar regardless of the column's type). */
export function barSpecFor(column: string): ChartSpecInput {
  return { mark: 'bar', x: { column } };
}

/** Plot width in device pixels for line aggregates (M4 keeps four points per pixel column), from the charts list width. */
export function chartPixelWidth(listWidth: number, dpr: number): number {
  // Card padding and the y axis take about 80 CSS px of the list's width; round so small resizes do not re-query.
  const px = Math.round((Math.max(100, listWidth - 80) * dpr) / 50) * 50;
  return Math.min(16_384, Math.max(100, px));
}

/** Every view's query key, as the cross-filter timing names them (`chart:<id>`, `grid:count`, `grid:rows`). */
export function viewKeys(queries: ViewQueries): Map<string, string> {
  const keys = new Map<string, string>();
  keys.set('grid:count', queries.grid.key);
  keys.set('grid:rows', queries.grid.key);
  for (const chart of queries.charts) keys.set(chart.engineViewId, chart.key);
  return keys;
}

/** Which caller created each chart, from the history's `addChart` patches. */
function chartCallers(past: readonly UndoEntry[]): Map<string, 'user' | 'ai'> {
  const callers = new Map<string, 'user' | 'ai'>();
  for (const entry of past) {
    if (entry.name !== 'addChart') continue;
    for (const patch of entry.patches) {
      const value = patch.value as { id?: unknown } | undefined;
      if (patch.op === 'add' && patch.path[0] === 'charts' && typeof value?.id === 'string') callers.set(value.id, entry.caller);
    }
  }
  return callers;
}

export function App({ platform, workspace: givenWorkspace, initialOpen }: AppProps) {
  const [ownWorkspace] = useState(() => (givenWorkspace === undefined ? createAppWorkspace() : null));
  const workspace = (givenWorkspace ?? ownWorkspace) as AppWorkspace;
  const { store, registry } = workspace;
  const { engine, files, clipboard, window: shell, capabilities } = platform;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const history = useSyncExternalStore(store.subscribe, store.getHistory);
  if (__GG_RENDER_PERF__) renderPerf.appRender(state.charts);
  const { theme, setPreference } = useTheme(shell);
  const tokens = tokensFor(theme);

  const tableId = state.dataSource ? tableIdForFile(state.dataSource.handleId) : null;
  const [opening, setOpening] = useState(false);
  const [firstPageTable, setFirstPageTable] = useState<TableId | null>(null);
  const [profile, setProfile] = useState<{ table: TableId; rowCount: number; columns: TableColumnProfile[] } | null>(null);
  /** The latest row count, with what the cross-filter timing needs (the grid key it answers, engine figures). */
  const [count, setCount] = useState<{
    table: TableId;
    key: string;
    rowCount: number;
    gridKey: string;
    engineMs: number;
    fromCube: boolean;
    cached: boolean;
  } | null>(null);
  const [optimizing, setOptimizing] = useState<{ table: TableId; fraction: number | null } | null>(null);
  /** Tables whose background Parquet copy is ready (queries read it from then on). */
  const [parquetReady, setParquetReady] = useState<ReadonlySet<TableId>>(new Set());
  const [draggingColumn, setDraggingColumn] = useState<string | null>(null);
  const [fileOver, setFileOver] = useState(false);
  const [chartsOver, setChartsOver] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const pendingOpen = useRef<PendingOpen | null>(null);
  const toastId = useRef(0);

  const showToast = useCallback((next: Omit<ToastState, 'id'>) => {
    toastId.current += 1;
    setToast({ ...next, id: toastId.current });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const dispatch = useCallback(
    (name: string, input: unknown = {}) => {
      registry.dispatch(name, input, { caller: 'user' }).catch((cause: unknown) => {
        showToast({ tone: 'error', message: messageOf(cause) });
      });
    },
    [registry, showToast],
  );

  /** A shortcut as this platform writes it: ⌘Z on macOS, Ctrl+Z elsewhere. */
  const mod = (key: string) => (shell.shortcuts === 'mac' ? `⌘${key}` : `Ctrl+${key}`);

  // ---------------------------------------------------------------------------
  // Views of the data source

  // The view being brushed (the last whose selection changed, or the chart under the pointer): other
  // views carry a cross-filter hint for its selection, so the engine can answer them from cubes.
  const [active, setActive] = useState<{ selections: WorkspaceState['selections']; view: string | null }>({ selections: state.selections, view: null });
  let activeView = active.view;
  if (active.selections !== state.selections) {
    activeView = changedSelectionView({ charts: state.charts, selections: active.selections }, state) ?? active.view;
    setActive({ selections: state.selections, view: activeView });
  }
  // Every view's query inputs (core's cross-filter model): each queries with every selection but its own.
  const queries = useMemo(
    () => viewQueries({ charts: state.charts, columns: state.columns, selections: state.selections, userFilters: state.userFilters }, { activeView }),
    [state.charts, state.columns, state.selections, state.userFilters, activeView],
  );
  const compileColumns = useMemo(() => stateColumns(state), [state]);
  const gridFiltersKey = JSON.stringify(queries.grid.filters);
  const filters = useMemo(() => JSON.parse(gridFiltersKey) as Filter[], [gridFiltersKey]);
  /** The grid count's cross-filter hint, read when the count is sent (not part of its key). */
  const gridHint = useRef(queries.grid.crossfilter);
  useLayoutEffect(() => {
    gridHint.current = queries.grid.crossfilter;
  });
  const tracker = useMemo(() => new CrossfilterTracker(), []);
  // Bumped when the engine's data for the table changes under the same view (type overrides applied, engine restart).
  const [dataVersion, setDataVersion] = useState(0);

  // ---------------------------------------------------------------------------
  // The grid: one paged source per table, reset whenever its view changes

  const countKey = tableId === null ? '' : JSON.stringify([tableId, filters, dataVersion]);
  const knownRowCount = count?.key === countKey ? count.rowCount : null;
  const fileColumns = useMemo(() => sourceColumns(state.columns), [state.columns]);
  const gridColumns = useMemo(
    () => displayColumns(state.columns, state.grid),
    // Only order and widths matter, not sort or selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.columns, state.grid.columnOrder, state.grid.columnWidths],
  );
  const gridSelection = useMemo(() => toIndexSelection(state.grid.selection, gridColumns), [state.grid.selection, gridColumns]);
  const selectedColumns = useMemo(() => selectedColumnNames(state.grid.selection, gridColumns), [state.grid.selection, gridColumns]);
  const view = useMemo(
    () => ({ sort: state.grid.sort, filters, dataVersion, columns: fileColumns, rowCount: knownRowCount }),
    [state.grid.sort, filters, dataVersion, fileColumns, knownRowCount],
  );
  const grid = useMemo(
    () => (tableId === null ? null : new EngineGridSource(engine, tableId, view)),
    // A new table is a new source, built with the view of that render; later view changes reset it (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, tableId],
  );
  /** The grid key (`viewQueries`) of the view the grid shows, for the cross-filter timing. */
  const gridViewKey = useRef(queries.grid.key);
  useLayoutEffect(() => {
    gridViewKey.current = queries.grid.key;
    grid?.update(view);
  }, [grid, view, queries.grid.key]);
  useEffect(() => () => grid?.cancel(), [grid]);

  // The first page of a view: the open/sort measures read its engine time; the first one unlocks the profile and the count.
  const firstPage = useRef<{ table: TableId; result: RowsResult; gridKey: string } | null>(null);
  useLayoutEffect(() => {
    if (!grid) return;
    const table = grid.table;
    const offPage = grid.onFirstPage((result) => {
      firstPage.current = { table, result, gridKey: gridViewKey.current };
      setFirstPageTable(table);
      // An empty view paints no rows: its first page is all there is to show.
      if (result.table.numRows === 0) tracker.painted('grid:rows', gridViewKey.current, { engineMs: result.engineMs, fromCube: false, cached: result.cached });
    });
    const offErrors = grid.source.subscribe((change) => {
      if (change.kind === 'error' && !isAbandoned(change.error)) showToast({ tone: 'error', message: messageOf(change.error) });
    });
    return () => {
      offPage();
      offErrors();
    };
  }, [grid, showToast, tracker]);

  const pendingSort = useRef<PendingSort | null>(null);
  const onFirstRowsPainted = useCallback(() => {
    const page = firstPage.current;
    if (page) tracker.painted('grid:rows', page.gridKey, { engineMs: page.result.engineMs, fromCube: false, cached: page.result.cached });
    const open = pendingOpen.current;
    if (open && open.table === page?.table) {
      pendingOpen.current = null;
      measure(OPEN_TO_FIRST_ROWS_MEASURE, open.start, {
        openEngineMs: open.openEngineMs,
        firstPageEngineMs: page.result.engineMs,
        rows: page.result.table.numRows,
        columns: page.result.table.numCols,
        usingParquetCache: open.usingParquetCache,
      } satisfies OpenToFirstRowsMeasureDetail);
    }
    const sorted = pendingSort.current;
    if (sorted && sorted.table === page?.table) {
      pendingSort.current = null;
      measure(SORT_TO_FIRST_ROWS_MEASURE, sorted.start, {
        sort: sorted.sort,
        firstPageEngineMs: page.result.engineMs,
        cached: page.result.cached,
      } satisfies SortToFirstRowsMeasureDetail);
    }
  }, [tracker]);

  // The previous table's DuckDB instance is freed when another file replaces it (and when the window goes away).
  const shownTable = useRef<TableId | null>(null);
  useEffect(() => {
    const previous = shownTable.current;
    shownTable.current = tableId;
    if (previous !== null && previous !== tableId) {
      // Reopened later (undo back to it), the table starts with inferred types again.
      engineOverrides.current.delete(previous);
      void engine.closeTable(previous).catch(() => undefined);
    }
  }, [engine, tableId]);
  useEffect(
    () =>
      shell.onBeforeClose(() => {
        if (shownTable.current !== null) void engine.closeTable(shownTable.current).catch(() => undefined);
      }),
    [engine, shell],
  );

  // ---------------------------------------------------------------------------
  // Type overrides reach the engine: after setColumnType, undo/redo of one, or an engine restart

  const overrides = useMemo(
    () => state.columns.flatMap((column) => (column.typeOverride === null ? [] : [{ column: column.name, type: column.typeOverride }])),
    [state.columns],
  );
  const overridesKey = JSON.stringify(overrides);
  /**
   * The override set (as `overridesKey`) last sent to the engine per table; tables open with none. The
   * engine applies a table's calls in order, so the last one sent is what it ends up with.
   */
  const engineOverrides = useRef(new Map<TableId, string>());
  const [engineEpoch, setEngineEpoch] = useState(0);
  /** "Reading amount as text…" while the engine applies the override set `key` to `table`. */
  const [retyping, setRetyping] = useState<{ table: TableId; key: string; message: string } | null>(null);
  const latestOverrides = useRef(overridesKey);
  useLayoutEffect(() => {
    latestOverrides.current = overridesKey;
  }, [overridesKey]);

  useEffect(
    () =>
      engine.onRestarted(() => {
        // The engine reopens tables with inferred types: re-send the overrides, then every view re-queries.
        engineOverrides.current.clear();
        setEngineEpoch((epoch) => epoch + 1);
        if (latestOverrides.current === '[]') setDataVersion((version) => version + 1);
      }),
    [engine],
  );

  useEffect(() => {
    if (tableId === null) return;
    const applied = engineOverrides.current.get(tableId) ?? '[]';
    if (applied === overridesKey) return;
    const before = new Map((JSON.parse(applied) as { column: string; type: string }[]).map((entry) => [entry.column, entry.type]));
    const changed = overrides.filter((entry) => before.get(entry.column) !== entry.type);
    // The table's first set (a workspace just loaded, or the engine restarted) restores saved types: nothing to undo.
    const initial = !engineOverrides.current.has(tableId);
    const run = { live: true };
    engineOverrides.current.set(tableId, overridesKey);
    setRetyping({
      table: tableId,
      key: overridesKey,
      message: changed.length === 1 && changed[0] ? `Reading ${changed[0].column} as ${changed[0].type}…` : 'Applying column types…',
    });
    engine.setColumnTypes(tableId, overrides).then(
      (result) => {
        if (!run.live) return;
        setRetyping((current) => (current?.key === overridesKey ? null : current));
        // The engine dropped the table's cached pages, counts, charts and sort indexes: every view re-queries.
        setDataVersion((version) => version + 1);
        const failed = result.columns.filter((entry) => entry.failedCasts > 0 && before.get(entry.column) !== entry.type);
        const first = failed[0];
        if (first) {
          const more = failed.length > 1 ? ` (and in ${failed.length - 1} more ${failed.length === 2 ? 'column' : 'columns'})` : '';
          showToast({
            tone: 'info',
            message: `${numberFormat.format(first.failedCasts)} ${first.failedCasts === 1 ? 'value' : 'values'} in ${first.column} couldn’t be read as ${first.type} and show as null${more}`,
            ...(initial ? {} : { action: { label: 'Undo', shortcut: mod('Z'), onClick: () => dispatch('undo') } }),
          });
        }
      },
      (cause: unknown) => {
        // Unknown what the engine applies now: the next change (or restart) sends the full set again.
        if (engineOverrides.current.get(tableId) === overridesKey) engineOverrides.current.delete(tableId);
        if (!run.live) return;
        setRetyping((current) => (current?.key === overridesKey ? null : current));
        if (!isAbandoned(cause)) showToast({ tone: 'error', message: messageOf(cause) });
      },
    );
    return () => {
      run.live = false;
    };
    // overridesKey stands for overrides by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, tableId, overridesKey, engineEpoch, showToast, dispatch]);

  // copySelection: the selection as TSV, through the platform's clipboard.
  const gridSource = useRef<EngineGridSource | null>(null);
  useLayoutEffect(() => {
    gridSource.current = grid;
  }, [grid]);
  useEffect(
    () =>
      registry.provide('copySelection', async (_input, { state: current }) => {
        const columns = displayColumns(current.columns, current.grid);
        const selection = toIndexSelection(current.grid.selection, columns);
        const source = gridSource.current?.source;
        if (!source || !selection) {
          throw new CommandError('precondition_failed', 'Nothing is selected in the grid; select cells first', { command: 'copySelection' });
        }
        const result = await copySelectionAsTsv(source, columns, selection);
        if (!result) throw new CommandError('precondition_failed', 'The selection is outside the rows of this view', { command: 'copySelection' });
        await clipboard.writeText(result.text);
        showToast({ tone: 'info', message: result.message });
        return { rows: result.rows, columns: result.columns, selectedRows: result.selectedRows, truncated: result.truncated, message: result.message };
      }),
    [registry, clipboard, showToast],
  );

  useEffect(() => {
    if (tableId === null || firstPageTable !== tableId) return;
    const run = { live: true };
    const start = `${PROFILE_MEASURE}:start:${tableId}`;
    performance.mark(start);
    engine.profile(tableId, { viewId: 'profile' }).then(
      (profiled) => {
        if (!run.live) return;
        measure(PROFILE_MEASURE, start, {
          engineMs: profiled.engineMs,
          rowCount: profiled.rowCount,
          columns: profiled.columns.length,
        } satisfies ProfileMeasureDetail);
        setProfile({ table: tableId, rowCount: profiled.rowCount, columns: profiled.columns });
        // Record the profile in the workspace (default charts and brush snapping read it); not an undo entry.
        registry
          .dispatch(
            'setColumnProfiles',
            {
              columns: profiled.columns.map(({ name, type, distinctCount, nullFraction, min, max }) => ({
                name,
                type,
                distinctCount,
                nullFraction,
                min,
                max,
              })),
            },
            { caller: 'user' },
          )
          .catch(() => undefined);
      },
      (cause: unknown) => {
        if (run.live && !isAbandoned(cause)) showToast({ tone: 'error', message: messageOf(cause) });
      },
    );
    return () => {
      run.live = false;
    };
  }, [engine, registry, tableId, firstPageTable, dataVersion, showToast]);

  useEffect(() => {
    if (tableId === null || firstPageTable !== tableId) return;
    const run = { live: true };
    const start = `${COUNT_ROWS_MEASURE}:start:${countKey}`;
    performance.mark(start);
    const hint = gridHint.current;
    const requestedFor = gridViewKey.current;
    engine.count(tableId, { viewId: 'status', filters, ...(hint ? { crossfilter: hint } : {}) }).then(
      (result) => {
        if (!run.live) return;
        measure(COUNT_ROWS_MEASURE, start, {
          rowCount: String(result.rowCount),
          engineMs: result.engineMs,
          cached: result.cached,
        } satisfies CountRowsMeasureDetail);
        setCount({
          table: tableId,
          key: countKey,
          rowCount: result.rowCount,
          gridKey: requestedFor,
          engineMs: result.engineMs,
          fromCube: result.fromCube === true,
          cached: result.cached,
        });
      },
      (cause: unknown) => {
        performance.clearMarks(start);
        if (run.live && !isAbandoned(cause)) showToast({ tone: 'error', message: messageOf(cause) });
      },
    );
    return () => {
      run.live = false;
    };
    // The hint and the grid key are read at request time (they follow filters).
  }, [engine, tableId, firstPageTable, countKey, filters, showToast]);

  // The count is "painted" once the row-count text shows it (cross-filter timing).
  useLayoutEffect(() => {
    if (count?.key !== countKey) return;
    tracker.painted('grid:count', count.gridKey, { engineMs: count.engineMs, fromCube: count.fromCube, cached: count.cached }, count.rowCount);
  }, [count, countKey, tracker]);

  // "Optimizing file": the engine's background Parquet conversion of large CSVs.
  useEffect(
    () =>
      engine.onEvent((event) => {
        if (event.type === 'parquetProgress') setOptimizing({ table: event.table, fraction: event.fraction });
        else if (event.type === 'parquetReady' || event.type === 'parquetFailed') setOptimizing(null);
        if (event.type === 'parquetReady') setParquetReady((ready) => new Set([...ready, event.table.id]));
      }),
    [engine],
  );

  // ---------------------------------------------------------------------------
  // Actions

  // The Retry action of an open error re-runs the latest `open` (called from an event handler).
  const retryOpen = useRef<(pick?: () => Promise<unknown>) => Promise<void>>(() => Promise.resolve());
  const open = useCallback(
    async (pick?: () => Promise<unknown>) => {
      setOpening(true);
      const start = `${OPEN_TO_FIRST_ROWS_MEASURE}:start:${performance.now()}`;
      performance.mark(start);
      try {
        const outcome = await openFileAction({
          files,
          engine,
          registry,
          maxFileBytes: capabilities.maxFileBytes,
          ...(pick ? { pick } : {}),
          // Armed before `openFile` changes the state, so the first-page view always finds it.
          onEngineOpened: (table, openEngineMs) => {
            pendingOpen.current = { start, table: table.id, openEngineMs, usingParquetCache: table.usingParquetCache };
          },
        });
        if (outcome.status !== 'opened') performance.clearMarks(start);
      } catch (cause) {
        pendingOpen.current = null;
        performance.clearMarks(start);
        showToast({ tone: 'error', message: messageOf(cause), action: { label: 'Retry', onClick: () => void retryOpen.current(pick) } });
      } finally {
        setOpening(false);
      }
    },
    [files, engine, registry, capabilities.maxFileBytes, showToast, setOpening],
  );

  useEffect(() => {
    retryOpen.current = open;
  }, [open]);

  // The shell's initial open (a shared sample link): once per app, even under StrictMode's double mount.
  const initialOpenStarted = useRef(false);
  useEffect(() => {
    if (!initialOpen || initialOpenStarted.current) return;
    initialOpenStarted.current = true;
    void open(initialOpen);
    // Read once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Charts: creation (default chart rules), brushing and the cross-filter timing

  const pendingCreate = useRef<PendingCreate | null>(null);
  /** One or two columns become a chart by the default chart rules (`addChart { columns }`); timed to the chart drawn. */
  const addChartFor = useCallback(
    (columns: string[]) => {
      if (pendingCreate.current) performance.clearMarks(pendingCreate.current.start);
      const start = `${CHART_CREATE_MEASURE}:start:${performance.now()}`;
      performance.mark(start);
      const created: PendingCreate = { start, before: new Set(store.getState().charts.map((chart) => chart.id)), columns };
      pendingCreate.current = created;
      if (__GG_RENDER_PERF__) renderPerf.dispatch();
      registry.dispatch('addChart', { columns }, { caller: 'user' }).catch((cause: unknown) => {
        if (pendingCreate.current === created) pendingCreate.current = null;
        performance.clearMarks(start);
        showToast({ tone: 'error', message: messageOf(cause) });
      });
    },
    [registry, store, showToast],
  );

  const onChartDrawn = useCallback(
    (chartId: string, result: ChartResult) => {
      if (__GG_RENDER_PERF__) renderPerf.drawn(chartId);
      tracker.painted(`chart:${chartId}`, result.queryKey, { engineMs: result.engineMs, fromCube: result.fromCube, cached: result.cached });
      const created = pendingCreate.current;
      if (!created || created.before.has(chartId)) return;
      pendingCreate.current = null;
      measure(CHART_CREATE_MEASURE, created.start, {
        chartId,
        mark: result.mark,
        columns: created.columns,
        engineMs: result.engineMs,
        cached: result.cached,
        rows: result.table.numRows,
      } satisfies ChartCreateMeasureDetail);
    },
    [tracker],
  );

  // The plot width line aggregates are computed for (one for the panel: cards share its width).
  const chartsListRef = useRef<HTMLDivElement>(null);
  const [pixelWidth, setPixelWidth] = useState(1_000);
  useLayoutEffect(() => {
    const list = chartsListRef.current;
    if (!list) return;
    const measureWidth = () => setPixelWidth(chartPixelWidth(list.clientWidth, window.devicePixelRatio || 1));
    measureWidth();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measureWidth);
    observer.observe(list);
    return () => observer.disconnect();
  }, [state.dataSource]);
  const latestPixelWidth = useRef(pixelWidth);
  useLayoutEffect(() => {
    latestPixelWidth.current = pixelWidth;
  });

  /**
   * Pointer down on a chart: it becomes the active view, and the engine starts building the cubes the
   * other views need for a brush on its axis (fire and forget; equal requests share one cube).
   */
  const onBrushStart = useCallback(
    (chartId: string) => {
      setActive((current) => (current.view === chartId ? current : { ...current, view: chartId }));
      const table = tableId;
      const current = store.getState();
      const plan = table === null ? null : crossfilterPlan(current, chartId);
      if (table === null || !plan) return;
      const width = latestPixelWidth.current;
      const targets = plan.targets.map((target) => (target.kind === 'aggregate' ? { kind: 'aggregate' as const, spec: { ...target.spec, pixelWidth: width } } : { kind: 'count' as const, filters: target.filters }));
      const start = `${CROSSFILTER_PREPARE_MEASURE}:start:${performance.now()}`;
      performance.mark(start);
      engine.prepareCrossfilter(table, { dimension: plan.dimension, targets }).then(
        (result) => {
          const bin = plan.dimension.bin;
          measure(CROSSFILTER_PREPARE_MEASURE, start, {
            source: chartId,
            dimension: `${plan.dimension.column} ${bin.kind === 'width' ? `width ${bin.width}` : bin.kind === 'time' ? bin.unit : 'values'}`,
            cubes: result.cubes.map((cube) => ({ ...cube })),
            engineMs: result.engineMs,
          } satisfies CrossfilterPrepareMeasureDetail);
        },
        () => performance.clearMarks(start),
      );
    },
    [engine, store, tableId, setActive],
  );

  /** A brush released or a bar toggled: one `brush` command (one undo entry); timed until every other view painted. */
  const onBrushEnd = useCallback(
    (chartId: string, selection: BrushSelectionInput | null) => {
      const before = store.getState();
      if (selection === null && !Object.hasOwn(before.selections, chartId)) return;
      setActive((current) => (current.view === chartId ? current : { ...current, view: chartId }));
      if (__GG_RENDER_PERF__) renderPerf.dispatch();
      tracker.begin(chartId, viewKeys(viewQueries(before)));
      registry.dispatch('brush', { viewId: chartId, selection }, { caller: 'user' }).then(
        () => {
          const after = viewQueries(store.getState());
          tracker.arm(viewKeys(after), after.grid.filters);
        },
        (cause: unknown) => {
          tracker.cancel();
          showToast({ tone: 'error', message: messageOf(cause) });
        },
      );
    },
    [registry, store, tracker, showToast, setActive],
  );

  /** A column dropped (or Enter on it): with two columns selected in the grid and the dropped one among them, both. */
  const columnsForChart = (column: string): string[] => {
    if (selectedColumns.length === 2 && selectedColumns.includes(column)) return [column, ...selectedColumns.filter((name) => name !== column)];
    return [column];
  };

  const addFilter = useCallback(async (filter: FilterInput) => {
    await registry.dispatch('addFilter', { filter }, { caller: 'user' });
  }, [registry]);


  // Removing a chip dispatches the command the model names for it, which also clears the brush it came from.
  const removeFilter = (chip: FilterChipModel) => {
    dispatch(chip.remove.command, chip.remove.input);
    showToast({ tone: 'info', message: `Removed filter ${chip.column}`, action: { label: 'Undo', shortcut: mod('Z'), onClick: () => dispatch('undo') } });
  };

  const stepTo = (entryId: string) => {
    const { past, future } = store.getHistory();
    const back = past.length - 1 - past.findIndex((entry) => entry.id === entryId);
    const forward = future.findIndex((entry) => entry.id === entryId) + 1;
    if (back > 0 && back < past.length) for (let i = 0; i < back; i += 1) dispatch('undo');
    else if (forward > 0) for (let i = 0; i < forward; i += 1) dispatch('redo');
  };

  // ---------------------------------------------------------------------------
  // Workspace files (.glassgrid): only when the platform provides them

  const workspaceFiles = useWorkspaceFiles({ api: workspaceFilesOf(platform), workspace, engine, shell, state, toast: showToast });
  const modal = workspaceFiles.locate !== null;
  /** The latest of both, for the key and menu handlers (subscribed once, not on every render). */
  const latestFiles = useRef({ workspaceFiles, modal });
  useLayoutEffect(() => {
    latestFiles.current = { workspaceFiles, modal };
  });

  // Shortcuts: Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z redoes. Without a native menu (browsers) the page also owns
  // Cmd/Ctrl+O (open a CSV), Shift+Cmd/Ctrl+O (open a workspace), Cmd/Ctrl+S (save) and Shift+Cmd/Ctrl+S (save as);
  // with one (desktop) those are menu accelerators and arrive as menu commands, so each fires once.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { workspaceFiles: files, modal: blocked } = latestFiles.current;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || blocked) return;
      const key = event.key.toLowerCase();
      if (!shell.menuShortcuts && (key === 's' || key === 'o')) {
        if (key === 'o' && !event.shiftKey) {
          event.preventDefault();
          void open();
        } else if (files.enabled) {
          event.preventDefault();
          if (key === 'o') files.open({ source: 'dialog' });
          else files.save(event.shiftKey);
        }
        return;
      }
      if (key !== 'z' || isEditableTarget(event.target)) return;
      event.preventDefault();
      dispatch(event.shiftKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKeyDown);
    // Native menus: File → Open CSV…, the workspace items (each a command), View → Theme.
    const offMenu = shell.onMenuCommand?.((command) => {
      if (command.kind === 'theme') setPreference(command.theme);
      else if (latestFiles.current.modal) return;
      else if (command.kind === 'open') void open();
      else latestFiles.current.workspaceFiles.runMenuCommand(command);
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      offMenu?.();
    };
  }, [dispatch, shell, open, setPreference]);

  // ---------------------------------------------------------------------------
  // Drag and drop: a CSV anywhere on the window opens it; columns go to the charts.

  const onWindowDragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setFileOver(true);
  };
  const onWindowDrop = (event: DragEvent) => {
    setFileOver(false);
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    const file = files.fileFromDrop(event.dataTransfer);
    if (!file) return;
    // A .glassgrid workspace opens as one; anything else is a data file.
    if (workspaceFiles.enabled && isWorkspaceFileName(file.name)) workspaceFiles.openDropped(file);
    else void open(() => files.openDropped(file));
  };

  // ---------------------------------------------------------------------------
  // Render

  const profiled = profile?.table === tableId ? profile : null;
  const profiling = tableId !== null && profiled === null;
  const distinctByColumn = useMemo(
    () => new Map((profiled?.columns ?? []).map((column) => [column.name, column.distinctCount])),
    [profiled],
  );
  const nullsByColumn = useMemo(() => new Map((profiled?.columns ?? []).map((column) => [column.name, formatNulls(column.nullFraction)])), [profiled]);
  // While a new count runs (filters changed), keep showing the last one for this table.
  const rowCount = count?.table === tableId ? count.rowCount : null;
  const totalRows = profiled?.rowCount ?? (filters.length === 0 ? rowCount : null);
  const callers = useMemo(() => chartCallers(history.past), [history.past]);
  const chips = useMemo(() => filterChips(state), [state]);
  const optimizingNow = optimizing && optimizing.table === tableId ? { fraction: optimizing.fraction } : null;

  // Header click: ascending, then descending, then file order.
  const onSortRequest = (column: string) => {
    const current = state.grid.sort[0];
    const sort =
      current?.column !== column
        ? [{ column, direction: 'asc' as const }]
        : current.direction === 'asc'
          ? [{ column, direction: 'desc' as const }]
          : [];
    if (tableId !== null) {
      const start = `${SORT_TO_FIRST_ROWS_MEASURE}:start:${performance.now()}`;
      performance.mark(start);
      if (pendingSort.current) performance.clearMarks(pendingSort.current.start);
      pendingSort.current = { start, table: tableId, sort: sort.map((key) => `${key.column} ${key.direction}`).join(', ') || 'file order' };
    }
    dispatch('sortGrid', { sort });
  };

  const onSelectionChange = (next: IndexSelection | null) => {
    if (__GG_RENDER_PERF__) renderPerf.dispatch();
    dispatch('setSelection', { selection: fromIndexSelection(next, gridColumns) });
  };

  const newChartColumn = (): ColumnState | undefined =>
    state.columns.find((column) => column.name === selectedColumns[0]) ??
    state.columns.find((column) => column.inferredType === 'text') ??
    state.columns.find((column) => !isNumericType(column.inferredType)) ??
    state.columns[0];

  return (
    <div
      className="app"
      data-platform={platform.name}
      data-titlebar-inset={shell.titleBarInset ? '' : undefined}
      data-parquet={tableId === null ? undefined : optimizingNow ? 'converting' : parquetReady.has(tableId) ? 'ready' : 'none'}
      data-testid="app"
      onDragOver={onWindowDragOver}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target || !event.currentTarget.contains(event.relatedTarget as Node | null)) setFileOver(false);
      }}
      onDrop={onWindowDrop}
    >
      {perfRegion('TopBar', <TopBar
        shortcuts={shell.shortcuts}
        titleBarInset={shell.titleBarInset}
        state={state}
        history={history}
        opening={opening}
        optimizing={optimizingNow}
        onOpen={() => void open()}
        onUndo={() => dispatch('undo')}
        onRedo={() => dispatch('redo')}
        onStepTo={stepTo}
        inert={modal}
        workspaceFile={
          workspaceFiles.enabled
            ? {
                edited: workspaceFiles.edited,
                busy: workspaceFiles.busy,
                onSave: () => workspaceFiles.save(false),
                onSaveAs: () => workspaceFiles.save(true),
                onOpen: () => workspaceFiles.open({ source: 'dialog' }),
              }
            : undefined
        }
      />)}

      <main className="workspace" inert={modal}>
        {state.dataSource === null ? (
          <section className="panel empty" aria-label="Open a file" data-testid="empty-state" data-over={fileOver}>
            <div className="empty__zone">
              <div className="empty__icon" aria-hidden="true">
                CSV
              </div>
              <div className="empty__text">
                <h1 className="empty__title">Drop a CSV file here</h1>
                <p className="empty__hint">{files.privacyNote}</p>
              </div>
              <div className="empty__actions">
                <Button variant="primary" size="lg" onClick={() => void open()} disabled={opening} data-testid="open-csv-empty">
                  {opening ? 'Opening…' : 'Open CSV…'}
                </Button>
                <kbd className="gg-kbd">{mod('O')}</kbd>
                {workspaceFiles.enabled && (
                  <Button variant="secondary" size="lg" onClick={() => workspaceFiles.open({ source: 'dialog' })} disabled={workspaceFiles.busy} data-testid="open-workspace-empty">
                    Open workspace…
                  </Button>
                )}
              </div>
              {files.samples !== undefined && files.samples.length > 0 && (
                <>
                  <p className="empty__samples-label" id="empty-samples-label">
                    Or try a sample
                  </p>
                  <ul className="empty__samples" aria-labelledby="empty-samples-label">
                    {files.samples.map((sample) => (
                      <li key={sample.id}>
                        <Button
                          variant="secondary"
                          onClick={() => void open(() => files.openSample?.(sample.id) ?? Promise.resolve({ status: 'cancelled' }))}
                          disabled={opening}
                          data-testid={`sample-${sample.id}`}
                        >
                          {sample.label}
                          {sample.detail !== undefined && <span className="empty__sample-detail">{sample.detail}</span>}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            {workspaceFiles.enabled && (workspaceFiles.recovery.length > 0 || workspaceFiles.recent.length > 0) && (
              <div className="empty__workspaces">
                <RecoveryOffers
                  entries={workspaceFiles.recovery}
                  busy={workspaceFiles.busy}
                  onRestore={workspaceFiles.restoreRecovery}
                  onDiscard={workspaceFiles.discardRecovery}
                />
                <RecentWorkspaces entries={workspaceFiles.recent} busy={workspaceFiles.busy} onOpen={(id) => workspaceFiles.open({ source: 'recent', id })} />
              </div>
            )}
          </section>
        ) : (
          <>
            {perfRegion('ColumnList', <section className="panel columns" aria-label="Columns">
              <div className="panel__head">
                <h2 className="panel__label">Columns</h2>
                <span className="panel__count">{state.columns.length}</span>
                <span className="panel__spacer" />
                <span className="panel__hint">{profiling ? 'Profiling…' : 'distinct'}</span>
              </div>
              <ul
                className="gg-column-list columns__list gg-scroll"
                data-testid="columns"
                onDragStart={(event) => setDraggingColumn((event.target as HTMLElement).dataset['column'] ?? null)}
                onDragEnd={() => setDraggingColumn(null)}
              >
                {state.columns.map((column) => {
                  const distinct = distinctByColumn.get(column.name);
                  return (
                    <ColumnListRow
                      key={column.name}
                      name={column.name}
                      type={effectiveColumnType(column)}
                      inferredType={column.inferredType}
                      distinct={distinct === undefined ? '–' : formatDistinct(distinct)}
                      nulls={nullsByColumn.get(column.name)}
                      profiling={profiling}
                      selected={selectedColumns.includes(column.name)}
                      onTypeChange={(type) => dispatch('setColumnType', { column: column.name, type })}
                      onActivate={() => addChartFor(columnsForChart(column.name))}
                      testId={`column-${column.name}`}
                    />
                  );
                })}
              </ul>
            </section>)}

            {perfRegion('GridPanel', <section className="panel grid-panel" aria-label="Rows">
              <div className="grid-panel__bar">
                {(chips.length > 0 || !profiling) && (
                  <div className="grid-panel__filters">
                    {chips.length > 0 && (
                      <div className="grid-panel__chips" role="list" aria-label="Active filters">
                        {chips.map((chip) => (
                          <div role="listitem" key={chip.id}>
                            <FilterChip
                              column={chip.column}
                              condition={chip.condition}
                              onRemove={() => removeFilter(chip)}
                              testId={`filter-${chip.column}`}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                    <FilterEditor columns={state.columns} {...(selectedColumns[0] === undefined ? {} : { initialColumn: selectedColumns[0] })} onSubmit={addFilter} />
                  </div>
                )}
                {retyping !== null && retyping.table === tableId && retyping.key === overridesKey ? (
                  <span className="grid-panel__note" data-testid="retyping">
                    {retyping.message}
                  </span>
                ) : profiling ? (
                  <span className="grid-panel__note">Showing the first rows while the file is read.</span>
                ) : null}
                <span className="panel__spacer" />
                <div className="grid-panel__count" data-testid="row-count" aria-live="polite">
                  {rowCount === null ? (
                    profiling ? 'Reading…' : ''
                  ) : filters.length > 0 && totalRows !== null ? (
                    <>
                      <strong>{numberFormat.format(rowCount)}</strong> of {numberFormat.format(totalRows)} rows
                    </>
                  ) : (
                    <>
                      <strong>{numberFormat.format(rowCount)}</strong> rows
                    </>
                  )}
                </div>
              </div>
              {grid && (
                <CanvasGrid
                  source={grid.source}
                  columns={gridColumns}
                  tokens={tokens}
                  selection={gridSelection}
                  onSelectionChange={onSelectionChange}
                  sort={state.grid.sort}
                  onSortRequest={onSortRequest}
                  onColumnResize={(column, width) => dispatch('resizeColumn', { column, width: Math.round(width) })}
                  onColumnReorder={(from, to) => {
                    const column = gridColumns[from];
                    if (column) dispatch('reorderColumn', { column: column.name, toIndex: to });
                  }}
                  onCopyRequest={() => dispatch('copySelection')}
                  onFirstRowsPainted={onFirstRowsPainted}
                  label={state.dataSource.fileName}
                  emptyMessage={filters.length > 0 ? 'No rows match the filters' : 'The file has no rows'}
                  testId="grid"
                />
              )}
              {toast && (
                <div className="toast-slot">
                  <Toast
                    key={toast.id}
                    tone={toast.tone}
                    message={toast.message}
                    {...(toast.by === undefined ? {} : { by: toast.by })}
                    {...(toast.action ? { action: toast.action } : {})}
                    onDismiss={dismissToast}
                  />
                </div>
              )}
            </section>)}

            {perfRegion('ChartsPanel', <section
              className="panel charts"
              aria-label="Charts"
              data-over={chartsOver}
              onDragOver={(event) => {
                if (!isColumnDrag(event.dataTransfer)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                setChartsOver(true);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setChartsOver(false);
              }}
              onDrop={(event) => {
                setChartsOver(false);
                const column = draggedColumn(event.dataTransfer);
                if (column === null) return;
                event.preventDefault();
                addChartFor(columnsForChart(column));
              }}
            >
              <div className="panel__head">
                <h2 className="panel__label">Charts</h2>
                <span className="panel__count">{state.charts.length}</span>
                <span className="panel__spacer" />
                <Button
                  variant="ghost"
                  className="gg-button--accent-text"
                  onClick={() => {
                    if (selectedColumns.length >= 1 && selectedColumns.length <= 2) {
                      addChartFor(selectedColumns);
                      return;
                    }
                    const column = newChartColumn();
                    if (column) addChartFor([column.name]);
                  }}
                  data-testid="new-chart"
                >
                  + New chart
                </Button>
              </div>
              <WebGLOverlayProvider className="charts__viewport" testId="charts-viewport">
              <div className="charts__list gg-scroll" ref={chartsListRef}>
                {state.charts.length === 0 && (
                  <div className="charts__drop" data-testid="charts-drop">
                    <strong>Drag a column here to start a chart</strong>
                    <span>
                      {profiling
                        ? 'Charts compute on the full file once reading finishes.'
                        : 'Or focus a column in the list and press Enter.'}
                    </span>
                  </div>
                )}
                {queries.charts.map((query, index) => {
                  const chart = state.charts[index];
                  if (!chart) return null;
                  return perfRegion(`Chart:${chart.spec.mark}`,
                  <ChartView
                    key={chart.id}
                    engine={engine}
                    tableId={tableId}
                    dataVersion={dataVersion}
                    chart={chart}
                    query={query}
                    selection={state.selections[chart.id]}
                    chips={chips.filter((chip) => chip.viewId === chart.id)}
                    columns={state.columns}
                    compileColumns={compileColumns}
                    pixelWidth={pixelWidth}
                    tokens={tokens}
                    addedBy={callers.get(chart.id) ?? 'user'}
                    draggingColumn={draggingColumn}
                    dispatch={dispatch}
                    onBrushStart={onBrushStart}
                    onBrushEnd={onBrushEnd}
                    onDrawn={onChartDrawn}
                    position={{ index, count: state.charts.length }}
                    onRemove={() => {
                      dispatch('removeChart', { chartId: chart.id });
                      showToast({
                        tone: 'info',
                        message: `Removed chart “${chartTitle(chart)}”`,
                        action: { label: 'Undo', shortcut: mod('Z'), onClick: () => dispatch('undo') },
                      });
                    }}
                  />,
                  chart.id);
                })}
              </div>
              </WebGLOverlayProvider>
            </section>)}
          </>
        )}
      </main>
      {state.dataSource === null && toast && (
        <div className="toast-slot toast-slot--window">
          <Toast key={toast.id} tone={toast.tone} message={toast.message} {...(toast.action ? { action: toast.action } : {})} onDismiss={dismissToast} />
        </div>
      )}
      {fileOver && state.dataSource !== null && (
        <div className="drop-overlay" aria-hidden="true">
          Drop to open
        </div>
      )}
      {workspaceFiles.mismatch && (
        <MismatchBanner
          notice={workspaceFiles.mismatch}
          busy={workspaceFiles.busy}
          onLocate={workspaceFiles.relinkData}
          onDismiss={workspaceFiles.dismissMismatch}
        />
      )}
      {workspaceFiles.locate && (
        <LocateDataDialog
          prompt={workspaceFiles.locate}
          busy={workspaceFiles.busy}
          onLocate={workspaceFiles.locateData}
          onCancel={workspaceFiles.cancelLocate}
        />
      )}
    </div>
  );
}
