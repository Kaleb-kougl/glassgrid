import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  APP_NAME,
  COLUMN_TYPES,
  effectiveColumnType,
  formatBytes,
  formatDuration,
  tableIdForFile,
  type ChartSpecInput,
  type ColumnState,
  type ColumnType,
  type GlassgridBridge,
  type TableColumnProfile,
  type TableId,
  type UndoEntry,
  type WorkspaceState,
} from '@glassgrid/core';
import { Button, Stat } from '@glassgrid/ui';
import { openFileAction } from './actions/open-file';
import { isAbandoned, type EngineClient } from './engine-client';
import {
  AGGREGATE_MEASURE,
  COUNT_ROWS_MEASURE,
  OPEN_TO_FIRST_PAGE_MEASURE,
  PROFILE_MEASURE,
  type AggregateMeasureDetail,
  type CountRowsMeasureDetail,
  type OpenToFirstPageMeasureDetail,
  type ProfileMeasureDetail,
} from './perf';
import type { AppWorkspace } from './workspace';

type Busy = 'idle' | 'opening' | 'counting' | 'aggregating';

interface CountResult {
  rowCount: number;
  roundTripMs: number;
  engineMs: number;
}

interface FirstPage {
  table: TableId;
  rows: number;
  roundTripMs: number | null;
}

interface AggregateDebug {
  table: TableId;
  spec: ChartSpecInput;
  mark: string;
  fellBackToHeatmap: boolean;
  columns: string[];
  rows: string[][];
  engineMs: number;
  roundTripMs: number;
  cached: boolean;
}

/** Started by an "Open CSV" click; finished by the first page of the new data source. */
interface PendingOpen {
  start: string;
  table: TableId;
  openEngineMs: number;
  usingParquetCache: boolean;
}

export interface AppProps {
  engine: Pick<EngineClient, 'open' | 'rows' | 'profile' | 'count' | 'aggregate'>;
  bridge: Pick<GlassgridBridge, 'openCsv'>;
  workspace: AppWorkspace;
}

const numberFormat = new Intl.NumberFormat();
const PAGE_ROWS = 1000;
const DEBUG_ROWS = 50;

function measure(name: string, start: string, detail: unknown): number {
  const end = `${name}:end`;
  performance.mark(end);
  const entry = performance.measure(name, { start, end, detail });
  performance.clearMarks(start);
  performance.clearMarks(end);
  return entry.duration;
}

function formatScalar(value: TableColumnProfile['min']): string {
  if (value === null) return '—';
  if (typeof value === 'number') return numberFormat.format(value);
  return String(value);
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return numberFormat.format(value);
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** One line per undo entry, e.g. `Set amount to text`. */
export function describeEntry(entry: Pick<UndoEntry, 'name' | 'input'>): string {
  const input = (typeof entry.input === 'object' && entry.input !== null ? entry.input : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof input[key] === 'string' ? input[key] : '?');
  switch (entry.name) {
    case 'openFile':
      return `Open ${text('fileName')}`;
    case 'setColumnType':
      return `Set ${text('column')} to ${text('type')}`;
    default:
      return entry.name;
  }
}

/** A bar chart spec for the debug panel: the first text column, counted. */
function debugBarSpec(state: WorkspaceState): ChartSpecInput | null {
  const column = state.columns.find((c) => c.inferredType === 'text') ?? state.columns[0];
  return column ? { mark: 'bar', x: { column: column.name } } : null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

export function App({ engine, bridge, workspace }: AppProps) {
  const { store, registry } = workspace;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const history = useSyncExternalStore(store.subscribe, store.getHistory);

  const tableId = state.dataSource ? tableIdForFile(state.dataSource.handleId) : null;
  const [usingParquet, setUsingParquet] = useState<{ table: TableId; value: boolean } | null>(null);
  const [firstPage, setFirstPage] = useState<FirstPage | null>(null);
  const [profile, setProfile] = useState<{ table: TableId; columns: TableColumnProfile[] } | null>(null);
  const [busy, setBusy] = useState<Busy>('idle');
  const [result, setResult] = useState<CountResult | null>(null);
  const [aggregateDebug, setAggregateDebug] = useState<AggregateDebug | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingOpen = useRef<PendingOpen | null>(null);

  const dispatch = useCallback(
    async (name: string, input?: unknown) => {
      setError(null);
      try {
        await registry.dispatch(name, input, { caller: 'user' });
      } catch (cause) {
        setError(messageOf(cause));
      }
    },
    [registry],
  );

  // Views of the data source: the first grid page, then the profile.
  useEffect(() => {
    if (tableId === null) return;
    const run = { live: true };
    // A function, so TypeScript does not narrow `run.live` across awaits.
    const stale = () => !run.live;
    void (async () => {
      try {
        const page = await engine.rows(tableId, { offset: 0, limit: PAGE_ROWS }, { viewId: 'grid' });
        if (stale()) return;
        let roundTripMs: number | null = null;
        const pending = pendingOpen.current;
        if (pending?.table === tableId) {
          pendingOpen.current = null;
          roundTripMs = measure(OPEN_TO_FIRST_PAGE_MEASURE, pending.start, {
            openEngineMs: pending.openEngineMs,
            firstPageEngineMs: page.engineMs,
            rows: page.table.numRows,
            columns: page.table.numCols,
            usingParquetCache: pending.usingParquetCache,
          } satisfies OpenToFirstPageMeasureDetail);
        }
        setFirstPage({ table: tableId, rows: page.table.numRows, roundTripMs });

        const profileStart = `${PROFILE_MEASURE}:start:${tableId}`;
        performance.mark(profileStart);
        const profiled = await engine.profile(tableId, { viewId: 'profile' });
        if (stale()) return;
        measure(PROFILE_MEASURE, profileStart, {
          engineMs: profiled.engineMs,
          rowCount: profiled.rowCount,
          columns: profiled.columns.length,
        } satisfies ProfileMeasureDetail);
        setProfile({ table: tableId, columns: profiled.columns });
      } catch (cause) {
        if (!stale() && !isAbandoned(cause)) setError(messageOf(cause));
      }
    })();
    return () => {
      run.live = false;
    };
  }, [engine, tableId]);

  // Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z redoes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z') return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      void dispatch(event.shiftKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dispatch]);

  async function openCsv() {
    setBusy('opening');
    setError(null);
    const start = `${OPEN_TO_FIRST_PAGE_MEASURE}:start:${performance.now()}`;
    performance.mark(start);
    try {
      const outcome = await openFileAction({
        bridge,
        engine,
        registry,
        // Armed before `openFile` changes the state, so the first-page view always finds it.
        onEngineOpened: (table, openEngineMs) => {
          pendingOpen.current = { start, table: table.id, openEngineMs, usingParquetCache: table.usingParquetCache };
        },
      });
      if (outcome.status !== 'opened') {
        performance.clearMarks(start);
        return;
      }
      setUsingParquet({ table: outcome.table.id, value: outcome.table.usingParquetCache });
      setResult(null);
      setAggregateDebug(null);
    } catch (cause) {
      pendingOpen.current = null;
      performance.clearMarks(start);
      setError(messageOf(cause));
    } finally {
      setBusy('idle');
    }
  }

  async function countRows() {
    if (!tableId) return;
    setBusy('counting');
    setError(null);
    const start = `${COUNT_ROWS_MEASURE}:start`;
    try {
      performance.mark(start);
      const { rowCount, engineMs, cached } = await engine.count(tableId, { viewId: 'count' });
      const roundTripMs = measure(COUNT_ROWS_MEASURE, start, {
        rowCount: String(rowCount),
        engineMs,
        cached,
      } satisfies CountRowsMeasureDetail);
      setResult({ rowCount, engineMs, roundTripMs });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      performance.clearMarks(start);
      setBusy('idle');
    }
  }

  async function runAggregate() {
    const spec = debugBarSpec(state);
    if (!tableId || !spec) return;
    setBusy('aggregating');
    setError(null);
    const start = `${AGGREGATE_MEASURE}:start`;
    try {
      performance.mark(start);
      const reply = await engine.aggregate(tableId, spec, { viewId: 'chart:debug' });
      const roundTripMs = measure(AGGREGATE_MEASURE, start, {
        engineMs: reply.engineMs,
        cached: reply.cached,
        mark: reply.mark,
        rows: reply.table.numRows,
      } satisfies AggregateMeasureDetail);
      const columns = reply.table.schema.fields.map((field) => field.name);
      const rows = reply.table
        .toArray()
        .slice(0, DEBUG_ROWS)
        .map((row: Record<string, unknown>) => columns.map((name) => formatCell(row[name])));
      setAggregateDebug({
        table: tableId,
        spec,
        mark: reply.mark,
        fellBackToHeatmap: reply.fellBackToHeatmap,
        columns,
        rows,
        engineMs: reply.engineMs,
        roundTripMs,
        cached: reply.cached,
      });
    } catch (cause) {
      if (!isAbandoned(cause)) setError(messageOf(cause));
    } finally {
      performance.clearMarks(start);
      setBusy('idle');
    }
  }

  const page = firstPage && firstPage.table === tableId ? firstPage : null;
  const profiled = profile && profile.table === tableId ? profile.columns : null;
  const debug = aggregateDebug && aggregateDebug.table === tableId ? aggregateDebug : null;

  return (
    <main className="app">
      <header className="app__header">
        <h1>{APP_NAME}</h1>
        <p className="app__tagline">Local CSV exploration, powered by DuckDB.</p>
      </header>

      <section className="app__toolbar" aria-label="Actions">
        <Button variant="primary" onClick={() => void openCsv()} disabled={busy !== 'idle'} data-testid="open-csv">
          {busy === 'opening' ? 'Opening…' : 'Open CSV'}
        </Button>
        <Button onClick={() => void countRows()} disabled={!tableId || busy !== 'idle'} data-testid="count-rows">
          {busy === 'counting' ? 'Counting…' : 'Count rows'}
        </Button>
        <Button
          onClick={() => void dispatch('undo')}
          disabled={history.past.length === 0}
          data-testid="undo"
          title="Undo (Ctrl+Z / ⌘Z)"
        >
          Undo
        </Button>
        <Button
          onClick={() => void dispatch('redo')}
          disabled={history.future.length === 0}
          data-testid="redo"
          title="Redo (Shift+Ctrl+Z / ⇧⌘Z)"
        >
          Redo
        </Button>
      </section>

      <section className="app__file" aria-live="polite">
        {state.dataSource ? (
          <p>
            <span className="app__file-name" data-testid="file-name">
              {state.dataSource.fileName}
            </span>{' '}
            <span className="app__muted">({formatBytes(state.dataSource.fingerprint.sizeBytes)})</span>
          </p>
        ) : (
          <p className="app__muted">No file open.</p>
        )}
        {page && (
          <p className="app__muted" data-testid="first-page">
            {state.columns.length} columns · first {numberFormat.format(page.rows)} rows
            {page.roundTripMs === null ? '' : ` in ${formatDuration(page.roundTripMs)}`}
            {usingParquet?.table === tableId && usingParquet.value ? ' · cached Parquet' : ''}
          </p>
        )}
      </section>

      {result && (
        <dl className="app__stats" data-testid="count-result">
          <Stat label="Rows" value={numberFormat.format(result.rowCount)} testId="row-count" />
          <Stat label="Round trip" value={formatDuration(result.roundTripMs)} testId="elapsed-ms" />
          <Stat label="Engine" value={formatDuration(result.engineMs)} testId="engine-ms" />
        </dl>
      )}

      {state.columns.length > 0 && (
        <section aria-label="Columns">
          <h2 className="app__section-title">Columns</h2>
          <ul className="app__columns" data-testid="columns">
            {state.columns.map((column) => (
              <ColumnRow
                key={column.name}
                column={column}
                onChange={(type) => void dispatch('setColumnType', { column: column.name, type })}
              />
            ))}
          </ul>
        </section>
      )}

      {(history.past.length > 0 || history.future.length > 0) && (
        <section aria-label="History">
          <h2 className="app__section-title">History</h2>
          <ol className="app__history" data-testid="history">
            {history.past.map((entry) => (
              <HistoryItem key={entry.id} entry={entry} undone={false} />
            ))}
            {[...history.future].reverse().map((entry) => (
              <HistoryItem key={entry.id} entry={entry} undone />
            ))}
          </ol>
        </section>
      )}

      {profiled && (
        <table className="app__profile" data-testid="profile">
          <thead>
            <tr>
              <th scope="col">Column</th>
              <th scope="col">Type</th>
              <th scope="col">Nulls</th>
              <th scope="col">Distinct (approx.)</th>
              <th scope="col">Min</th>
              <th scope="col">Max</th>
            </tr>
          </thead>
          <tbody>
            {profiled.map((column) => (
              <tr key={column.name}>
                <td className="app__file-name">{column.name}</td>
                <td>{column.type}</td>
                <td>{(column.nullFraction * 100).toFixed(1)}%</td>
                <td>{numberFormat.format(column.distinctCount)}</td>
                <td>{formatScalar(column.min)}</td>
                <td>{formatScalar(column.max)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tableId && (
        <section aria-label="Chart query (debug)">
          <h2 className="app__section-title">Chart query (debug)</h2>
          <Button onClick={() => void runAggregate()} disabled={busy !== 'idle'} data-testid="run-aggregate">
            {busy === 'aggregating' ? 'Running…' : 'Run bar chart query'}
          </Button>
          {debug && (
            <div data-testid="aggregate-result">
              <p className="app__muted" data-testid="aggregate-meta">
                {debug.mark}
                {debug.fellBackToHeatmap ? ' (scatter fell back to heatmap)' : ''} · {debug.rows.length} rows ·{' '}
                {formatDuration(debug.roundTripMs)} (engine {formatDuration(debug.engineMs)}
                {debug.cached ? ', cached' : ''})
              </p>
              <pre className="app__spec" data-testid="aggregate-spec">
                {JSON.stringify(debug.spec)}
              </pre>
              <table className="app__profile">
                <thead>
                  <tr>
                    {debug.columns.map((name) => (
                      <th key={name} scope="col">
                        {name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {debug.rows.map((cells, i) => (
                    <tr key={i}>
                      {cells.map((cell, j) => (
                        <td key={j}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {error && (
        <p className="app__error" role="alert" data-testid="error">
          {error}
        </p>
      )}
    </main>
  );
}

function ColumnRow({ column, onChange }: { column: ColumnState; onChange: (type: ColumnType) => void }) {
  const type = effectiveColumnType(column);
  return (
    <li className="app__column" data-testid={`column-${column.name}`}>
      <span className="app__file-name">{column.name}</span>
      <select
        aria-label={`Type of ${column.name}`}
        data-testid={`column-type-${column.name}`}
        value={type}
        onChange={(event) => onChange(event.target.value as ColumnType)}
      >
        {COLUMN_TYPES.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {column.typeOverride !== null && <span className="app__muted">inferred {column.inferredType}</span>}
    </li>
  );
}

function HistoryItem({ entry, undone }: { entry: UndoEntry; undone: boolean }) {
  return (
    <li className={undone ? 'app__history-undone' : undefined} data-testid="history-entry" data-undone={undone}>
      {describeEntry(entry)}{' '}
      <span className="app__muted" data-testid="history-caller">
        {entry.caller === 'ai' ? 'by AI' : 'by you'}
      </span>
      {undone && <span className="app__muted"> (undone)</span>}
    </li>
  );
}
