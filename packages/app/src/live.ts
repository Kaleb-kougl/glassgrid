import { liveSourceConfigFromInput, type CommandRegistry, type LiveSourceConfig, type ParsedLiveSourceInput } from '@glassgrid/core';
import type { EngineClientLike } from './engine';
import type { PlatformWindow } from './platform';

/*
 * Live flights in the app (docs/live-flights-l2.md): the `startLive`,
 * `stopLive` and `setLiveSource` commands over the engine's live feed, and
 * the page's visibility reported to it.
 *
 * - The commands are effect commands (core); this provides them when the
 *   engine client has a live feed (`engine.live`: the web demo's worker
 *   engine). Elsewhere (the desktop client today) they stay unprovided and
 *   answer `unavailable`.
 * - Visibility: the engine runs in a worker that cannot see
 *   `document.visibilityState`, so the platform reports it
 *   (`PlatformWindow.onVisibilityChange`) and this forwards it, so the live
 *   source stops polling while the page is hidden. It is only sent once a
 *   feed was started, so a page that never uses live data never starts the
 *   (lazy) engine just to say it is visible.
 * - After an engine restart (a new worker), the feed that was running is
 *   started again, with the last visibility; one that stopped or (a
 *   replay) ended is not.
 */

export interface LiveWiring {
  readonly registry: Pick<CommandRegistry, 'provide'>;
  readonly engine: Pick<EngineClientLike, 'live' | 'onRestarted'>;
  readonly window: Pick<PlatformWindow, 'onVisibilityChange'>;
}

/** Provide the live commands and forward visibility. Returns a function that undoes both. */
export function provideLiveFlights({ registry, engine, window }: LiveWiring): () => void {
  const live = engine.live;
  if (!live) return () => undefined;
  let visible = true;
  /** A feed was started from this page (visibility now matters to the engine). */
  let engaged = false;
  /** What runs, to start again after an engine restart. */
  let running: LiveSourceConfig | null = null;

  const engage = () => {
    if (engaged) return;
    engaged = true;
    if (!visible) void live.setVisible(false).catch(() => undefined);
  };

  const cleanups = [
    registry.provide('startLive', async (input) => {
      const config = liveSourceConfigFromInput(input as ParsedLiveSourceInput);
      engage();
      const state = await live.start(config);
      running = config;
      return state;
    }),
    registry.provide('stopLive', async () => {
      running = null;
      return live.stop();
    }),
    registry.provide('setLiveSource', async (input) => {
      const config = liveSourceConfigFromInput(input as ParsedLiveSourceInput);
      const state = await live.setSource(config);
      if (running !== null) running = config;
      return state;
    }),
    window.onVisibilityChange?.((next) => {
      if (next === visible) return;
      visible = next;
      if (engaged) void live.setVisible(next).catch(() => undefined);
    }) ?? (() => undefined),
    // A replay that played to its end (or a feed stopped elsewhere) is not running: a restart must not
    // replay it again, which would empty the table.
    live.onState((state) => {
      if (state.feed?.status === 'stopped') running = null;
    }),
    engine.onRestarted(() => {
      // The new engine knows nothing of the feed or of this page's visibility.
      if (engaged && !visible) void live.setVisible(false).catch(() => undefined);
      if (running !== null) void live.start(running).catch(() => undefined);
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
