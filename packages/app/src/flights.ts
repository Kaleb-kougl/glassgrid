import { useEffect, useState } from 'react';
import {
  ADSBLOL_ATTRIBUTION,
  BAY_AREA_BBOX,
  DEFAULT_LIVE_RETENTION_MS,
  bboxCenter,
  currentProfile,
  LIVE_FLIGHTS_HANDLE,
  parseTemporal,
  type CommandRegistry,
  type LiveSourceInput,
  type LiveSourceState,
  type LiveState,
  type MapSpec,
  type OpenCsvResult,
  type PersistedWorkspace,
  type TimeRange,
  type WorkspaceState,
} from '@glassgrid/core';
import type { EngineClientLike } from './engine';

/*
 * Live flights in the app, past L2's commands (docs/live-flights-l3-data.md):
 * the feed's state as React state, what a map view takes from it (data
 * clock, playing, speed, the source's credit), and the flights workspace a
 * shell opens over the live table (the web demo's `?sample=flights` and
 * `?live=1`).
 */

/**
 * The live feed's latest state, from the engine's `liveState` events. Only
 * while `active` (the live table is open): asking a lazily started engine
 * for its state would start it.
 *
 * The last message received wins. Events and the answer to `state()` come
 * over one port in the order the engine sent them, so whichever arrives
 * later is newer. (Before the L4 review the answer was refused when its data
 * clock was earlier than the state held, but clocks go backwards whenever
 * the source changes: the day's end, then the half hour's. An archive sends
 * one batch, so the stale state stayed for good.) Turning inactive forgets
 * the state, so a reopened live table starts from the engine's answer.
 */
export function useLiveState(engine: Pick<EngineClientLike, 'live'>, active: boolean): LiveState | null {
  const [state, setState] = useState<LiveState | null>(null);
  const [seen, setSeen] = useState({ engine, active });
  if (seen.engine !== engine || seen.active !== active) {
    setSeen({ engine, active });
    setState(null);
  }
  useEffect(() => {
    const live = engine.live;
    if (!active || !live) return;
    let current = true;
    const off = live.onState((next) => {
      if (current) setState(next);
    });
    live.state().then(
      (next) => {
        if (current) setState(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
      off();
    };
  }, [engine, active]);
  return active ? state : null;
}

/** A batch's identity: a new one means the live table's rows changed. */
export function batchKey(state: LiveState | null): string | null {
  return state?.lastBatch ? JSON.stringify(state.lastBatch) : null;
}

/** What a map view shows besides its rows: the clock they are for, whether time moves, and the data's credit. */
export interface MapClock {
  /** The data clock to query at (epoch ms), or null while unknown (no batch yet). */
  readonly dataClockMs: number | null;
  /** The feed is running and not paused (the map may animate between batches). */
  readonly playing: boolean;
  /** A replay's speed (fixture time per real time); undefined for live data and files. */
  readonly speed: number | undefined;
  /** The data source's credit line, if known. */
  readonly attribution: string | null;
  /** Where the map starts. */
  readonly initialView: { center: [lon: number, lat: number]; zoom: number } | undefined;
  /** The data's extent (the map zooms out far enough to show it all): the live feed's box, else the lat/lon profile's range. */
  readonly dataBounds?: { west: number; south: number; east: number; north: number } | undefined;
  /**
   * The live table: the feed's state, null until the engine reported one
   * (the map card says so in its status line). Undefined for other tables.
   */
  readonly feed?: LiveSourceState | null;
}

const BAY_AREA_VIEW = (() => {
  const center = bboxCenter(BAY_AREA_BBOX);
  return { center: [center.lon, center.lat] as [number, number], zoom: 8 };
})();

/**
 * The live table: the last batch's data clock and the feed's status. Any
 * other table (a flights Parquet or CSV opened like any file) is a still
 * picture at its newest fix: the time column's max from the profile.
 */
export function mapClock(state: Pick<WorkspaceState, 'dataSource' | 'columns'>, spec: Pick<MapSpec, 'time'> & Partial<Pick<MapSpec, 'lat' | 'lon'>>, live: LiveState | null): MapClock {
  const handle = state.dataSource?.handleId ?? null;
  if (handle === LIVE_FLIGHTS_HANDLE) {
    const feed = live?.feed ?? null;
    const source = live?.source ?? null;
    return {
      dataClockMs: live?.lastBatch?.dataClockMs ?? null,
      playing: feed !== null && feed.status !== 'stopped' && !feed.paused,
      speed: source?.kind === 'replay' ? (source.speed ?? 1) : undefined,
      attribution: feed?.attribution ?? ADSBLOL_ATTRIBUTION,
      initialView: BAY_AREA_VIEW,
      dataBounds: BAY_AREA_BBOX,
      feed,
    };
  }
  const column = state.columns.find((candidate) => candidate.name === spec.time);
  const max = column ? currentProfile(column)?.max : undefined;
  const clock = parseTemporal(max ?? undefined);
  return { dataClockMs: clock === null ? null : Math.floor(clock), playing: false, speed: undefined, attribution: null, initialView: undefined, dataBounds: profileBounds(state.columns, spec.lat ?? 'lat', spec.lon ?? 'lon') };
}

/** A file's lat/lon extent from the column profiles; undefined until both are profiled (or out of range). */
function profileBounds(columns: WorkspaceState['columns'], lat: string, lon: string): MapClock['dataBounds'] {
  const range = (name: string) => {
    const column = columns.find((candidate) => candidate.name === name);
    const profile = column ? currentProfile(column) : null;
    const min = Number(profile?.min ?? Number.NaN);
    const max = Number(profile?.max ?? Number.NaN);
    return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : null;
  };
  const y = range(lat);
  const x = range(lon);
  if (y === null || x === null || y.min < -85 || y.max > 85 || x.min < -180 || x.max > 180) return undefined;
  return { west: x.min, south: y.min, east: x.max, north: y.max };
}

/**
 * The data the time cursor can be at (L4): the time column's first fix (its
 * profile's min) to, on the live table, the last batch's data clock (the
 * live feed's `now`, a replay's position, an archive's last fix), else the
 * profile's max. Null while neither end is known.
 */
export function dataTimeRange(columns: WorkspaceState['columns'], timeColumn: string, live: LiveState | null): TimeRange | null {
  const column = columns.find((candidate) => candidate.name === timeColumn);
  const profile = column ? currentProfile(column) : null;
  const min = parseTemporal(profile?.min ?? undefined);
  const max = parseTemporal(profile?.max ?? undefined);
  const end = live !== null ? (live.lastBatch?.dataClockMs ?? null) : max === null ? null : Math.floor(max);
  if (end === null) return null;
  let start = min === null ? end : Math.min(end, Math.floor(min));
  // A feed with retention keeps nothing older than its clock minus the retention: known with the batch, so the
  // range never starts at rows the batch just expired (the profile, a moment later, would say the same).
  const retention = live === null ? null : retentionOf(live.source);
  if (retention !== null) start = Math.min(end, Math.max(start, end - retention));
  return { startMs: start, endMs: end };
}

/** How far back a feed keeps fixes (ms), or null when it keeps all it loaded (an archive, or retention off). */
function retentionOf(source: LiveState['source']): number | null {
  if (source === null || source.kind === 'archive') return null;
  return source.retentionMs === undefined ? DEFAULT_LIVE_RETENTION_MS : source.retentionMs;
}

/** The feed's state in a few words: "Live", "Replay 5×", "Recorded", "Connecting…", "Stale", "Retrying", "Stopped", "Replay ended" (", paused"). */
export function feedLabel(feed: LiveSourceState | null, speed: number | undefined): string {
  if (feed === null) return 'Starting…';
  const replay = feed.kind === 'replay';
  let label: string;
  switch (feed.status) {
    case 'connecting':
      label = replay ? 'Starting the replay…' : feed.kind === 'archive' ? 'Loading…' : 'Connecting…';
      break;
    case 'live':
      label = replay ? `Replay ${speed ?? 1}×` : feed.kind === 'archive' ? 'Recorded' : 'Live';
      break;
    case 'stale':
      label = 'Stale';
      break;
    case 'backoff':
      label = 'Retrying';
      break;
    case 'stopped':
      label = replay && feed.ended ? 'Replay ended' : feed.kind === 'archive' && feed.error !== null ? 'Load failed' : 'Stopped';
      break;
  }
  return feed.paused && feed.status !== 'stopped' ? `${label}, paused` : label;
}

/**
 * A source error without the endpoint URL it starts with, and any other URL
 * cut to its file name, at most 80 characters: "HTTP 404", "no data (HTTP
 * 503)", "The recorded day could not start: flights-bay-day.parquet answered 404".
 */
export function shortFeedError(error: string | null): string | null {
  if (error === null) return null;
  const text = error
    .replace(/^(?:https?:\/\/|\/)\S*:\s+/, '')
    .replace(/https?:\/\/\S*\/([^\s/]+)/g, '$1')
    .trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

const clockTime = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/**
 * What the map card's status line says about the feed (L2's states):
 * `text` for the line (a backing-off feed counts down to its next attempt,
 * so it changes every second), `announce` for its polite live region (the
 * same without the countdown, so a screen reader hears each change of
 * state, not each second).
 */
export function feedStatusLine(feed: LiveSourceState | null, speed: number | undefined, nowMs: number): { text: string; announce: string } {
  if (feed === null) return { text: 'Starting the feed…', announce: 'Starting the feed' };
  const source = feed.kind === 'replay' ? 'replay' : feed.kind === 'archive' ? 'recorded data' : 'live feed';
  const paused = feed.paused && feed.status !== 'stopped' ? ', paused' : '';
  switch (feed.status) {
    case 'connecting':
      if (feed.kind === 'archive') return { text: `Loading recorded flights…${paused}`, announce: `Loading recorded flights${paused}` };
      return feed.kind === 'replay'
        ? { text: `Starting the replay…${paused}`, announce: `Starting the replay${paused}` }
        : { text: `Connecting to the live feed…${paused}`, announce: `Connecting to the live feed${paused}` };
    case 'live':
      if (feed.kind === 'archive') return { text: `Recorded${paused}`, announce: `Recorded flights loaded${paused}` };
      return { text: feedLabel(feed, speed), announce: feed.kind === 'replay' ? `Replaying at ${speed ?? 1}×${paused}` : `Live${paused}` };
    case 'stale': {
      const since = feed.lastSuccessAt === null ? '' : `, last update at ${clockTime.format(feed.lastSuccessAt)}`;
      return { text: `Stale data${paused}`, announce: `The ${source}'s data is stale${since}${paused}` };
    }
    case 'backoff': {
      const error = shortFeedError(feed.error);
      const tries = `${feed.failures} failed ${feed.failures === 1 ? 'attempt' : 'attempts'}`;
      const wait = feed.nextAttemptAt === null ? null : Math.max(0, Math.ceil((feed.nextAttemptAt - nowMs) / 1000));
      const when = wait === null ? 'Retrying' : wait === 0 ? 'Retrying now' : `Retrying in ${wait} s`;
      const at = feed.nextAttemptAt === null ? '' : ` Next try at ${clockTime.format(feed.nextAttemptAt)}.`;
      return {
        text: `${when}${error ? ` · ${error}` : ''}${paused}`,
        announce: `The ${source} is unavailable after ${tries}${error ? `: ${error}` : ''}.${at}${paused}`,
      };
    }
    case 'stopped': {
      if (feed.kind === 'replay' && feed.ended) return { text: 'Replay ended', announce: 'The replay ended' };
      // An archive stops on a load that cannot succeed (out of memory, a missing file): say why, once.
      const error = feed.kind === 'archive' ? shortFeedError(feed.error) : null;
      if (error !== null) return { text: `Didn’t load · ${error}`, announce: `The recorded flights didn’t load: ${error}` };
      return { text: 'Stopped', announce: `The ${source} is stopped` };
    }
  }
}

/**
 * The vertical-rate chart (L4): a histogram of `baroRateFpm` in 500 ft/min
 * bins over ±6,000 ft/min (99.9 % of the fixtures' fixes; the archive holds
 * a few absurd values, down to −142,136, that would stretch an automatic
 * axis to one bar). A histogram, not a line of the mean rate over time: a
 * brush on it selects "climbing", "level" or "descending" directly (a range
 * on the rate, which a cube answers), where a mean over time cancels climbs
 * against descents and its brush would select a time range instead.
 */
export const VERTICAL_RATE_CHART: PersistedWorkspace['charts'][number] = {
  id: 'chart_4',
  spec: {
    mark: 'histogram',
    x: { column: 'baroRateFpm', bin: 500 },
    filters: [{ kind: 'range', column: 'baroRateFpm', min: -6_000, max: 6_000, minInclusive: true, maxInclusive: false }],
  },
  title: 'Vertical rate (ft/min)',
};

/** The flights workspace's views over `flight_states`: a map (filtering the rest to its view), altitude and vertical-rate histograms and fixes by category. */
export function liveFlightsWorkspace(columns: readonly { name: string; type: WorkspaceState['columns'][number]['inferredType'] }[]): PersistedWorkspace {
  return {
    columns: columns.map((column) => ({ name: column.name, inferredType: column.type, typeOverride: null })),
    charts: [
      { id: 'chart_2', spec: { mark: 'histogram', x: { column: 'altBaroFt', bin: 'auto' }, filters: [] }, title: 'Barometric altitude (ft)' },
      { id: 'chart_3', spec: { mark: 'bar', x: { column: 'category' }, filters: [] }, title: 'Fixes by emitter category' },
      ...(columns.some((column) => column.name === 'baroRateFpm') ? [structuredClone(VERTICAL_RATE_CHART)] : []),
    ],
    maps: [{ id: 'map_1', spec: { kind: 'map', lat: 'lat', lon: 'lon', id: 'hex', time: 'ts', filters: [], trailMinutes: 5 }, title: 'Bay Area traffic' }],
    selections: {},
    userFilters: [],
    grid: { sort: [], columnOrder: [], columnWidths: [] },
    layout: {
      cards: [
        { chartId: 'map_1', x: 0, y: 0, w: 2, h: 2 },
        { chartId: 'chart_2', x: 2, y: 0, w: 1, h: 1 },
        { chartId: 'chart_3', x: 2, y: 1, w: 1, h: 1 },
        ...(columns.some((column) => column.name === 'baroRateFpm') ? [{ chartId: 'chart_4', x: 2, y: 2, w: 1, h: 1 }] : []),
      ],
    },
  };
}

/**
 * L3's replay of the busiest 30 minutes (10 s of fixture every 2 s). Since L4
 * the flights sample loads the fixture whole instead (FLIGHTS_SAMPLE_ARCHIVE)
 * and the time cursor plays it; the replay still works (agents, tests).
 */
export const FLIGHTS_SAMPLE_REPLAY: LiveSourceInput = { source: 'replay', fixture: 'flights-bay-30min', intervalSeconds: 2, speed: 5 };

/** The flights sample (L4): the busiest 30 minutes loaded whole (72k fixes, 0.76 MB), played by the time cursor. */
export const FLIGHTS_SAMPLE_ARCHIVE: LiveSourceInput = { source: 'archive', fixture: 'flights-bay-30min' };

/** "Load full day" (L4): all of 2026-11-09, 1.46M fixes in a 14.5 MB file. */
export const FLIGHTS_DAY_ARCHIVE: LiveSourceInput = { source: 'archive', fixture: 'flights-bay-day' };

/** The speed the time cursor plays an archive at when it opens (30 minutes in 3 minutes). */
export const ARCHIVE_PLAY_SPEED = 10;

export interface LiveFlightsOpenDeps {
  readonly engine: Pick<EngineClientLike, 'open'>;
  readonly registry: Pick<CommandRegistry, 'dispatch'>;
}

/**
 * Starts the feed (`startLive`, a person's own action: write tier) and
 * replaces the workspace with the flights workspace over the live table, in
 * one `loadWorkspace` (one undo entry; undo restores the previous workspace,
 * the feed keeps running). Resolves like a sample open: `cancelled` once
 * loaded (nothing is left for the file-open path), `failed` with a message.
 */
export async function openLiveFlightsWorkspace(source: LiveSourceInput, deps: LiveFlightsOpenDeps): Promise<OpenCsvResult> {
  try {
    await deps.registry.dispatch('startLive', source, { caller: 'user' });
  } catch (error) {
    const what = source.source === 'live' ? 'feed could not start' : source.source === 'archive' ? 'data could not load' : 'replay could not start';
    return { status: 'failed', message: `The flight ${what}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const { table } = await deps.engine.open(LIVE_FLIGHTS_HANDLE);
  const columns = table.columns.map((column) => ({ name: column.name, type: column.type }));
  await deps.registry.dispatch(
    'loadWorkspace',
    {
      data: { handleId: LIVE_FLIGHTS_HANDLE, fileName: table.fileName, fingerprint: table.fingerprint, columns },
      workspace: liveFlightsWorkspace(columns),
      document: { id: null, fileName: null },
      recovered: false,
    },
    { caller: 'user' },
  );
  return { status: 'cancelled' };
}
