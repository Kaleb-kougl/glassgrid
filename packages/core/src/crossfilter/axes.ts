import { type ChartSpec } from '../spec/chart.js';
import { isNumericType, isTemporalType } from '../spec/column.js';
import { type CrossfilterDimension } from '../spec/crossfilter.js';
import { type Field, type TimeUnit } from '../spec/field.js';
import { autoTimeUnit, niceBinWidth } from '../sql/bins.js';
import { HEATMAP_TARGET_BINS, HISTOGRAM_TARGET_BINS, LINE_AUTO_MAX_BUCKETS } from '../sql/chart.js';
import { type CubeColumn } from '../sql/cube.js';
import { currentProfile, effectiveColumnType, type WorkspaceState } from '../state/workspace.js';

/**
 * The workspace's columns as the compiler sees them: effective types, plus
 * min, max and distinct count from the recorded profile when it is current.
 */
export function stateColumns(state: Pick<WorkspaceState, 'columns'>): CubeColumn[] {
  return state.columns.map((column) => {
    const profile = currentProfile(column);
    return {
      name: column.name,
      type: effectiveColumnType(column),
      ...(profile === null ? {} : { min: profile.min, max: profile.max, distinctCount: profile.distinctCount }),
    };
  });
}

/** How a chart groups one positional channel, resolved exactly as the compiler does. */
export type ResolvedAxis =
  /** Distinct values: bar categories, raw scatter and line axes. */
  | { readonly kind: 'raw'; readonly column: CubeColumn }
  /** Numeric bins `[k * width, (k + 1) * width)`. */
  | { readonly kind: 'width'; readonly column: CubeColumn; readonly width: number }
  /** `date_trunc(unit)` buckets. */
  | { readonly kind: 'time'; readonly column: CubeColumn; readonly unit: TimeUnit };

function findColumn(columns: readonly CubeColumn[], name: string): CubeColumn | null {
  return columns.find((column) => column.name === name) ?? null;
}

function binned(field: Field, column: CubeColumn, target: number): ResolvedAxis | null {
  if (isTemporalType(column.type)) {
    return {
      kind: 'time',
      column,
      unit: field.timeUnit ?? autoTimeUnit(column.min, column.max, column.type, { mode: 'closest', target }),
    };
  }
  if (!isNumericType(column.type)) return null;
  if (typeof field.bin === 'number') return { kind: 'width', column, width: field.bin };
  const min = typeof column.min === 'number' ? column.min : null;
  const max = typeof column.max === 'number' ? column.max : null;
  const width = min === null || max === null ? 1 : niceBinWidth(min, max, target, column.type === 'integer');
  return { kind: 'width', column, width };
}

/**
 * How `spec` groups its x or y channel (mirrors the compiler, including
 * automatic bin widths and time units from the profile), or null when the
 * channel is not positional for this mark. A line chart's automatic numeric
 * bins depend on the plot width, which state does not know; such an axis is
 * reported as raw (brushes on it are not snapped).
 */
export function resolveAxis(spec: ChartSpec, channel: 'x' | 'y', columns: readonly CubeColumn[]): ResolvedAxis | null {
  const field = channel === 'x' ? spec.x : spec.y;
  if (!field) return null;
  const column = findColumn(columns, field.column);
  if (!column) return null;
  switch (spec.mark) {
    case 'bar':
      if (channel === 'y') return null;
      if (field.timeUnit !== undefined && isTemporalType(column.type)) return { kind: 'time', column, unit: field.timeUnit };
      return { kind: 'raw', column };
    case 'histogram':
      return channel === 'x' ? binned(field, column, HISTOGRAM_TARGET_BINS) : null;
    case 'heatmap':
      return binned(field, column, HEATMAP_TARGET_BINS);
    case 'line':
    case 'area':
      if (channel === 'y') return null;
      if (isTemporalType(column.type)) {
        return {
          kind: 'time',
          column,
          unit: field.timeUnit ?? autoTimeUnit(column.min, column.max, column.type, { mode: 'finest', max: LINE_AUTO_MAX_BUCKETS }),
        };
      }
      if (typeof field.bin === 'number' && isNumericType(column.type)) return { kind: 'width', column, width: field.bin };
      return isNumericType(column.type) ? { kind: 'raw', column } : null;
    case 'scatter':
      return isNumericType(column.type) || isTemporalType(column.type) ? { kind: 'raw', column } : null;
  }
}

/** The cross-filter dimension a selection on `axis` is made in. */
export function axisDimension(axis: ResolvedAxis): CrossfilterDimension {
  switch (axis.kind) {
    case 'raw':
      return { column: axis.column.name, bin: { kind: 'value' } };
    case 'width':
      return { column: axis.column.name, bin: { kind: 'width', width: axis.width } };
    case 'time':
      return { column: axis.column.name, bin: { kind: 'time', unit: axis.unit } };
  }
}
