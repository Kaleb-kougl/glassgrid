/*
 * Counters for the map benchmark (apps/web/e2e/map-perf.spec.ts): how long
 * the aircraft layer's render took on the CPU (JavaScript and GL calls, not
 * GPU time) and what it drew. Tiny and dependency-free, so the first-load
 * entry can export it while the layer itself stays in the lazy chunk.
 */

export interface MapRenderStats {
  frames: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  glyphs: number;
  segments: number;
  /** Per-frame CPU times since the last `resetMapRenderStats()` (capped at 10,000). */
  readonly samples: number[];
}

const stats: MapRenderStats = { frames: 0, totalMs: 0, maxMs: 0, lastMs: 0, glyphs: 0, segments: 0, samples: [] };

export function recordLayerFrame(ms: number, glyphs: number, segments: number): void {
  stats.frames += 1;
  stats.totalMs += ms;
  stats.lastMs = ms;
  if (ms > stats.maxMs) stats.maxMs = ms;
  stats.glyphs = glyphs;
  stats.segments = segments;
  if (stats.samples.length < 10_000) stats.samples.push(ms);
}

/** The live counters (read them; do not keep the object across a reset). */
export function mapRenderStats(): Readonly<MapRenderStats> {
  return stats;
}

export function resetMapRenderStats(): void {
  stats.frames = 0;
  stats.totalMs = 0;
  stats.maxMs = 0;
  stats.lastMs = 0;
  stats.samples.length = 0;
}
