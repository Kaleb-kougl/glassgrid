import { z } from 'zod';

/**
 * Latitude/longitude boxes for flight views: which fixes count as "in view".
 * Bounds are inclusive, in WGS84 degrees, and never cross the antimeridian
 * (`west <= east`).
 */
export const FlightBboxSchema = z
  .object({
    south: z.number().min(-90).max(90),
    north: z.number().min(-90).max(90),
    west: z.number().min(-180).max(180),
    east: z.number().min(-180).max(180),
  })
  .refine((box) => box.south <= box.north && box.west <= box.east, 'south <= north and west <= east');
export type FlightBbox = z.infer<typeof FlightBboxSchema>;

/**
 * The San Francisco Bay Area: SFO, OAK, SJC, San Carlos (KSQL) and their
 * approaches. The area the live-flights fixtures and recorder cover.
 */
export const BAY_AREA_BBOX: FlightBbox = Object.freeze({ south: 37.0, north: 38.5, west: -123.0, east: -121.5 });

/** True when (lat, lon) is a finite position inside `box`, bounds included. */
export function inBbox(lat: number, lon: number, box: FlightBbox = BAY_AREA_BBOX): boolean {
  return lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east;
}

export function bboxCenter(box: FlightBbox): { lat: number; lon: number } {
  return { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 };
}

const EARTH_RADIUS_NM = 3440.065;

/** Great-circle distance in nautical miles (haversine, spherical Earth). */
export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The smallest whole number of nautical miles around the box's centre that
 * covers all four corners: the radius for a "point" query that must return
 * every aircraft in the box (the extra ones are filtered out with `inBbox`).
 */
export function bboxCoverRadiusNm(box: FlightBbox): number {
  const { lat, lon } = bboxCenter(box);
  const corners: [number, number][] = [
    [box.south, box.west],
    [box.south, box.east],
    [box.north, box.west],
    [box.north, box.east],
  ];
  return Math.ceil(Math.max(...corners.map(([cLat, cLon]) => distanceNm(lat, lon, cLat, cLon))));
}
