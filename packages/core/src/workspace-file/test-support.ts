// Test helpers for workspace files. Not exported from the package.
import type { Fingerprint } from '../protocol/engine.js';
import { WorkspaceStateSchema, type WorkspaceState } from '../state/workspace.js';
import type { SerializeMeta } from './format.js';
import type { OpenedData } from './persisted.js';

export const FINGERPRINT: Fingerprint = {
  sizeBytes: 1_284_533_771,
  mtimeMs: 1_760_000_000_000,
  headTailSha256: '3f1d9c0b6a2e4f8d7c5b3a1908e7d6c5b4a39281706f5e4d3c2b1a0918273645',
  key: '9b2f0c4d1e3a5b7c9d0e1f2a3b4c5d6e',
};

export const HANDLE = 'fh_0123456789abcdef';

/**
 * A realistic workspace over a taxi-trips CSV: a type override, four charts
 * with titles and layout, a brush, a click selection, a grid filter
 * selection, a user filter, grid sort/order/widths, plus the things that
 * must not be saved (profiles, the grid cell selection).
 */
export function taxiWorkspace(): WorkspaceState {
  return WorkspaceStateSchema.parse({
    dataSource: { handleId: HANDLE, fileName: 'trips 2026.csv', fingerprint: FINGERPRINT },
    columns: [
      { name: 'pickup_at', inferredType: 'timestamp', typeOverride: null, profile: { type: 'timestamp', distinctCount: 900_000, nullFraction: 0, min: '2026-01-01 00:00:03', max: '2026-01-31 23:59:58' } },
      { name: 'fare_amount', inferredType: 'float', typeOverride: null, profile: { type: 'float', distinctCount: 4_000, nullFraction: 0.01, min: -52, max: 980.5 } },
      { name: 'passenger_count', inferredType: 'integer', typeOverride: null },
      { name: 'payment_type', inferredType: 'text', typeOverride: null },
      { name: 'vendor_id', inferredType: 'integer', typeOverride: 'text' },
      { name: 'zone "east"', inferredType: 'text', typeOverride: null },
    ],
    charts: [
      { id: 'chart_1', spec: { mark: 'line', x: { column: 'pickup_at', timeUnit: 'day' }, y: { column: 'fare_amount', aggregate: 'sum' } }, title: 'Fares per day' },
      { id: 'chart_2', spec: { mark: 'histogram', x: { column: 'fare_amount', bin: 'auto' } } },
      { id: 'chart_3', spec: { mark: 'bar', x: { column: 'payment_type' }, limit: 20, other: true } },
      { id: 'chart_4', spec: { mark: 'heatmap', x: { column: 'fare_amount', bin: 10 }, y: { column: 'passenger_count', bin: 1 } }, title: 'Fare × passengers' },
    ],
    selections: {
      chart_2: { source: 'brush', clauses: [{ channel: 'x', filter: { kind: 'range', column: 'fare_amount', min: 10, max: 40, maxInclusive: false } }] },
      chart_3: { source: 'click', clauses: [{ channel: 'x', filter: { kind: 'in', column: 'payment_type', values: ['card', 'cash', null] } }] },
      grid: { source: 'filter', clauses: [{ channel: null, filter: { kind: 'notIn', column: 'zone "east"', values: ['Airport'] } }] },
    },
    userFilters: [{ id: 'filter_1', filter: { kind: 'notNull', column: 'passenger_count' } }],
    grid: {
      sort: [{ column: 'fare_amount', direction: 'desc' }, { column: 'pickup_at', direction: 'asc' }],
      columnOrder: ['fare_amount', 'pickup_at'],
      columnWidths: [{ column: 'zone "east"', width: 240 }, { column: 'fare_amount', width: 96 }],
      selection: { anchor: { row: 4, column: 'fare_amount' }, focus: { row: 9, column: 'payment_type' } },
    },
    layout: {
      cards: [
        { chartId: 'chart_1', x: 0, y: 0, w: 2, h: 1 },
        { chartId: 'chart_2', x: 2, y: 0, w: 1, h: 1 },
        { chartId: 'chart_3', x: 0, y: 1, w: 1, h: 1 },
        { chartId: 'chart_4', x: 1, y: 1, w: 2, h: 2 },
      ],
    },
  });
}

/** The data the taxi workspace was saved over, as the engine would report it on open. */
export function taxiData(overrides: Partial<OpenedData> = {}): OpenedData {
  const state = taxiWorkspace();
  return {
    handleId: 'fh_fedcba9876543210' as OpenedData['handleId'],
    fileName: 'trips 2026.csv',
    fingerprint: FINGERPRINT,
    columns: state.columns.map((column) => ({ name: column.name, type: column.inferredType })),
    ...overrides,
  };
}

export const SAVE_META: SerializeMeta = {
  app: { name: 'Glassgrid', version: '1.0.0' },
  savedAt: '2026-10-18T09:30:00.000Z',
  absolutePath: '/Users/ada/data/trips 2026.csv',
  relativePath: '../data/trips 2026.csv',
};

/** The value, or a thrown error naming what was missing (tests may not use `!`). */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`Expected a ${what}`);
  return value;
}
