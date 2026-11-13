import { z } from 'zod';
import {
  LiveFixtureIdSchema,
  MAX_LIVE_INTERVAL_MS,
  MAX_LIVE_RETENTION_MS,
  MAX_REPLAY_SPEED,
  MIN_LIVE_INTERVAL_MS,
  MIN_REPLAY_INTERVAL_MS,
  type LiveSourceConfig,
} from '../../flights/live.js';
import { defineEffect } from '../define.js';

/*
 * Live flights (docs/live-flights-l2.md): start, stop and switch the feed
 * that fills the engine's `flight_states` table from the live endpoint, a
 * replayed fixture, or (L4) a whole fixture loaded at once (`archive`,
 * which the app's time cursor then moves through).
 *
 * These are effect commands, like `copySelection` and the workspace-file
 * commands: their effect is in the engine (a poller or a replay clock), not
 * in the workspace state, so they record no undo entry and Undo never
 * restarts or stops a feed. The app implements them with `registry.provide`
 * over the engine client (`packages/app/src/live.ts`); a shell whose engine
 * has no live feed leaves them unprovided, and they answer `unavailable`.
 *
 * Tiers:
 *
 * - `startLive` and `setLiveSource` are `write`, like `copySelection`:
 *   they can empty `flight_states` (a new source starts on an empty table),
 *   which Undo cannot bring back, and they start network activity. The
 *   `edit` tier promises "always runs, undoable", which these cannot keep,
 *   so they run only when the host's `confirmWrite` allows it (the app: a
 *   person's own action yes, an AI caller no until a confirmation UI
 *   exists).
 * - `stopLive` is `edit`: it only stops polling, keeps every row, and is
 *   undone by starting again; harmless for any caller.
 *
 * All three are exposed to MCP (`mcp: true`): an agent asks for a feed the
 * same way a person does, and the tier decides whether it runs. Even an
 * allowed caller cannot make the feed poll more than once per 10 s (the
 * feed spaces polls across restarts, see live-feed.ts), and the only
 * network access is the endpoint the host configured.
 */

const MIN_LIVE_SECONDS = MIN_LIVE_INTERVAL_MS / 1000;
const MIN_REPLAY_SECONDS = MIN_REPLAY_INTERVAL_MS / 1000;
const MAX_SECONDS = MAX_LIVE_INTERVAL_MS / 1000;

const retentionMinutes = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIVE_RETENTION_MS / 60_000)
  .nullable()
  .optional()
  .describe('Keep fixes this many minutes behind the source clock (default 60); null keeps everything');

export const LiveSourceInputSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('live').describe('Poll the live endpoint (adsb.lol over the Bay Area)'),
    intervalSeconds: z
      .number()
      .int()
      .min(MIN_LIVE_SECONDS)
      .max(MAX_SECONDS)
      .optional()
      .describe(`Seconds between polls (default 20; at least ${MIN_LIVE_SECONDS}, the CDN cache window)`),
    retentionMinutes,
  }),
  z.strictObject({
    source: z.literal('replay').describe('Replay a recorded fixture on the same clock'),
    fixture: LiveFixtureIdSchema.describe('flights-bay-30min (busiest 30 minutes) or flights-bay-day (the whole day)'),
    intervalSeconds: z
      .number()
      .int()
      .min(MIN_REPLAY_SECONDS)
      .max(MAX_SECONDS)
      .optional()
      .describe('Seconds between ticks (default 20)'),
    speed: z
      .number()
      .min(1)
      .max(MAX_REPLAY_SPEED)
      .optional()
      .describe(`Fixture time per real time, 1 to ${MAX_REPLAY_SPEED} (default 1); replay positions are floored to whole milliseconds`),
    retentionMinutes,
  }),
  z.strictObject({
    source: z.literal('archive').describe('Load a recorded fixture whole (retention off) for the time scrubber (setTime) to move through'),
    fixture: LiveFixtureIdSchema.describe('flights-bay-30min (busiest 30 minutes, 72k fixes) or flights-bay-day (the whole day, 1.46M fixes, a 14.5 MB file)'),
  }),
]);
export type LiveSourceInput = z.input<typeof LiveSourceInputSchema>;
/** The input as a handler receives it, after validation. */
export type ParsedLiveSourceInput = z.output<typeof LiveSourceInputSchema>;

/** A command's source input as the engine protocol's `LiveSourceConfig`. */
export function liveSourceConfigFromInput(input: ParsedLiveSourceInput): LiveSourceConfig {
  if (input.source === 'archive') return { kind: 'archive', fixture: input.fixture };
  const intervalMs = input.intervalSeconds === undefined ? {} : { intervalMs: input.intervalSeconds * 1000 };
  const retentionMs = input.retentionMinutes === undefined ? {} : { retentionMs: input.retentionMinutes === null ? null : input.retentionMinutes * 60_000 };
  if (input.source === 'live') return { kind: 'live', ...intervalMs, ...retentionMs };
  return { kind: 'replay', fixture: input.fixture, ...intervalMs, ...(input.speed === undefined ? {} : { speed: input.speed }), ...retentionMs };
}

export const startLive = defineEffect({
  name: 'startLive',
  description:
    'Starts the live-flights feed into the flight_states table: { source: "live" } polls adsb.lol over the Bay Area (every 20 s by default, at least 10 s); { source: "replay", fixture } plays a recorded fixture on the same clock, optionally faster (speed); { source: "archive", fixture } loads a recorded fixture whole, for setTime to move through. Switching source empties the table first, which cannot be undone, so an AI caller needs the person to confirm. Returns the feed state.',
  input: LiveSourceInputSchema,
  tier: 'write',
  mcp: true,
});

export const stopLive = defineEffect({
  name: 'stopLive',
  description: 'Stops the live-flights feed. The fixes already in flight_states stay. Returns the feed state.',
  input: z.strictObject({}),
  tier: 'edit',
  mcp: true,
});

export const setLiveSource = defineEffect({
  name: 'setLiveSource',
  description:
    'Chooses the live-flights source without starting or stopping the feed: a running feed switches to it, a stopped one uses it on its next start. Changing the source empties flight_states, which cannot be undone, so an AI caller needs the person to confirm. Same input as startLive. Returns the feed state.',
  input: LiveSourceInputSchema,
  tier: 'write',
  mcp: true,
});
