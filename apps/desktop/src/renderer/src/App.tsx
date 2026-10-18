import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import {
  CommandError,
  effectiveColumnType,
  isNumericType,
  tableIdForFile,
  type ChartSpecInput,
  type ColumnState,
  type Filter,
  type GlassgridBridge,
  type TableColumnProfile,
  type TableId,
  type UndoEntry,
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
  type GridSelection as IndexSelection,
  type ToastAction,
} from '@glassgrid/ui';
import { openFileAction } from './actions/open-file';
import { chartTitle, describeEntry, filterCondition } from './describe';
import { isAbandoned, type EngineClient, type RowsResult } from './engine-client';
import {
  COUNT_ROWS_MEASURE,
  OPEN_TO_FIRST_ROWS_MEASURE,
  PROFILE_MEASURE,
  SORT_TO_FIRST_ROWS_MEASURE,
  type CountRowsMeasureDetail,
  type OpenToFirstRowsMeasureDetail,
  type ProfileMeasureDetail,
  type SortToFirstRowsMeasureDetail,
} from './perf';
import { useTheme } from './theme';
import { ChartView } from './views/ChartView';
import {
  displayColumns,
  EngineGridSource,
  fromIndexSelection,
  selectedColumnNames,
  sourceColumns,
  toIndexSelection,
} from './views/grid-source';
import { TopBar } from './views/TopBar';
import type { AppWorkspace } from './workspace';

export { describeEntry };

export interface AppProps {
  engine: Pick<
    EngineClient,
    'open' | 'pageFetcher' | 'profile' | 'count' | 'aggregate' | 'onEvent' | 'onRestarted' | 'setColumnTypes' | 'closeTable'
  >;
  bridge: Pick<GlassgridBridge, 'openCsv' | 'openDroppedFile' | 'setTheme' | 'onMenuCommand' | 'platform' | 'clipboard'>;
  workspace: AppWorkspace;
}

/** Started by an "Open" click or a drop; finished by the first rows of the new data source painted. */
interface PendingOpen {
  start: string;
  table: TableId;
  openEngineMs: number;
  usingParquetCache: boolean;
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

/** A bar chart over `column`, the v1 default for a dropped column (other marks arrive in M3). */
export function barSpecFor(column: string): ChartSpecInput {
  return { mark: 'bar', x: { column } };
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

export function App({ engine, bridge, workspace }: AppProps) {
  const { store, registry } = workspace;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const history = useSyncExternalStore(store.subscribe, store.getHistory);
  const { theme, setPreference } = useTheme(bridge);
  const tokens = tokensFor(theme);

  const tableId = state.dataSource ? tableIdForFile(state.dataSource.handleId) : null;
  const [opening, setOpening] = useState(false);
  const [firstPageTable, setFirstPageTable] = useState<TableId | null>(null);
  const [profile, setProfile] = useState<{ table: TableId; rowCount: number; columns: TableColumnProfile[] } | null>(null);
  const [count, setCount] = useState<{ table: TableId; key: string; rowCount: number } | null>(null);
  const [optimizing, setOptimizing] = useState<{ table: TableId; fraction: number | null } | null>(null);
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
  const mod = (key: string) => (bridge.platform === 'darwin' ? `⌘${key}` : `Ctrl+${key}`);

  // ---------------------------------------------------------------------------
  // Views of the data source

  const filters = useMemo(() => Object.values(state.filters), [state.filters]);
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
  useLayoutEffect(() => {
    grid?.update(view);
  }, [grid, view]);
  useEffect(() => () => grid?.cancel(), [grid]);

  // The first page of a view: the open/sort measures read its engine time; the first one unlocks the profile and the count.
  const firstPage = useRef<{ table: TableId; result: RowsResult } | null>(null);
  useLayoutEffect(() => {
    if (!grid) return;
    const table = grid.table;
    const offPage = grid.onFirstPage((result) => {
      firstPage.current = { table, result };
      setFirstPageTable(table);
    });
    const offErrors = grid.source.subscribe((change) => {
      if (change.kind === 'error' && !isAbandoned(change.error)) showToast({ tone: 'error', message: messageOf(change.error) });
    });
    return () => {
      offPage();
      offErrors();
    };
  }, [grid, showToast]);

  const pendingSort = useRef<PendingSort | null>(null);
  const onFirstRowsPainted = useCallback(() => {
    const page = firstPage.current;
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
  }, []);

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
  useEffect(() => {
    const onPageHide = () => {
      if (shownTable.current !== null) void engine.closeTable(shownTable.current).catch(() => undefined);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [engine]);

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
            action: { label: 'Undo', shortcut: mod('Z'), onClick: () => dispatch('undo') },
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

  // copySelection: the selection as TSV, through the preload's clipboard.
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
        await bridge.clipboard.writeText(result.text);
        showToast({ tone: 'info', message: result.message });
        return { rows: result.rows, columns: result.columns, selectedRows: result.selectedRows, truncated: result.truncated, message: result.message };
      }),
    [registry, bridge, showToast],
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
      },
      (cause: unknown) => {
        if (run.live && !isAbandoned(cause)) showToast({ tone: 'error', message: messageOf(cause) });
      },
    );
    return () => {
      run.live = false;
    };
  }, [engine, tableId, firstPageTable, dataVersion, showToast]);

  useEffect(() => {
    if (tableId === null || firstPageTable !== tableId) return;
    const run = { live: true };
    const start = `${COUNT_ROWS_MEASURE}:start:${countKey}`;
    performance.mark(start);
    engine.count(tableId, { viewId: 'status', filters }).then(
      (result) => {
        if (!run.live) return;
        measure(COUNT_ROWS_MEASURE, start, {
          rowCount: String(result.rowCount),
          engineMs: result.engineMs,
          cached: result.cached,
        } satisfies CountRowsMeasureDetail);
        setCount({ table: tableId, key: countKey, rowCount: result.rowCount });
      },
      (cause: unknown) => {
        performance.clearMarks(start);
        if (run.live && !isAbandoned(cause)) showToast({ tone: 'error', message: messageOf(cause) });
      },
    );
    return () => {
      run.live = false;
    };
  }, [engine, tableId, firstPageTable, countKey, filters, showToast]);

  // "Optimizing file": the engine's background Parquet conversion of large CSVs.
  useEffect(
    () =>
      engine.onEvent((event) => {
        if (event.type === 'parquetProgress') setOptimizing({ table: event.table, fraction: event.fraction });
        else if (event.type === 'parquetReady' || event.type === 'parquetFailed') setOptimizing(null);
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
          bridge,
          engine,
          registry,
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
    [bridge, engine, registry, showToast, setOpening],
  );

  useEffect(() => {
    retryOpen.current = open;
  }, [open]);

  const addChartFor = useCallback(
    (column: string) => {
      dispatch('addChart', { spec: barSpecFor(column) });
    },
    [dispatch],
  );


  const removeFilter = (viewId: string, filter: Filter) => {
    dispatch('clearFilter', { viewId });
    showToast({ tone: 'info', message: `Removed filter ${filter.column}`, action: { label: 'Undo', shortcut: mod('Z'), onClick: () => dispatch('undo') } });
  };

  const stepTo = (entryId: string) => {
    const { past, future } = store.getHistory();
    const back = past.length - 1 - past.findIndex((entry) => entry.id === entryId);
    const forward = future.findIndex((entry) => entry.id === entryId) + 1;
    if (back > 0 && back < past.length) for (let i = 0; i < back; i += 1) dispatch('undo');
    else if (forward > 0) for (let i = 0; i < forward; i += 1) dispatch('redo');
  };

  // Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z redoes; menu commands (File → Open, View → Theme).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z') return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      dispatch(event.shiftKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKeyDown);
    const offMenu = bridge.onMenuCommand((command) => {
      if (command.kind === 'open') void open();
      else setPreference(command.theme);
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      offMenu();
    };
  }, [dispatch, bridge, open, setPreference]);

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
    const file = event.dataTransfer.files[0];
    if (file) void open(() => bridge.openDroppedFile(file));
  };

  // ---------------------------------------------------------------------------
  // Render

  const profiled = profile?.table === tableId ? profile : null;
  const profiling = tableId !== null && profiled === null;
  const distinctByColumn = useMemo(
    () => new Map((profiled?.columns ?? []).map((column) => [column.name, column.distinctCount])),
    [profiled],
  );
  // While a new count runs (filters changed), keep showing the last one for this table.
  const rowCount = count?.table === tableId ? count.rowCount : null;
  const totalRows = profiled?.rowCount ?? (filters.length === 0 ? rowCount : null);
  const callers = useMemo(() => chartCallers(history.past), [history.past]);
  const filterEntries = Object.entries(state.filters);
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
      data-platform={bridge.platform}
      data-testid="app"
      onDragOver={onWindowDragOver}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target || !event.currentTarget.contains(event.relatedTarget as Node | null)) setFileOver(false);
      }}
      onDrop={onWindowDrop}
    >
      <TopBar
        platform={bridge.platform}
        state={state}
        history={history}
        opening={opening}
        optimizing={optimizingNow}
        onOpen={() => void open()}
        onUndo={() => dispatch('undo')}
        onRedo={() => dispatch('redo')}
        onStepTo={stepTo}
      />

      <main className="workspace">
        {state.dataSource === null ? (
          <section className="panel empty" aria-label="Open a file" data-testid="empty-state" data-over={fileOver}>
            <div className="empty__zone">
              <div className="empty__icon" aria-hidden="true">
                CSV
              </div>
              <div className="empty__text">
                <h1 className="empty__title">Drop a CSV file here</h1>
                <p className="empty__hint">The file is read on this computer and never uploaded.</p>
              </div>
              <div className="empty__actions">
                <Button variant="primary" size="lg" onClick={() => void open()} disabled={opening} data-testid="open-csv-empty">
                  {opening ? 'Opening…' : 'Open CSV…'}
                </Button>
                <kbd className="gg-kbd">{mod('O')}</kbd>
              </div>
            </div>
          </section>
        ) : (
          <>
            <section className="panel columns" aria-label="Columns">
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
                      profiling={profiling}
                      selected={selectedColumns.includes(column.name)}
                      onTypeChange={(type) => dispatch('setColumnType', { column: column.name, type })}
                      onActivate={() => addChartFor(column.name)}
                      testId={`column-${column.name}`}
                    />
                  );
                })}
              </ul>
            </section>

            <section className="panel grid-panel" aria-label="Rows">
              <div className="grid-panel__bar">
                {filterEntries.length > 0 ? (
                  <div className="grid-panel__filters">
                    <div className="grid-panel__chips" role="list" aria-label="Active filters">
                      {filterEntries.map(([viewId, filter]) => (
                        <div role="listitem" key={viewId}>
                          <FilterChip
                            column={filter.column}
                            condition={filterCondition(filter)}
                            onRemove={() => removeFilter(viewId, filter)}
                            testId={`filter-${filter.column}`}
                          />
                        </div>
                      ))}
                    </div>
                    <Button variant="ghost" size="sm" disabled title="The filter editor arrives with M3; click a bar to filter for now.">
                      + Filter
                    </Button>
                  </div>
                ) : retyping !== null && retyping.table === tableId && retyping.key === overridesKey ? (
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
            </section>

            <section
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
                addChartFor(column);
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
                    const column = newChartColumn();
                    if (column) addChartFor(column.name);
                  }}
                  data-testid="new-chart"
                >
                  + New chart
                </Button>
              </div>
              <div className="charts__list gg-scroll">
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
                {state.charts.map((chart) => (
                  <ChartView
                    key={chart.id}
                    engine={engine}
                    tableId={tableId}
                    dataVersion={dataVersion}
                    chart={chart}
                    selection={state.filters[chart.id]}
                    crossFilters={filterEntries.filter(([viewId]) => viewId !== chart.id).map(([, filter]) => filter)}
                    columns={state.columns}
                    tokens={tokens}
                    addedBy={callers.get(chart.id) ?? 'user'}
                    draggingColumn={draggingColumn}
                    dispatch={dispatch}
                    onRemove={() => {
                      dispatch('removeChart', { chartId: chart.id });
                      showToast({
                        tone: 'info',
                        message: `Removed chart “${chartTitle(chart)}”`,
                        action: { label: 'Undo', shortcut: mod('Z'), onClick: () => dispatch('undo') },
                      });
                    }}
                  />
                ))}
              </div>
            </section>
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
    </div>
  );
}
