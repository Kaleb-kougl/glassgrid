import { z } from 'zod';
import { MAX_REPLAY_SPEED } from '../../flights/live.js';
import { DEFAULT_TIME_CURSOR, type TimeCursor } from '../../state/workspace.js';
import { defineCommand } from '../define.js';
import { CommandError } from '../errors.js';

/*
 * The time cursor (milestone L4, docs/live-flights-l4.md): what T the map
 * (and, when they follow it, the charts and the grid) shows.
 *
 * - `setTime` moves, plays, pauses or releases the cursor. View state, like
 *   the grid's cell selection (`setSelection`): it records no undo entry,
 *   so scrubbing and playing never flood the history, and Undo steps
 *   through edits, not playback positions. Tier `edit`, exposed to MCP: an
 *   agent can look at the traffic at a given time the way a person scrubs.
 * - `setChartsFollowTime` narrows the charts and the grid to the window up
 *   to T. It changes what the charts show, like adding a filter, so it is
 *   one undo entry.
 *
 * Neither is saved in workspace files (view state; format 2 has no field
 * for either).
 */

const EpochMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SpeedSchema = z.number().min(1).max(MAX_REPLAY_SPEED);

export const SetTimeInputSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('live').describe('Follow the newest data: the live feed\'s clock, or the end of an archived day'),
    speed: SpeedSchema.optional().describe(`Speed for the next play, 1 to ${MAX_REPLAY_SPEED}`),
  }),
  z.strictObject({
    mode: z.literal('paused').describe('Hold T at atMs'),
    atMs: EpochMsSchema.describe('T, epoch milliseconds'),
    speed: SpeedSchema.optional(),
  }),
  z.strictObject({
    mode: z.literal('playing').describe('Advance T from atMs at speed (data time per real time); it stops at the end of the data'),
    atMs: EpochMsSchema.describe('Where to start, epoch milliseconds'),
    speed: SpeedSchema.optional().describe(`Data time per real time, 1 to ${MAX_REPLAY_SPEED} (default: the cursor's, 10 at first)`),
  }),
]);
export type SetTimeInput = z.input<typeof SetTimeInputSchema>;

export const SetChartsFollowTimeInputSchema = z.strictObject({
  /** true: charts and the grid show only the 5 minutes up to T; false: every loaded fix. */
  enabled: z.boolean(),
});
export type SetChartsFollowTimeInput = z.input<typeof SetChartsFollowTimeInputSchema>;

/** Sets the time cursor: follow the newest data, hold a time, or play from one. */
export const setTime = defineCommand({
  name: 'setTime',
  description:
    'Sets the time the map shows (T): { mode: "live" } follows the newest data; { mode: "paused", atMs } holds T at that time (epoch ms); { mode: "playing", atMs, speed? } advances T from atMs at speed (1-120) until the end of the data. The map then shows each aircraft at its latest fix at or before T, with its trail and the selected track up to T.',
  input: SetTimeInputSchema,
  tier: 'edit',
  mcp: true,
  undoable: false,
  apply(draft, input, ctx) {
    if (draft.dataSource === null) {
      throw new CommandError('precondition_failed', 'No file is open, so there is no time to set', { command: 'setTime' });
    }
    const before: TimeCursor = draft.time ?? DEFAULT_TIME_CURSOR;
    const speed = input.speed ?? before.speed;
    const next: TimeCursor =
      input.mode === 'live'
        ? { mode: 'live', atMs: null, since: null, speed }
        : input.mode === 'paused'
          ? { mode: 'paused', atMs: input.atMs, since: null, speed }
          : { mode: 'playing', atMs: input.atMs, since: Math.max(0, Math.floor(ctx.now)), speed };
    const same = before.mode === next.mode && before.atMs === next.atMs && before.since === next.since && before.speed === next.speed;
    if (same && draft.time !== undefined) return;
    draft.time = next;
  },
});

/** Charts and the grid follow the time cursor (the 5 minutes up to T), or describe every loaded fix. */
export const setChartsFollowTime = defineCommand({
  name: 'setChartsFollowTime',
  description:
    'With enabled: true, the charts and the grid show only fixes in the 5 minutes up to the time cursor (T, see setTime), and follow it while it plays; with false (the default) they show every loaded fix. The map always shows T.',
  input: SetChartsFollowTimeInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    if (input.enabled) draft.chartsFollowTime = true;
    else delete draft.chartsFollowTime;
  },
});
