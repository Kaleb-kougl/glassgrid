/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { tableFromArrays } from 'apache-arrow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tableIdForFile, toFileHandle, type TableHandle } from '@glassgrid/core';
import { App, type AppProps } from './App';
import { createAppWorkspace } from './workspace';

const handle = toFileHandle('0b6c8f0e-6d0a-4f43-9d3e-2f1f1a0d9c11');
const tableId = tableIdForFile(handle);
const table: TableHandle = {
  id: tableId,
  file: handle,
  fileName: 'trips.csv',
  fingerprint: { sizeBytes: 2048, mtimeMs: 1, headTailSha256: 'a'.repeat(64), key: 'b'.repeat(32) },
  usingParquetCache: false,
  columns: [
    { name: 'id', type: 'integer', duckdbType: 'BIGINT' },
    { name: 'category', type: 'text', duckdbType: 'VARCHAR' },
    { name: 'amount', type: 'float', duckdbType: 'DOUBLE' },
  ],
};

function fakeEngine() {
  const timing = { engineMs: 1, cached: false };
  return {
    open: vi.fn(() => Promise.resolve({ table, engineMs: 3 })),
    rows: vi.fn(() => Promise.resolve({ table: tableFromArrays({ id: Int32Array.from([1, 2]) }), ...timing })),
    profile: vi.fn(() =>
      Promise.resolve({
        rowCount: 2,
        columns: table.columns.map((c) => ({ ...c, nullFraction: 0, distinctCount: 2, min: null, max: null })),
        ...timing,
      }),
    ),
    count: vi.fn(() => Promise.resolve({ rowCount: 2, ...timing })),
    aggregate: vi.fn(() =>
      Promise.resolve({
        table: tableFromArrays({ x: ['alpha', 'bravo'], y: Float64Array.from([7, 5]) }),
        mark: 'bar' as const,
        fellBackToHeatmap: false,
        ...timing,
      }),
    ),
  } satisfies AppProps['engine'];
}

function renderApp() {
  let id = 0;
  const workspace = createAppWorkspace({ clock: () => 1_000, newId: (prefix) => `${prefix}_${++id}` });
  const engine = fakeEngine();
  const bridge = {
    openCsv: () => Promise.resolve({ status: 'opened' as const, file: { handle, displayName: 'trips.csv', sizeBytes: 2048 } }),
  };
  render(<App engine={engine} bridge={bridge} workspace={workspace} />);
  return { engine, workspace };
}

const typeSelect = (column: string) => screen.getByTestId<HTMLSelectElement>(`column-type-${column}`);
const historyEntries = () => screen.queryAllByTestId('history-entry').map((li) => li.textContent);

afterEach(cleanup);

describe('App', () => {
  it('opens a file through the action, edits a column type and undoes it', async () => {
    const { engine } = renderApp();
    fireEvent.click(screen.getByTestId('open-csv'));

    expect(await screen.findByTestId('file-name')).toHaveProperty('textContent', 'trips.csv');
    expect(await screen.findByTestId('first-page')).toHaveProperty('textContent', expect.stringContaining('3 columns'));
    expect(await screen.findByTestId('profile')).toBeTruthy();
    expect(engine.rows).toHaveBeenCalledWith(tableId, { offset: 0, limit: 1000 }, { viewId: 'grid' });
    expect(typeSelect('amount').value).toBe('float');
    expect(historyEntries()).toEqual(['Open trips.csv by you']);
    expect(screen.getByTestId<HTMLButtonElement>('redo').disabled).toBe(true);

    fireEvent.change(typeSelect('amount'), { target: { value: 'text' } });
    expect(typeSelect('amount').value).toBe('text');
    expect(within(screen.getByTestId('column-amount')).getByText('inferred float')).toBeTruthy();
    expect(historyEntries()).toEqual(['Open trips.csv by you', 'Set amount to text by you']);

    fireEvent.click(screen.getByTestId('undo'));
    expect(typeSelect('amount').value).toBe('float');
    expect(historyEntries()).toEqual(['Open trips.csv by you', 'Set amount to text by you (undone)']);

    fireEvent.click(screen.getByTestId('redo'));
    expect(typeSelect('amount').value).toBe('text');
  });

  it('maps Ctrl/Cmd+Z to undo and Shift+Ctrl/Cmd+Z to redo', async () => {
    renderApp();
    fireEvent.click(screen.getByTestId('open-csv'));
    await screen.findByTestId('columns');
    fireEvent.change(typeSelect('id'), { target: { value: 'text' } });

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(typeSelect('id').value).toBe('integer');
    fireEvent.keyDown(window, { key: 'Z', metaKey: true, shiftKey: true });
    expect(typeSelect('id').value).toBe('text');
  });

  it('labels changes made by an AI caller', async () => {
    const { workspace } = renderApp();
    fireEvent.click(screen.getByTestId('open-csv'));
    await screen.findByTestId('columns');
    await act(() => workspace.registry.dispatch('setColumnType', { column: 'amount', type: 'decimal' }, { caller: 'ai' }));
    expect(historyEntries()).toContain('Set amount to decimal by AI');
    expect(typeSelect('amount').value).toBe('decimal');
  });

  it('shows a chart aggregate as a debug table', async () => {
    const { engine } = renderApp();
    fireEvent.click(screen.getByTestId('open-csv'));
    fireEvent.click(await screen.findByTestId('run-aggregate'));

    const result = await screen.findByTestId('aggregate-result');
    expect(engine.aggregate).toHaveBeenCalledWith(tableId, { mark: 'bar', x: { column: 'category' } }, { viewId: 'chart:debug' });
    expect(within(result).getAllByRole('row').map((row) => row.textContent)).toEqual(['xy', 'alpha7', 'bravo5']);
    expect(screen.getByTestId('aggregate-meta').textContent).toMatch(/^bar · 2 rows/);
  });
});
