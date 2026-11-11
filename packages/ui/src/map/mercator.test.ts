import { describe, expect, it } from 'vitest';
import { latOfMercatorY, lonOfMercatorX, MAP_FIT_ASPECT, mapMaxBounds, mercatorX, mercatorY } from './mercator.js';

/*
 * The map's max bounds (L4 review): with only the basemap's box, a card
 * wider than tall could not zoom out to the data's north and south edges,
 * so "Filter to map view" dropped fixes even at full zoom-out.
 */

const BASEMAP = [-123.25, 36.75, -121.25, 38.75] as const;
const DATA = { west: -123.0, south: 37.0, east: -121.5, north: 38.5 };

/** The view MapLibre would allow at the widest zoom for a card of `aspect` (width / height) inside `bounds`: does it cover `DATA`? */
function fits(bounds: readonly [number, number, number, number], aspect: number): boolean {
  const width = mercatorX(bounds[2]) - mercatorX(bounds[0]);
  const height = mercatorY(bounds[1]) - mercatorY(bounds[3]);
  // The widest view keeps the card's shape and stays inside the bounds.
  const viewWidth = Math.min(width, height * aspect);
  const viewHeight = viewWidth / aspect;
  return viewWidth >= mercatorX(DATA.east) - mercatorX(DATA.west) && viewHeight >= mercatorY(DATA.south) - mercatorY(DATA.north);
}

describe('mapMaxBounds', () => {
  it('the basemap alone cannot show all the data in a card wider than tall', () => {
    expect(fits(BASEMAP, 454 / 359)).toBe(false);
  });

  it('grows around the data so a card of any shape up to MAP_FIT_ASPECT shows all of it, never smaller than the basemap', () => {
    const bounds = mapMaxBounds(BASEMAP, DATA);
    for (const aspect of [1 / MAP_FIT_ASPECT, 0.75, 1, 454 / 359, 1.5, MAP_FIT_ASPECT]) expect(fits(bounds, aspect)).toBe(true);
    expect(bounds[0]).toBeLessThanOrEqual(BASEMAP[0]);
    expect(bounds[1]).toBeLessThanOrEqual(BASEMAP[1]);
    expect(bounds[2]).toBeGreaterThanOrEqual(BASEMAP[2]);
    expect(bounds[3]).toBeGreaterThanOrEqual(BASEMAP[3]);
    // Centred on the data.
    expect((mercatorX(bounds[0]) + mercatorX(bounds[2])) / 2).toBeCloseTo((mercatorX(DATA.west) + mercatorX(DATA.east)) / 2, 6);
    expect(latOfMercatorY((mercatorY(bounds[1]) + mercatorY(bounds[3])) / 2)).toBeCloseTo(latOfMercatorY((mercatorY(DATA.south) + mercatorY(DATA.north)) / 2), 4);
    expect(lonOfMercatorX(mercatorX(-122))).toBeCloseTo(-122, 9);
  });

  it('without data (or an empty box) it is the basemap', () => {
    expect(mapMaxBounds(BASEMAP, undefined)).toEqual([...BASEMAP]);
    expect(mapMaxBounds(BASEMAP, { west: -122, south: 37, east: -122, north: 38 })).toEqual([...BASEMAP]);
  });
});
