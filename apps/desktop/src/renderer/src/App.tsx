import { useState } from 'react';
import {
  APP_NAME,
  OpenCsvResultSchema,
  formatBytes,
  formatDuration,
  type GlassgridBridge,
  type OpenedFile,
} from '@glassgrid/core';
import { Button, Stat } from '@glassgrid/ui';
import type { EngineClient } from './engine-client';
import { COUNT_ROWS_MEASURE, type CountRowsMeasureDetail } from './perf';

type Busy = 'idle' | 'opening' | 'counting';

interface CountResult {
  rowCount: bigint;
  roundTripMs: number;
  engineMs: number;
}

interface AppProps {
  engine: EngineClient;
  bridge: GlassgridBridge;
}

const numberFormat = new Intl.NumberFormat();

export function App({ engine, bridge }: AppProps) {
  const [file, setFile] = useState<OpenedFile | null>(null);
  const [busy, setBusy] = useState<Busy>('idle');
  const [result, setResult] = useState<CountResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function openCsv() {
    setBusy('opening');
    setError(null);
    try {
      const outcome = OpenCsvResultSchema.parse(await bridge.openCsv());
      if (outcome.status === 'opened') {
        setFile(outcome.file);
        setResult(null);
      } else if (outcome.status === 'failed') {
        setError(`Could not open file: ${outcome.message}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('idle');
    }
  }

  async function countRows() {
    if (!file) return;
    setBusy('counting');
    setError(null);
    const start = `${COUNT_ROWS_MEASURE}:start`;
    const end = `${COUNT_ROWS_MEASURE}:end`;
    try {
      performance.mark(start);
      const { rowCount, engineMs } = await engine.countRows(file.handle);
      performance.mark(end);
      const measure = performance.measure(COUNT_ROWS_MEASURE, {
        start,
        end,
        detail: { rowCount: rowCount.toString(), engineMs } satisfies CountRowsMeasureDetail,
      });
      setResult({ rowCount, engineMs, roundTripMs: measure.duration });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      performance.clearMarks(start);
      performance.clearMarks(end);
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
        <Button onClick={() => void countRows()} disabled={!file || busy !== 'idle'} data-testid="count-rows">
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
      </section>

      {result && (
        <dl className="app__stats" data-testid="count-result">
          <Stat label="Rows" value={numberFormat.format(result.rowCount)} testId="row-count" />
          <Stat label="Round trip" value={formatDuration(result.roundTripMs)} testId="elapsed-ms" />
          <Stat label="Engine" value={formatDuration(result.engineMs)} testId="engine-ms" />
        </dl>
      )}

      {error && (
        <p className="app__error" role="alert" data-testid="error">
          {error}
        </p>
      )}
    </main>
  );
}
