import { type RangeFilter } from '../spec/filter.js';
import { DEFAULT_TIME_CURSOR, type TimeCursor, type WorkspaceState } from '../state/workspace.js';

/*
 * The time cursor (milestone L4, docs/live-flights-l4.md): the T the views
 * are "as of". The map shows each aircraft at its latest fix ≤ T (its
 * queries already take the data clock as a bound value, sql/map.ts), so a
 * seek is a cheap re-query, never a re-ingest. Charts and the grid describe
 * every loaded fix, unless `chartsFollowTime` narrows them to the window of
 * TIME_FOLLOW_WINDOW_MS up to T.
 */

/** The charts' and grid's window while they follow the cursor: (T − 5 min, T], the length of the map's default trails. */
export const TIME_FOLLOW_WINDOW_MS = 5 * 60_000;

/** The data the cursor can be at: first and last fix (epoch ms). */
export interface TimeRange {
  readonly startMs: number;
  readonly endMs: number;
}

/** The workspace's cursor, or the default (follow the newest data). */
export function timeCursor(state: Pick<WorkspaceState, 'time'>): TimeCursor {
  return state.time ?? DEFAULT_TIME_CURSOR;
}

/**
 * T at wall time `nowMs`, whole milliseconds, clamped to `range`: the end
 * when following the data; `atMs` when paused; `atMs` plus the scaled wall
 * time since `since` when playing. Null while the data's range is unknown.
 */
export function resolveTime(cursor: TimeCursor, range: TimeRange | null, nowMs: number): number | null {
  if (range === null) return null;
  const clamp = (value: number) => Math.floor(Math.min(range.endMs, Math.max(range.startMs, value)));
  switch (cursor.mode) {
    case 'live':
      return Math.floor(range.endMs);
    case 'paused':
      return clamp(cursor.atMs ?? range.endMs);
    case 'playing':
      return clamp((cursor.atMs ?? range.endMs) + Math.max(0, nowMs - (cursor.since ?? nowMs)) * cursor.speed);
  }
}

/** Whether a playing cursor has reached the end of `range` at `nowMs` (the app then pauses it there, or goes live). */
export function playedToEnd(cursor: TimeCursor, range: TimeRange | null, nowMs: number): boolean {
  if (cursor.mode !== 'playing' || range === null) return false;
  return (cursor.atMs ?? range.endMs) + Math.max(0, nowMs - (cursor.since ?? nowMs)) * cursor.speed >= range.endMs;
}

/**
 * The charts' and grid's time filter while they follow the cursor: `time`
 * in (T − TIME_FOLLOW_WINDOW_MS, T] (epoch-ms bounds), or null when they do
 * not (or T is unknown).
 */
export function timeWindowFilter(state: Pick<WorkspaceState, 'chartsFollowTime'>, column: string, atMs: number | null): RangeFilter | null {
  if (state.chartsFollowTime !== true || atMs === null) return null;
  return { kind: 'range', column, min: Math.max(0, atMs - TIME_FOLLOW_WINDOW_MS), max: atMs, minInclusive: false, maxInclusive: true };
}
