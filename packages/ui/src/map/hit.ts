/*
 * Picking an aircraft under the pointer: the nearest drawn glyph centre
 * within `radius` CSS px. Later entries are drawn on top, so they win ties.
 */

export interface ScreenPoint {
  readonly hex: string;
  readonly x: number;
  readonly y: number;
}

/** Default pick radius: the plane glyph's radius plus a little slack for touch. */
export const PICK_RADIUS = 14;

export function pickNearest(points: readonly ScreenPoint[], x: number, y: number, radius: number = PICK_RADIUS): string | null {
  let best: string | null = null;
  let bestD2 = radius * radius;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = p.hex;
    }
  }
  return best;
}
