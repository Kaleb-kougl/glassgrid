import { useState } from 'react';
import {
  APP_NAME,
  OpenCsvResultSchema,
  formatBytes,
  formatDuration,
  type ColumnProfile,
  type GlassgridBridge,
  type OpenedFile,
  type TableHandle,
} from '@glassgrid/core';
import { Button, Stat } from '@glassgrid/ui';
import type { EngineClient } from './engine-client';
import {
  COUNT_ROWS_MEASURE,
  OPEN_TO_FIRST_PAGE_MEASURE,
  PROFILE_MEASURE,
  type CountRowsMeasureDetail,
  type OpenToFirstPageMeasureDetail,
  type ProfileMeasureDetail,
} from './perf';

type Busy = 'idle' | 'opening' | 'counting';

interface CountResult {
  rowCount: number;
  roundTripMs: number;
  engineMs: number;
}

interface FirstPage {
  rows: number;
  roundTripMs: number;
}

interface AppProps {
  engine: EngineClient;
  bridge: GlassgridBridge;
}

const numberFormat = new Intl.NumberFormat();
const PAGE_ROWS = 1000;

function measure(name: string, start: string, detail: unknown): number {
  const end = `${name}:end`;
  performance.mark(end);
  const entry = performance.measure(name, { start, end, detail });
  performance.clearMarks(start);
  performance.clearMarks(end);
  return entry.duration;
}

function formatScalar(value: ColumnProfile['min']): string {
  if (value === null) return '—';
  if (typeof value === 'number') return numberFormat.format(value);
  return String(value);
}

export function App({ engine, bridge }: AppProps) {
  const [file, setFile] = useState<OpenedFile | null>(null);
  const [table, setTable] = useState<TableHandle | null>(null);
  const [firstPage, setFirstPage] = useState<FirstPage | null>(null);
  const [profile, setProfile] = useState<ColumnProfile[] | null>(null);
  const [busy, setBusy] = useState<Busy>('idle');
  const [result, setResult] = useState<CountResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function openCsv() {
    setBusy('opening');
    setError(null);
    const start = `${OPEN_TO_FIRST_PAGE_MEASURE}:start`;
    performance.mark(start);
    try {
      const outcome = OpenCsvResultSchema.parse(await bridge.openCsv());
      if (outcome.status === 'failed') setError(`Could not open file: ${outcome.message}`);
      if (outcome.status !== 'opened') return;

      setFile(outcome.file);
      setTable(null);
      setFirstPage(null);
      setProfile(null);
      setResult(null);

      const opened = await engine.open(outcome.file.handle);
      const page = await engine.rows(opened.table.id, { offset: 0, limit: PAGE_ROWS }, { viewId: 'grid' });
      const roundTripMs = measure(OPEN_TO_FIRST_PAGE_MEASURE, start, {
        openEngineMs: opened.engineMs,
        firstPageEngineMs: page.engineMs,
        rows: page.table.numRows,
        columns: page.table.numCols,
        usingParquetCache: opened.table.usingParquetCache,
      } satisfies OpenToFirstPageMeasureDetail);
      setTable(opened.table);
      setFirstPage({ rows: page.table.numRows, roundTripMs });
      setBusy('idle');

      const profileStart = `${PROFILE_MEASURE}:start`;
      performance.mark(profileStart);
      const profiled = await engine.profile(opened.table.id, { viewId: 'profile' });
      measure(PROFILE_MEASURE, profileStart, {
        engineMs: profiled.engineMs,
        rowCount: profiled.rowCount,
        columns: profiled.columns.length,
      } satisfies ProfileMeasureDetail);
      setProfile(profiled.columns);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      performance.clearMarks(start);
      setBusy('idle');
    }
  }

  async function countRows() {
    if (!table) return;
    setBusy('counting');
    setError(null);
    const start = `${COUNT_ROWS_MEASURE}:start`;
    try {
      performance.mark(start);
      const { rowCount, engineMs, cached } = await engine.count(table.id, { viewId: 'count' });
      const roundTripMs = measure(COUNT_ROWS_MEASURE, start, {
        rowCount: String(rowCount),
        engineMs,
        cached,
      } satisfies CountRowsMeasureDetail);
      setResult({ rowCount, engineMs, roundTripMs });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      performance.clearMarks(start);
      setBusy('idle');
    }
  }

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
        <Button onClick={() => void countRows()} disabled={!table || busy !== 'idle'} data-testid="count-rows">
          {busy === 'counting' ? 'Counting…' : 'Count rows'}
        </Button>
      </section>

      <section className="app__file" aria-live="polite">
        {file ? (
          <p>
            <span className="app__file-name" data-testid="file-name">
              {file.displayName}
            </span>{' '}
            <span className="app__muted">({formatBytes(file.sizeBytes)})</span>
          </p>
        ) : (
          <p className="app__muted">No file open.</p>
        )}
        {table && firstPage && (
          <p className="app__muted" data-testid="first-page">
            {table.columns.length} columns · first {numberFormat.format(firstPage.rows)} rows in{' '}
            {formatDuration(firstPage.roundTripMs)}
            {table.usingParquetCache ? ' · cached Parquet' : ''}
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

      {profile && (
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
            {profile.map((column) => (
              <tr key={column.name}>
                <td className="app__file-name">{column.name}</td>
                <td>{column.type}</td>
                <td>{(column.nullFraction * 100).toFixed(1)}%</td>
                <td>{numberFormat.format(column.approxDistinct)}</td>
                <td>{formatScalar(column.min)}</td>
                <td>{formatScalar(column.max)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && (
        <p className="app__error" role="alert" data-testid="error">
          {error}
        </p>
      )}
    </main>
  );
}
