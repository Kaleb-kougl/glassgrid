import { type RangeFilter } from '../spec/filter.js';
import { type MapViewportBounds, type MapViewState } from '../state/workspace.js';

/*
 * A map view's selection (milestone L4, docs/live-flights-l4.md): the box it
 * shows, as two range filters on the spec's latitude and longitude columns.
 * Every other view queries with them, and the map itself does not, exactly
 * as a chart never queries with its own brush (model.ts, `compose`).
 *
 * The box comes from the map component (`onViewportChange`, 200 ms after a
 * pan or zoom ends) through `setMapViewport`, which records no undo entry:
 * the camera is not part of the history, and the filter always equals what
 * the map shows. The person turns it on and off with `setMapViewFilter`
 * ("Filter to map view"), which is undoable.
 */

/** Positions are stored to 5 decimals (about 1 m, `flight_states`' DECIMAL(7,5) / (8,5)); boxes are rounded outwards to that. */
const DECIMALS = 1e5;

/** `value × 1e5`, snapped to the nearest integer when it is one up to floating-point noise (38.2 × 1e5 is 3820000.0000000005). */
function scaled(value: number): number {
  const exact = value * DECIMALS;
  const nearest = Math.round(exact);
  return Math.abs(exact - nearest) < 1e-6 ? nearest : exact;
}
const down = (value: number) => Math.floor(scaled(value)) / DECIMALS;
const up = (value: number) => Math.ceil(scaled(value)) / DECIMALS;

/** A reported box rounded outwards to whole 1e-5 degrees, so a fix on its edge stays inside and keys stay short. */
export function roundBounds(bounds: MapViewportBounds): MapViewportBounds {
  return { west: down(bounds.west), south: down(bounds.south), east: up(bounds.east), north: up(bounds.north) };
}

/** Whether a map's viewport filters the other views now: its filter is on (the default) and it has reported a box. */
export function mapFiltersView(map: Pick<MapViewState, 'filterToView' | 'viewport'>): boolean {
  return map.filterToView !== false && map.viewport !== undefined;
}

/**
 * The filters a map's viewport applies to the other views: `lon` within
 * [west, east] (channel x) and `lat` within [south, north] (channel y),
 * both inclusive; none when its filter is off or it has not reported a box.
 */
export function mapViewportFilters(map: Pick<MapViewState, 'spec' | 'filterToView' | 'viewport'>): RangeFilter[] {
  const box = map.viewport;
  if (map.filterToView === false || box === undefined) return [];
  return [
    { kind: 'range', column: map.spec.lon, min: box.west, max: box.east, minInclusive: true, maxInclusive: true },
    { kind: 'range', column: map.spec.lat, min: box.south, max: box.north, minInclusive: true, maxInclusive: true },
  ];
}

function degrees(value: number): string {
  const abs = Math.abs(value);
  return abs.toFixed(abs >= 100 ? 2 : 3);
}

/** `37.215–37.944°N`, or `1.000°S–2.000°N` across the equator (likewise E/W). */
function span(from: number, to: number, positive: string, negative: string): string {
  const hemisphere = (value: number) => (value < 0 ? negative : positive);
  if (hemisphere(from) === hemisphere(to)) return `${degrees(from)}–${degrees(to)}°${hemisphere(to)}`;
  return `${degrees(from)}°${hemisphere(from)}–${degrees(to)}°${hemisphere(to)}`;
}

/** The box in words, as its chip shows it: `37.215–37.944°N, 122.583–121.921°W`. */
export function viewportCondition(box: MapViewportBounds): string {
  return `${span(box.south, box.north, 'N', 'S')}, ${span(box.west, box.east, 'E', 'W')}`;
}
