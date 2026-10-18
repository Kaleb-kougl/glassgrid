import type { Draft } from 'immer';
import type { ChartState, WorkspaceState } from '../../state/workspace.js';
import { CommandError } from '../errors.js';

const MAX_LISTED = 20;

function listed(names: readonly string[]): string {
  const shown = names.slice(0, MAX_LISTED).map((name) => JSON.stringify(name));
  const more = names.length > MAX_LISTED ? `, … (${names.length} in total)` : '';
  return `${shown.join(', ')}${more}`;
}

/** Throws a `precondition_failed` naming the known columns unless `column` exists. */
export function requireColumn(
  state: Draft<WorkspaceState> | WorkspaceState,
  column: string,
  command: string,
  path: string,
): void {
  if (state.columns.some((candidate) => candidate.name === column)) return;
  if (state.columns.length === 0) {
    throw new CommandError('precondition_failed', 'No file is open, so there are no columns', {
      command,
      issues: [{ path, message: 'No file is open' }],
    });
  }
  throw new CommandError(
    'precondition_failed',
    `Unknown column ${JSON.stringify(column)}; columns are ${listed(state.columns.map((c) => c.name))}`,
    { command, issues: [{ path, message: 'Unknown column' }] },
  );
}

/** Throws a `precondition_failed` listing the chart ids unless the chart exists; returns it. */
export function requireChart(state: Draft<WorkspaceState>, chartId: string, command: string): Draft<ChartState> {
  const chart = state.charts.find((candidate) => candidate.id === chartId);
  if (chart !== undefined) return chart;
  const known = state.charts.map((candidate) => candidate.id);
  throw new CommandError(
    'precondition_failed',
    known.length === 0
      ? `Unknown chart ${JSON.stringify(chartId)}; there are no charts`
      : `Unknown chart ${JSON.stringify(chartId)}; charts are ${listed(known)}`,
    { command, issues: [{ path: 'chartId', message: 'Unknown chart' }] },
  );
}
