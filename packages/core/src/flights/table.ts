import { toFileHandle, type FileHandle } from '../ids.js';
import { tableIdForFile, type Fingerprint, type TableId } from '../protocol/engine.js';

/*
 * The live feed's table as a data source (docs/live-flights-l3-data.md).
 *
 * The engine's `flight_states` table (L2) is opened, queried and closed like
 * any other table, under one reserved handle that no file can have (file
 * handles are `fh_<uuid>`), so the workspace state, the grid, charts,
 * cross-filter and map views use it unchanged: `openFile` records it as the
 * data source and every request names `LIVE_FLIGHTS_TABLE_ID`.
 *
 * Its identity is the table, not a snapshot of it: the fingerprint is the
 * same constant for every source and every batch. What changes per batch
 * (every poll or replay tick) is versioned inside the engine, where every
 * cached result, cube and sort index of the table is invalidated on each
 * ingest; a fingerprint that changed per poll would instead make the
 * workspace's data source go stale twice a minute.
 */

/** The reserved handle of the live table (never a file: not a UUID). */
export const LIVE_FLIGHTS_HANDLE: FileHandle = toFileHandle('live-flight-states');

/** `tableIdForFile(LIVE_FLIGHTS_HANDLE)`: what every request on the live table names. */
export const LIVE_FLIGHTS_TABLE_ID: TableId = tableIdForFile(LIVE_FLIGHTS_HANDLE);

/** The live table's display name (the grid's label, the title bar). */
export const LIVE_FLIGHTS_TABLE_NAME = 'flight_states';

/**
 * The live table's fingerprint: constant (see above). Size and mtime are 0;
 * the digests are fixed strings that no file's SHA-256 or Parquet cache key
 * will equal by accident.
 */
export const LIVE_FLIGHTS_FINGERPRINT: Fingerprint = Object.freeze({
  sizeBytes: 0,
  mtimeMs: 0,
  headTailSha256: '6c697665'.repeat(8),
  key: '6c697665'.repeat(4),
});

/** Whether a table id is the live feed's table. */
export function isLiveFlightsTable(table: string | null | undefined): boolean {
  return table === LIVE_FLIGHTS_TABLE_ID;
}
