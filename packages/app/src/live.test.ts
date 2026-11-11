import { describe, expect, it, vi } from 'vitest';
import { INITIAL_LIVE_STATE, createWorkspace, type LiveState } from '@glassgrid/core';
import type { LiveEngineApi } from './engine';
import { provideLiveFlights } from './live';
import { appPolicy } from './workspace';

/*
 * The app's live-flights wiring: the three commands over `engine.live`,
 * visibility forwarded only once a feed was started (so the lazy web engine
 * is not started by a page that never uses live data), and the feed started
 * again after an engine restart.
 */

function setup(options: { live?: boolean; visibility?: boolean } = {}) {
  let n = 0;
  const { registry } = createWorkspace({ clock: () => 1, newId: (prefix) => `${prefix}_${(n += 1)}`, policy: appPolicy });
  const state: LiveState = { ...INITIAL_LIVE_STATE, rowCount: 7 };
  const fns = {
    start: vi.fn((_source: unknown) => Promise.resolve(state)),
    stop: vi.fn(() => Promise.resolve(state)),
    setSource: vi.fn((_source: unknown) => Promise.resolve(state)),
    setVisible: vi.fn((_visible: boolean) => Promise.resolve()),
  };
  const stateListeners = new Set<(state: LiveState) => void>();
  const live: LiveEngineApi = {
    ...fns,
    state: () => Promise.resolve(state),
    onState: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
  const restarted = new Set<() => void>();
  let report: ((visible: boolean) => void) | null = null;
  const engine = {
    ...(options.live === false ? {} : { live }),
    onRestarted: (listener: () => void) => {
      restarted.add(listener);
      return () => restarted.delete(listener);
    },
  };
  const window =
    options.visibility === false
      ? {}
      : {
          onVisibilityChange: (listener: (visible: boolean) => void) => {
            report = listener;
            listener(true);
            return () => {
              report = null;
            };
          },
        };
  const dispose = provideLiveFlights({ registry, engine, window });
  return {
    registry,
    live: fns,
    dispose,
    setVisible: (visible: boolean) => report?.(visible),
    restart: () => {
      for (const listener of restarted) listener();
    },
    report: (next: LiveState) => {
      for (const listener of stateListeners) listener(next);
    },
    state,
  };
}

const user = { caller: 'user' as const };

describe('provideLiveFlights', () => {
  it('runs the commands on the engine feed and returns its state', async () => {
    const { registry, live, state } = setup();
    expect(await registry.dispatch('startLive', { source: 'replay', fixture: 'flights-bay-day', speed: 60, intervalSeconds: 5 }, user)).toMatchObject({ value: state, entryId: null });
    expect(live.start).toHaveBeenCalledWith({ kind: 'replay', fixture: 'flights-bay-day', speed: 60, intervalMs: 5_000 });
    await registry.dispatch('setLiveSource', { source: 'live', retentionMinutes: 30 }, user);
    expect(live.setSource).toHaveBeenCalledWith({ kind: 'live', retentionMs: 1_800_000 });
    // Starting or switching can empty flight_states: not for an AI caller without the person's confirmation.
    await expect(registry.dispatch('setLiveSource', { source: 'live' }, { caller: 'ai' })).rejects.toMatchObject({ code: 'forbidden' });
    await registry.dispatch('stopLive', {}, { caller: 'ai' });
    expect(live.stop).toHaveBeenCalledOnce();
  });

  it('forwards visibility only once a feed was started', async () => {
    const { registry, live, setVisible } = setup();
    setVisible(false);
    setVisible(true);
    setVisible(false);
    expect(live.setVisible).not.toHaveBeenCalled();
    // Starting while hidden tells the engine first.
    await registry.dispatch('startLive', { source: 'live' }, user);
    expect(live.setVisible).toHaveBeenCalledWith(false);
    setVisible(true);
    setVisible(true);
    expect(live.setVisible.mock.calls).toEqual([[false], [true]]);
  });

  it('starts the running feed again after an engine restart, and not a stopped one', async () => {
    const { registry, live, restart, setVisible } = setup();
    await registry.dispatch('startLive', { source: 'live', intervalSeconds: 30 }, user);
    await registry.dispatch('setLiveSource', { source: 'replay', fixture: 'flights-bay-30min' }, user);
    setVisible(false);
    restart();
    expect(live.start).toHaveBeenLastCalledWith({ kind: 'replay', fixture: 'flights-bay-30min' });
    expect(live.setVisible).toHaveBeenLastCalledWith(false);
    await registry.dispatch('stopLive', {}, user);
    live.start.mockClear();
    restart();
    expect(live.start).not.toHaveBeenCalled();
  });

  it('does not replay an ended replay after an engine restart (it would empty the table)', async () => {
    const { registry, live, restart, report, state } = setup();
    await registry.dispatch('startLive', { source: 'replay', fixture: 'flights-bay-30min', speed: 60 }, user);
    restart();
    expect(live.start).toHaveBeenCalledTimes(2);
    const feed = { kind: 'replay' as const, status: 'stopped' as const, paused: false, attribution: null, license: null, lastSuccessAt: 1, dataClockMs: 2, nextAttemptAt: null, failures: 0, error: null, ended: true };
    report({ ...state, source: { kind: 'replay', fixture: 'flights-bay-30min', speed: 60 }, feed });
    restart();
    expect(live.start).toHaveBeenCalledTimes(2);
  });

  it('leaves the commands unavailable without an engine feed, and unprovides them on dispose', async () => {
    const without = setup({ live: false, visibility: false });
    await expect(without.registry.dispatch('startLive', { source: 'live' }, user)).rejects.toMatchObject({ code: 'unavailable' });
    const wired = setup();
    wired.dispose();
    await expect(wired.registry.dispatch('stopLive', {}, user)).rejects.toMatchObject({ code: 'unavailable' });
  });
});
