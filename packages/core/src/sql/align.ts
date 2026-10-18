import { type CrossfilterDimension } from '../spec/crossfilter.js';
import { type Filter } from '../spec/filter.js';
import { binStart, parseTemporal, truncateTime } from './bins.js';

/** How a cube answers a selection on its dimension. */
export type CubeSelection =
  /** Width bins: the bin indexes `[min, max)` the range covers exactly (null = open end). */
  | { readonly kind: 'bins'; readonly min: number | null; readonly max: number | null }
  /** The filter applies to the cube's `gb` column as is (value and time dimensions, NULL tests). */
  | { readonly kind: 'filter' };

/**
 * Whether a cube grouped by `dimension` can answer `selection` exactly, and
 * how. Null when it cannot (another column, or a range that cuts through a
 * bin): the caller then queries the table.
 *
 * - `value`: any filter on the column (gb is the value itself).
 * - `time`: a range whose bounds are bucket starts, min inclusive and max
 *   exclusive; or isNull / notNull.
 * - `width`: a range whose bounds are bin starts (`binStart(k, width)`, how
 *   brushes snap: the rows of bins k to m - 1 exactly as `floor(v / width)`
 *   bins them), min inclusive and max exclusive; or isNull / notNull.
 */
export function cubeSelection(selection: Filter, dimension: CrossfilterDimension): CubeSelection | null {
  if (selection.column !== dimension.column) return null;
  const bin = dimension.bin;
  if (bin.kind === 'value') return { kind: 'filter' };
  if (selection.kind === 'isNull' || selection.kind === 'notNull') return { kind: 'filter' };
  if (selection.kind !== 'range') return null;
  if (selection.min !== undefined && !selection.minInclusive) return null;
  if (selection.max !== undefined && selection.maxInclusive) return null;
  if (bin.kind === 'time') {
    for (const bound of [selection.min, selection.max]) {
      if (bound === undefined) continue;
      const ms = parseTemporal(bound);
      if (ms === null || truncateTime(ms, bin.unit) !== ms) return null;
    }
    return { kind: 'filter' };
  }
  const index = (bound: number | string | undefined): number | null | undefined => {
    if (bound === undefined) return null;
    if (typeof bound !== 'number') return undefined;
    const k = Math.round(bound / bin.width) + 0; // + 0 turns -0 into 0
    return Number.isSafeInteger(k) && binStart(k, bin.width) === bound ? k : undefined;
  };
  const min = index(selection.min);
  const max = index(selection.max);
  if (min === undefined || max === undefined) return null;
  return { kind: 'bins', min, max };
}
