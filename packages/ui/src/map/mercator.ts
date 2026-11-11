/*
 * Web Mercator in MapLibre's world units: x and y in 0..1 over the whole
 * world, y growing southwards (MercatorCoordinate). The aircraft layer
 * draws positions relative to a fixed origin near the Bay Area, so float32
 * vertices keep sub-pixel precision at every zoom ("relative to centre").
 */

const MAX_LAT = 85.051129;

export function mercatorX(lon: number): number {
  return (180 + lon) / 360;
}

export function mercatorY(lat: number): number {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360))) / 360;
}

export function lonOfMercatorX(x: number): number {
  return x * 360 - 180;
}

export function latOfMercatorY(y: number): number {
  const y2 = 180 - y * 360;
  return (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90;
}

/** The origin vertices are drawn relative to: (-122.25, 37.75), the middle of the flights box. */
export const ORIGIN_LON = -122.25;
export const ORIGIN_LAT = 37.75;
export const ORIGIN_X = mercatorX(ORIGIN_LON);
export const ORIGIN_Y = mercatorY(ORIGIN_LAT);

/**
 * `matrix × translate(ox, oy, 0)` in float64, written to `out` as float32:
 * a column-major 4×4 world-to-clip matrix that takes coordinates relative
 * to (ox, oy) instead of absolute ones. Only the last column changes.
 */
export function relativeMatrix(matrix: ArrayLike<number>, ox: number, oy: number, out: Float32Array = new Float32Array(16)): Float32Array {
  for (let i = 0; i < 12; i += 1) out[i] = matrix[i] ?? 0;
  for (let row = 0; row < 4; row += 1) {
    out[12 + row] = (matrix[row] ?? 0) * ox + (matrix[4 + row] ?? 0) * oy + (matrix[12 + row] ?? 0);
  }
  return out;
}

/** How wide or tall a map card may be (width / height) and still show the whole data box at its widest zoom. */
export const MAP_FIT_ASPECT = 1.8;

/**
 * The map's max bounds (how far it pans and zooms out): the basemap's box,
 * grown to a square in Mercator around `data` (the data's extent) big
 * enough that the whole of `data`, with a 10 % margin, fits a card of any
 * shape up to MAP_FIT_ASPECT wide or tall. MapLibre keeps the view inside
 * the max bounds, so with only the basemap's box a card wider than tall
 * cannot zoom out to the data's north and south edges, and the "Filter to
 * map view" box never covers every fix. Beyond the basemap the map is its
 * background colour. [west, south, east, north].
 */
export function mapMaxBounds(basemap: readonly [number, number, number, number], data: { west: number; south: number; east: number; north: number } | undefined): [number, number, number, number] {
  if (data === undefined || !(data.east > data.west) || !(data.north > data.south)) return [...basemap];
  const x0 = mercatorX(data.west);
  const x1 = mercatorX(data.east);
  const y0 = mercatorY(data.north);
  const y1 = mercatorY(data.south);
  const half = (Math.max(x1 - x0, y1 - y0) * 1.1 * MAP_FIT_ASPECT) / 2;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return [
    Math.min(basemap[0], lonOfMercatorX(cx - half)),
    Math.min(basemap[1], latOfMercatorY(cy + half)),
    Math.max(basemap[2], lonOfMercatorX(cx + half)),
    Math.max(basemap[3], latOfMercatorY(cy - half)),
  ];
}
