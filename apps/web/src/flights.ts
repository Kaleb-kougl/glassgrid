import { openLiveFlightsWorkspace, FLIGHTS_SAMPLE_ARCHIVE, type EngineClientLike, type LiveFallbackChoice, type SampleDataset } from '@glassgrid/app';
import type { CommandRegistry, LiveSourceInput, OpenCsvResult } from '@glassgrid/core';

/*
 * The web demo's flights workspace (docs/live-flights-l3-data.md, l4.md): a
 * map, altitude and vertical-rate histograms and fixes by category over the
 * live table (`flight_states`), filled by the L2 feed.
 *
 * - `?sample=flights` (and the start screen's "Live flights" sample) loads
 *   the committed `flights-bay-30min.parquet` fixture whole
 *   (`FLIGHTS_SAMPLE_ARCHIVE`, L4) and the time scrubber plays it at 10×;
 *   "Load full day" swaps in `flights-bay-day.parquet`.
 * - `?live=1` polls the site's `/api/flights` relay instead (every 20 s);
 *   under `pnpm dev:web` the dev server proxies it to the portfolio's dev
 *   server (dev-proxy.ts). When the relay cannot deliver, the map card
 *   offers the recorded half hour (L5, the app's live-fallback.ts); the
 *   choice is kept for the tab, so a reload of `?live=1` opens the
 *   recording.
 *
 * The workspace is built in code (`liveFlightsWorkspace` in the app) rather
 * than shipped as a `.glassgrid` sample: a sample workspace names a data
 * file to fetch and relink (tools/datasets/src/samples.ts), and this one
 * reads the engine's live table, which is started, not fetched.
 */

/** The start screen's entry (not in samples.manifest.json: it has no data file of its own). */
export const FLIGHTS_SAMPLE: SampleDataset = { id: 'flights', label: 'Live flights (recorded)', detail: 'Bay Area air traffic · adsb.lol, ODbL' };

/** The live poll `?live=1` starts. */
export const LIVE_FLIGHTS_SOURCE: LiveSourceInput = { source: 'live' };

/** Which feed a link asks for: `?sample=flights` loads the recorded fixture, `?live=1` polls the relay; null otherwise. */
export function flightsSourceFromSearch(search: string): LiveSourceInput | null {
  const params = new URLSearchParams(search);
  if (params.get('sample') === FLIGHTS_SAMPLE.id) return FLIGHTS_SAMPLE_ARCHIVE;
  const live = params.get('live');
  return live === '1' || live === 'true' ? LIVE_FLIGHTS_SOURCE : null;
}

/**
 * What a flights link opens (L5): `?live=1` polls the relay, unless the person already chose the recorded traffic over
 * an unavailable feed in this tab, then the recording (the map card says so, and offers "Back to live" once the relay
 * answers). `requested` is whether the link asked for live data either way.
 */
export function initialFlightsSource(search: string, choice: LiveFallbackChoice | null): { source: LiveSourceInput | null; requested: boolean } {
  const source = flightsSourceFromSearch(search);
  const requested = source?.source === 'live';
  return { source: requested && choice === 'recorded' ? FLIGHTS_SAMPLE_ARCHIVE : source, requested };
}

export interface FlightsOpenDeps {
  readonly engine: Pick<EngineClientLike, 'open'>;
  readonly registry: Pick<CommandRegistry, 'dispatch'>;
}

/** Starts `source` and opens the flights workspace over the live table (see `openLiveFlightsWorkspace`). */
export function openFlightsWorkspace(source: LiveSourceInput, deps: FlightsOpenDeps): Promise<OpenCsvResult> {
  return openLiveFlightsWorkspace(source, deps);
}
