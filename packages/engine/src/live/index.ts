/*
 * Live flights in the engine (docs/live-flights-l2.md): the sources (live
 * endpoint, fixture replay), the `flight_states` store with its dedup and
 * retention, and the feed that ties them together. Runtime-neutral.
 */
export { AdsbLolSource, DEFAULT_LIVE_TIMEOUT_MS, MAX_LIVE_BACKOFF_MS, backoffDelayMs, retryAfterMs, type AdsbLolSourceOptions, type LiveFetch } from './adsblol-source';
export { systemClock } from './clock';
export { STORED_LAT_LON_DECIMALS, STORED_SPEED_TRACK_DECIMALS, fixKey, newFixes, toStoredPoint, type FixIdentity } from './dedup';
export { FLIGHT_POINT_SELECT, FLIGHT_STATES_TABLE, FlightStore, ROWS_PER_INSERT, pointFromRow, type FlightStoreOptions, type IngestResult, type LoadResult } from './flight-store';
export { LiveFeed, type LiveFeedHostOptions, type LiveFeedOptions } from './live-feed';
export { ArchiveSource, isPermanentLoadFailure, RETRY_ARCHIVE_MS, type ArchiveSourceOptions } from './archive-source';
export { ReplaySource, memoryFixtureReader, parquetFixtureReader, type FixtureReader, type ReplaySourceOptions } from './replay-source';
