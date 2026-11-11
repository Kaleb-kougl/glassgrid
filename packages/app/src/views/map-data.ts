import type { Table } from 'apache-arrow';
import { useEffect, useMemo, useState } from 'react';
import type { MapAircraftRow, MapSpec, MapTrailRow, TableId } from '@glassgrid/core';
import { isAbandoned, type EngineClientLike } from '../engine';

/*
 * A map view's data (docs/live-flights-l3-data.md): the latest fix of every
 * aircraft and their trails at one data clock, as two engine requests (view
 * scoped `map:<id>:latest` and `map:<id>:trails`, so a newer clock
 * supersedes a stale one in the engine). Both answers are taken together or
 * not at all: the map always gets aircraft, trails and the clock they were
 * computed for, never a mix of two clocks. A reply for anything but the
 * latest inputs is dropped.
 */

/** What the map component draws: one consistent snapshot. */
export interface MapSnapshot {
  /** The request key it answers (see `mapRequestKey`). */
  readonly key: string;
  /** The spec it was queried with, as JSON (its filters: what the cross-filter timing compares). */
  readonly specKey: string;
  readonly aircraft: MapAircraftRow[];
  readonly trails: MapTrailRow[];
  /** The data clock both queries ran at. */
  readonly dataClockMs: number;
  readonly engineMs: number;
}

export type MapData =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly previous: MapSnapshot | null }
  | { readonly status: 'ready'; readonly snapshot: MapSnapshot }
  | { readonly status: 'error'; readonly message: string; readonly previous: MapSnapshot | null };

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' ? value : Number(value);
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' ? String(value) : null;
}

function reader(table: Table) {
  return (name: string) => {
    const column = table.getChild(name);
    return (row: number): unknown => column?.get(row) ?? null;
  };
}

/** The latest-fix query's Arrow rows as the map component's `MapAircraft` objects. */
export function aircraftFromArrow(table: Table): MapAircraftRow[] {
  const col = reader(table);
  const hex = col('hex');
  const flight = col('flight');
  const typeCode = col('typeCode');
  const category = col('category');
  const lat = col('lat');
  const lon = col('lon');
  const altBaroFt = col('altBaroFt');
  const altGeomFt = col('altGeomFt');
  const onGround = col('onGround');
  const gsKt = col('gsKt');
  const trackDeg = col('trackDeg');
  const baroRateFpm = col('baroRateFpm');
  const ts = col('ts');
  const registration = col('registration');
  const rows: MapAircraftRow[] = [];
  for (let i = 0; i < table.numRows; i += 1) {
    rows.push({
      hex: text(hex(i)) ?? '',
      flight: text(flight(i)),
      typeCode: text(typeCode(i)),
      category: text(category(i)),
      lat: num(lat(i)) ?? 0,
      lon: num(lon(i)) ?? 0,
      altBaroFt: num(altBaroFt(i)),
      altGeomFt: num(altGeomFt(i)),
      onGround: onGround(i) === true,
      gsKt: num(gsKt(i)),
      trackDeg: num(trackDeg(i)),
      baroRateFpm: num(baroRateFpm(i)),
      ts: num(ts(i)) ?? 0,
      registration: text(registration(i)),
    });
  }
  return rows;
}

/** The trails (or track) query's Arrow rows as `MapTrailPoint` objects (ordered by hex, then ts, as the engine sends them). */
export function trailsFromArrow(table: Table): MapTrailRow[] {
  const col = reader(table);
  const hex = col('hex');
  const ts = col('ts');
  const lat = col('lat');
  const lon = col('lon');
  const alt = col('altBaroFt');
  const rows: MapTrailRow[] = [];
  for (let i = 0; i < table.numRows; i += 1) {
    rows.push({ hex: text(hex(i)) ?? '', ts: num(ts(i)) ?? 0, lat: num(lat(i)) ?? 0, lon: num(lon(i)) ?? 0, altBaroFt: num(alt(i)) });
  }
  return rows;
}

/** What a map's data depends on: table, spec (with the other views' filters), data clock and data version. */
export function mapRequestKey(tableId: TableId | null, spec: MapSpec, dataClockMs: number | null, dataVersion: number): string {
  return JSON.stringify([tableId, spec, dataClockMs, dataVersion]);
}

/**
 * Runs a map view's two queries whenever its inputs change (a live batch
 * moves the clock and the data version; filters change the spec). Keeps
 * showing the previous snapshot while the next one loads.
 */
export function useMapData(
  engine: Pick<EngineClientLike, 'mapQuery'>,
  tableId: TableId | null,
  mapId: string,
  spec: MapSpec,
  dataClockMs: number | null,
  dataVersion: number,
): MapData {
  const key = mapRequestKey(tableId, spec, dataClockMs, dataVersion);
  const [data, setData] = useState<{ key: string; value: MapData } | null>(null);

  useEffect(() => {
    if (tableId === null || dataClockMs === null) return;
    const live = { current: true };
    const request = { spec, dataClockMs };
    const latest = engine.mapQuery(tableId, { ...request, query: 'latest' }, { viewId: `map:${mapId}:latest` });
    const trails =
      spec.trailMinutes > 0 ? engine.mapQuery(tableId, { ...request, query: 'trails' }, { viewId: `map:${mapId}:trails` }) : Promise.resolve(null);
    Promise.all([latest, trails]).then(
      ([aircraft, trail]) => {
        if (!live.current) return;
        const snapshot: MapSnapshot = {
          key,
          specKey: JSON.stringify(spec),
          aircraft: aircraftFromArrow(aircraft.table),
          trails: trail === null ? [] : trailsFromArrow(trail.table),
          dataClockMs,
          engineMs: aircraft.engineMs + (trail?.engineMs ?? 0),
        };
        setData({ key, value: { status: 'ready', snapshot } });
      },
      (error: unknown) => {
        if (!live.current || isAbandoned(error)) return;
        const message = error instanceof Error ? error.message : String(error);
        setData((before) => ({ key, value: { status: 'error', message, previous: before ? lastSnapshot(before.value) : null } }));
      },
    );
    return () => {
      live.current = false;
    };
    // `key` stands for table, spec, clock and data version by value.
  }, [engine, key, mapId]);

  if (tableId === null || dataClockMs === null) return { status: 'idle' };
  if (data?.key === key) return data.value;
  return { status: 'loading', previous: data ? lastSnapshot(data.value) : null };
}

function lastSnapshot(data: MapData): MapSnapshot | null {
  if (data.status === 'ready') return data.snapshot;
  if (data.status === 'idle') return null;
  return data.previous;
}

/** The selected aircraft's track (L4): its fixes up to T, or nothing. */
export type MapTrack =
  | { readonly status: 'none' }
  | { readonly status: 'loading'; readonly previous: MapTrackSnapshot | null }
  | { readonly status: 'ready'; readonly snapshot: MapTrackSnapshot }
  | { readonly status: 'error'; readonly message: string };

export interface MapTrackSnapshot {
  readonly key: string;
  readonly hex: string;
  readonly points: MapTrailRow[];
  readonly dataClockMs: number;
}

const NO_TRACK: MapTrack = Object.freeze({ status: 'none' });

/**
 * How far ahead of T a track is asked for: up to the next whole minute of
 * data time. The track (cut back to T here) is asked for again only when T
 * crosses one, not on every step of a playing cursor (every 10 s of data
 * at 10×); a new selection or new data asks at once.
 */
export const MAP_TRACK_STEP_MS = 60_000;

/**
 * The selected aircraft's track up to T (docs/live-flights-l4.md): one
 * `track` request (view scoped `map:<id>:track`, so a newer one supersedes
 * it) up to T's next whole minute (MAP_TRACK_STEP_MS) whenever the
 * selection, that minute or the data change; its fixes after T are left
 * out here. The previous track stays while the next loads, if it is the
 * same aircraft's.
 */
export function useMapTrack(
  engine: Pick<EngineClientLike, 'mapQuery'>,
  tableId: TableId | null,
  mapId: string,
  spec: MapSpec,
  dataClockMs: number | null,
  dataVersion: number,
  hex: string | null,
): MapTrack {
  const horizon = dataClockMs === null ? null : Math.ceil(dataClockMs / MAP_TRACK_STEP_MS) * MAP_TRACK_STEP_MS;
  const key = JSON.stringify([tableId, spec.lat, spec.lon, spec.id, spec.time, horizon, dataVersion, hex]);
  const [data, setData] = useState<{ key: string; value: MapTrack } | null>(null);
  useEffect(() => {
    if (tableId === null || horizon === null || hex === null) return;
    let live = true;
    engine.mapQuery(tableId, { spec, dataClockMs: horizon, query: 'track', aircraft: hex }, { viewId: `map:${mapId}:track` }).then(
      (result) => {
        if (live) setData({ key, value: { status: 'ready', snapshot: { key, hex, points: trailsFromArrow(result.table), dataClockMs: horizon } } });
      },
      (error: unknown) => {
        if (!live || isAbandoned(error)) return;
        setData({ key, value: { status: 'error', message: error instanceof Error ? error.message : String(error) } });
      },
    );
    return () => {
      live = false;
    };
    // `key` stands for the table, the spec's columns, the horizon, the data version and the aircraft by value.
  }, [engine, key, mapId]);
  let track: MapTrack;
  if (tableId === null || dataClockMs === null || hex === null) track = NO_TRACK;
  else if (data?.key === key) track = data.value;
  else {
    const previous = data?.value.status === 'ready' ? data.value.snapshot : data?.value.status === 'loading' ? data.value.previous : null;
    track = { status: 'loading', previous: previous?.hex === hex ? previous : null };
  }
  return useMemo(() => upTo(track, dataClockMs), [track, dataClockMs]);
}

/** A track's fixes at or before T only (it was asked for up to T's next minute). */
function upTo(track: MapTrack, atMs: number | null): MapTrack {
  if (atMs === null) return track;
  const cut = (snapshot: MapTrackSnapshot): MapTrackSnapshot => {
    const last = snapshot.points.at(-1);
    if (last === undefined || last.ts <= atMs) return snapshot.dataClockMs === atMs ? snapshot : { ...snapshot, dataClockMs: atMs };
    return { ...snapshot, points: snapshot.points.filter((point) => point.ts <= atMs), dataClockMs: atMs };
  };
  if (track.status === 'ready') return { status: 'ready', snapshot: cut(track.snapshot) };
  if (track.status === 'loading' && track.previous !== null) return { status: 'loading', previous: cut(track.previous) };
  return track;
}
