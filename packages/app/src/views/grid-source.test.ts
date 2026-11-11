import { describe, expect, it, vi } from 'vitest';
import type { Filter, WorkspaceState } from '@glassgrid/core';
import { PAGE_SIZE, type GridColumn, type GridSourceChange } from '@glassgrid/ui';
import { EngineGridSource, gridIntentKey, type GridView } from './grid-source';

/*
 * The grid keeps its place when only what moves on its own changes (L4
 * review): a pan of the map, the time window moving on, a live batch. A
 * brush, a filter, a sort or a switch is a new intent and sends it to the
 * top.
 */

const columns: GridColumn[] = [
  { name: 'ts', type: 'timestamp', width: 160 },
  { name: 'altBaroFt', type: 'integer', width: 100 },
];
const viewport = (west: number) => ({ west, south: 37, east: west + 1, north: 38 });
type IntentState = Parameters<typeof gridIntentKey>[0];
const base: IntentState = {
  grid: { sort: [] },
  charts: [],
  selections: {},
  userFilters: [],
  maps: [{ id: 'map_1', spec: { kind: 'map' }, viewport: viewport(-123) } as WorkspaceState['maps'][number]],
  chartsFollowTime: true,
};

describe('gridIntentKey', () => {
  it('is the same across a pan of the map and a move of the time window; differs for a brush, a filter, a sort, the switches', () => {
    const key = gridIntentKey(base, columns);
    const panned = { ...base, maps: [{ ...base.maps[0], viewport: viewport(-122) }] as IntentState['maps'] };
    expect(gridIntentKey(panned, columns)).toBe(key);
    const brushed: IntentState = { ...base, selections: { chart_1: { source: 'brush', clauses: [{ channel: 'x', filter: { kind: 'range', column: 'altBaroFt', min: 0, max: 10_000, minInclusive: true, maxInclusive: false } }] } } };
    expect(gridIntentKey(brushed, columns)).not.toBe(key);
    const filtered: IntentState = { ...base, userFilters: [{ id: 'f1', filter: { kind: 'in', column: 'category', values: ['A3'] } }] };
    expect(gridIntentKey(filtered, columns)).not.toBe(key);
    expect(gridIntentKey({ ...base, grid: { sort: [{ column: 'altBaroFt', direction: 'desc' }] } }, columns)).not.toBe(key);
    expect(gridIntentKey({ ...base, maps: [{ ...base.maps[0], filterToView: false }] as IntentState['maps'] }, columns)).not.toBe(key);
    expect(gridIntentKey({ ...base, chartsFollowTime: undefined }, columns)).not.toBe(key);
    expect(gridIntentKey(base, [columns[0] as GridColumn, { ...(columns[1] as GridColumn), type: 'text' }])).not.toBe(key);
  });
});

describe('EngineGridSource.update', () => {
  const engine = { pageFetcher: vi.fn(() => () => Promise.reject(new Error('not fetched'))) };
  const view = (filters: Filter[], intent: string | undefined, rowCount: number | null = null): GridView => ({ sort: [], filters, dataVersion: 1, columns, rowCount, intent });
  const window = (max: number): Filter => ({ kind: 'range', column: 'ts', min: max - 300_000, max, minInclusive: false, maxInclusive: true });

  it('a new view with the same intent resets keeping the position (and the old row count until the new one is known)', () => {
    const grid = new EngineGridSource(engine, 'table_1' as never, view([window(1_000_000)], 'a', 52_154));
    const changes: GridSourceChange[] = [];
    grid.source.subscribe((change) => changes.push(change));
    expect(grid.update(view([window(1_010_000)], 'a'))).toBe('reset');
    expect(changes.at(-1)).toEqual({ kind: 'reset', keepPosition: true });
    expect(grid.source.rowCount).toBe(52_154);
    // A new intent: back to the top, one page until the count arrives.
    expect(grid.update(view([window(1_010_000), { kind: 'range', column: 'altBaroFt', min: 0, max: 10_000 } as Filter], 'b'))).toBe('reset');
    expect(changes.at(-1)).toEqual({ kind: 'reset' });
    expect(grid.source.rowCount).toBe(PAGE_SIZE);
    // No intent given: every new view is a new intent.
    grid.update(view([window(1_020_000)], undefined));
    grid.update(view([window(1_030_000)], undefined));
    expect(changes.at(-1)).toEqual({ kind: 'reset' });
  });
});
