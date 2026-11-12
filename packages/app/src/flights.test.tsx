/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveSourceState, LiveState } from '@glassgrid/core';
import { feedStatusLine, shortFeedError, useLiveState } from './flights';
import { altitudeText } from './views/AircraftDetails';

/*
 * The live feed's state in the app (useLiveState). Regression (L4 review):
 * after the flights workspace was undone (the live table closed) and opened
 * again on another source, the hook kept the old source's state and
 * refused the engine's fresh answer because its data clock was earlier, so
 * the top bar showed the day's 1,456,777 rows on a 71,595-row half hour for
 * good (an archive sends one batch). Data clocks go backwards whenever the
 * source changes; messages arrive in order on one port, so the last one
 * received is the newest.
 */

const DAY_END = Date.parse('2026-11-09T23:59:59.980Z');
const HALF_END = Date.parse('2026-11-09T23:57:59.990Z');

function archive(fixture: 'flights-bay-30min' | 'flights-bay-day', end: number, rows: number): LiveState {
  return {
    source: { kind: 'archive', fixture },
    feed: { kind: 'archive', status: 'live', paused: false, attribution: null, license: null, lastSuccessAt: 1, dataClockMs: end, nextAttemptAt: null, failures: 0, error: null, ended: false },
    rowCount: rows,
    lastBatch: { received: rows, inserted: rows, expired: 0, dataClockMs: end },
    ingestError: null,
  };
}

function fakeLive(initial: LiveState) {
  const listeners = new Set<(state: LiveState) => void>();
  let current = initial;
  const answers: ((state: LiveState) => void)[] = [];
  return {
    set: (state: LiveState) => {
      current = state;
    },
    emit: (state: LiveState) => {
      current = state;
      for (const listener of listeners) listener(state);
    },
    /** Hold `state()` answers until `answer()` (to order them against events). */
    hold: false,
    answer: () => answers.splice(0).forEach((resolve) => resolve(current)),
    api: {
      onState: (listener: (state: LiveState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      state: vi.fn(() => new Promise<LiveState>((resolve) => answers.push(resolve))),
      start: vi.fn(),
      stop: vi.fn(),
      setSource: vi.fn(),
      setVisible: vi.fn(),
    },
  };
}

afterEach(() => cleanup());

describe('useLiveState', () => {
  it('reopened on another source, it takes the engine’s answer even when its data clock is earlier', async () => {
    const live = fakeLive(archive('flights-bay-day', DAY_END, 1_456_777));
    const engine = { live: live.api } as never;
    const { result, rerender } = renderHook(({ active }: { active: boolean }) => useLiveState(engine, active), { initialProps: { active: true } });
    act(() => live.answer());
    await waitFor(() => expect(result.current?.rowCount).toBe(1_456_777));
    // The workspace is undone: the live table closes, and the hook says nothing.
    rerender({ active: false });
    expect(result.current).toBeNull();
    // The flights sample again: the feed now holds the half hour (an earlier data clock).
    live.set(archive('flights-bay-30min', HALF_END, 71_595));
    rerender({ active: true });
    expect(result.current).toBeNull();
    act(() => live.answer());
    await waitFor(() => expect(result.current?.rowCount).toBe(71_595));
    expect(result.current?.source).toEqual({ kind: 'archive', fixture: 'flights-bay-30min' });
  });

  it('the last message received wins: an event after the answer replaces it, an answer after an event too', async () => {
    const live = fakeLive(archive('flights-bay-30min', HALF_END, 71_595));
    const engine = { live: live.api } as never;
    const { result } = renderHook(() => useLiveState(engine, true));
    // An event (the day loading's first state) arrives before the answer, which is newer: the answer wins.
    act(() => live.emit(archive('flights-bay-day', DAY_END, 0)));
    expect(result.current?.rowCount).toBe(0);
    live.set(archive('flights-bay-30min', HALF_END, 71_595));
    act(() => live.answer());
    await waitFor(() => expect(result.current?.rowCount).toBe(71_595));
    // A later event wins over it, whatever its clock.
    act(() => live.emit(archive('flights-bay-day', DAY_END, 1_456_777)));
    expect(result.current?.rowCount).toBe(1_456_777);
  });
});

describe('shortFeedError', () => {
  it('drops the endpoint it starts with and cuts any other URL to its file name', () => {
    expect(shortFeedError('http://localhost/api/flights: HTTP 404')).toBe('HTTP 404');
    expect(shortFeedError('The recorded day could not start: http://127.0.0.1:4391/samples/flights/flights-bay-day.parquet answered 404')).toBe(
      'The recorded day could not start: flights-bay-day.parquet answered 404',
    );
  });
});

describe('feedStatusLine (L5)', () => {
  const base: LiveSourceState = { kind: 'live', status: 'live', paused: false, attribution: null, license: null, lastSuccessAt: null, dataClockMs: null, nextAttemptAt: null, failures: 0, error: null, ended: false };
  it('never puts ", paused" after a full stop in the sentences it announces', () => {
    const paused = { ...base, paused: true };
    const lines = [
      feedStatusLine({ ...paused, status: 'rate-limited', failures: 1, error: 'x: rate-limited (HTTP 429)' }, undefined, 0).announce,
      feedStatusLine({ ...paused, status: 'backoff', failures: 2, error: 'x: HTTP 404' }, undefined, 0).announce,
      feedStatusLine({ ...paused, status: 'backoff', failures: 2 }, undefined, 0, false).announce,
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/\.,/);
      expect(line).toMatch(/It is paused while the page is hidden\.$/);
    }
    expect(lines[0]).toBe('The live feed is rate-limited: the relay asked us to slow down. It is paused while the page is hidden.');
    expect(lines[2]).toBe('You are offline: the live feed cannot be reached. It is paused while the page is hidden.');
  });
});

describe('altitudeText', () => {
  it('writes negative altitudes with a minus sign, as the vertical rate does', () => {
    expect(altitudeText({ altBaroFt: -175, altGeomFt: null, onGround: false })).toBe('−175 ft');
    expect(altitudeText({ altBaroFt: null, altGeomFt: -1_250, onGround: false })).toBe('−1,250 ft (GNSS)');
    expect(altitudeText({ altBaroFt: 3_000, altGeomFt: null, onGround: false })).toBe('3,000 ft');
  });
});
