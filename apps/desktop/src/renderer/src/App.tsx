import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import {
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
  ColumnListRow,
  DataGrid,
  defaultColumnWidth,
  draggedColumn,
  FilterChip,
  isColumnDrag,
  Toast,
  tokensFor,
  type GridColumn,
  type ToastAction,
} from '@glassgrid/ui';
import { openFileAction } from './actions/open-file';
import { chartTitle, describeEntry, filterCondition } from './describe';
import { isAbandoned, type EngineClient, type RowsResult } from './engine-client';
import {
  COUNT_ROWS_MEASURE,
  OPEN_TO_FIRST_PAGE_MEASURE,
  PROFILE_MEASURE,
  type CountRowsMeasureDetail,
  type OpenToFirstPageMeasureDetail,
  type ProfileMeasureDetail,
} from './perf';
import { useTheme } from './theme';
import { ChartView } from './views/ChartView';
import { useGridRows } from './views/grid-data';
import { TopBar } from './views/TopBar';
import type { AppWorkspace } from './workspace';

export { describeEntry };

export interface AppProps {
  engine: Pick<EngineClient, 'open' | 'rows' | 'profile' | 'count' | 'aggregate' | 'onEvent'>;
  bridge: Pick<GlassgridBridge, 'openCsv' | 'openDroppedFile' | 'setTheme' | 'onMenuCommand' | 'platform'>;
  workspace: AppWorkspace;
}

/** Started by an "Open" click or a drop; finished by the first page of the new data source. */
interface PendingOpen {
  start: string;
  table: TableId;
  openEngineMs: number;
  usingParquetCache: boolean;
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
  const [selectedColumns, setSelectedColumns] = useState<readonly string[]>([]);
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

  // ---------------------------------------------------------------------------
  // Views of the data source

  const filters = useMemo(() => Object.values(state.filters), [state.filters]);
  const columnNames = useMemo(() => state.columns.map((column) => column.name), [state.columns]);

  const onPage = useCallback((page: number, result: RowsResult) => {
    if (page !== 0) return;
    const pending = pendingOpen.current;
    if (pending) {
      pendingOpen.current = null;
      measure(OPEN_TO_FIRST_PAGE_MEASURE, pending.start, {
        openEngineMs: pending.openEngineMs,
        firstPageEngineMs: result.engineMs,
        rows: result.table.numRows,
        columns: result.table.numCols,
        usingParquetCache: pending.usingParquetCache,
      } satisfies OpenToFirstPageMeasureDetail);
    }
  }, []);
  const onGridError = useCallback((cause: unknown) => showToast({ tone: 'error', message: messageOf(cause) }), [showToast]);
  // The first page of a new table unlocks the profile and the count, so the full-table scans never delay it.
  const onGridPage = useCallback(
    (page: number, result: RowsResult) => {
      onPage(page, result);
      if (page === 0) setFirstPageTable(tableId);
    },
    [onPage, tableId],
  );
  const grid = useGridRows({ engine, tableId, columns: columnNames, sort: state.grid.sort, filters, onPage: onGridPage, onError: onGridError });

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
  }, [engine, tableId, firstPageTable, showToast]);

  const countKey = tableId === null ? '' : JSON.stringify([tableId, filters]);
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
      const start = `${OPEN_TO_FIRST_PAGE_MEASURE}:start:${performance.now()}`;
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
    [bridge, engine, registry, showToast],
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

  const mod = (key: string) => (bridge.platform === 'darwin' ? `⌘${key}` : `Ctrl+${key}`);

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
  const gridColumns: GridColumn[] = useMemo(
    () =>
      state.columns.map((column) => ({
        name: column.name,
        type: column.inferredType,
        width: defaultColumnWidth(column.name, column.inferredType),
      })),
    [state.columns],
  );
  const callers = useMemo(() => chartCallers(history.past), [history.past]);
  const filterEntries = Object.entries(state.filters);
  const optimizingNow = optimizing && optimizing.table === tableId ? { fraction: optimizing.fraction } : null;

  const onSortColumn = (column: string) => {
    const current = state.grid.sort[0];
    if (current?.column !== column) dispatch('sortGrid', { sort: [{ column, direction: 'asc' }] });
    else if (current.direction === 'asc') dispatch('sortGrid', { sort: [{ column, direction: 'desc' }] });
    else dispatch('sortGrid', { sort: [] });
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
                  <div className="grid-panel__filters" role="list" aria-label="Active filters">
                    {filterEntries.map(([viewId, filter]) => (
                      <FilterChip
                        key={viewId}
                        column={filter.column}
                        condition={filterCondition(filter)}
                        onRemove={() => removeFilter(viewId, filter)}
                        testId={`filter-${filter.column}`}
                      />
                    ))}
                    <Button variant="ghost" size="sm" disabled title="The filter editor arrives with M3; click a bar to filter for now.">
                      + Filter
                    </Button>
                  </div>
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
              <DataGrid
                columns={gridColumns}
                rowCount={rowCount ?? (profiling ? 1_000 : null)}
                getRow={grid.getRow}
                onVisibleRangeChange={grid.requestRange}
                sort={state.grid.sort}
                onSortColumn={onSortColumn}
                onSelectedColumnsChange={setSelectedColumns}
                resetKey={grid.viewKey}
                label={state.dataSource.fileName}
                testId="grid"
              />
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
