import { isTemporalType, type ColumnType } from '../spec/column.js';
import { type Filter, type FilterValue, type RangeBound } from '../spec/filter.js';
import { parseTemporal } from '../sql/bins.js';
import { effectiveColumnType, type WorkspaceState } from '../state/workspace.js';
import { formatFilterNumber, formatInteger, formatNumericRange } from '../number-format.js';
import { selectionOrder } from './model.js';

/*
 * Filter chips: every active filter in words, derived from the same model
 * the views query with, so a chip and the filter it shows cannot drift
 * apart. Removing a chip dispatches the command it names, which also clears
 * the brush or click it came from.
 */

/** What removing a chip dispatches. */
export type ChipRemoval =
  | {
      readonly command: 'clearFilter';
      readonly input: { readonly viewId: string; readonly channel?: 'x' | 'y'; readonly column?: string };
    }
  | { readonly command: 'clearFilter'; readonly input: { readonly filterId: string } };

export interface FilterChip {
  /** Stable for the life of the filter: `selection:<viewId>[:<axis>]:<column>` or `filter:<filterId>`. */
  readonly id: string;
  /** The view whose selection this is, or null for a user filter. */
  readonly viewId: string | null;
  /** The user filter's id, or null for a selection. */
  readonly filterId: string | null;
  readonly column: string;
  /** The condition in words: `2.00 – 6.00`, `= Cash`, `in 4 values`, `is null`. */
  readonly condition: string;
  /** Column and condition: `trip_distance 2.00 – 6.00`, `payment_type = Cash`. */
  readonly label: string;
  readonly filter: Filter;
  readonly remove: ChipRemoval;
}

/** A number for a chip: integers as is, floats and decimals with at least two decimals (`2.00`), grouped (`1,234.50`). */
export function formatChipNumber(value: number, type: ColumnType | null): string {
  return formatFilterNumber(value, type);
}

/** A date or timestamp for a chip: `2024-03-01`, or `2024-03-01 06:30` with the time when it is not midnight. */
export function formatChipTemporal(value: RangeBound | FilterValue, type: ColumnType): string {
  if (value === null || typeof value === 'boolean') return String(value);
  const ms = parseTemporal(value);
  if (ms === null) return String(value);
  const iso = new Date(ms).toISOString();
  const date = iso.slice(0, 10);
  if (type === 'date' || ms % 86_400_000 === 0) return date;
  const seconds = iso.slice(17, 23);
  return `${date} ${iso.slice(11, 16)}${seconds === '00.000' ? '' : `:${seconds.endsWith('.000') ? seconds.slice(0, 2) : seconds}`}`;
}

function formatValue(value: FilterValue | RangeBound, type: ColumnType | null): string {
  if (value === null) return 'null';
  if (type !== null && isTemporalType(type)) return formatChipTemporal(value, type);
  if (typeof value === 'number') return formatChipNumber(value, type);
  return String(value);
}

function list(values: readonly FilterValue[], type: ColumnType | null): string {
  return values.map((value) => formatValue(value, type)).join(', ');
}

/** The condition of a filter in words, formatted for the column's type (null when unknown). */
export function filterCondition(filter: Filter, type: ColumnType | null = null): string {
  switch (filter.kind) {
    case 'range': {
      if (typeof filter.min === 'number' && typeof filter.max === 'number' && (type === null || !isTemporalType(type))) {
        // Both bounds with the same decimals, no more than the span warrants.
        const [lo, hi] = formatNumericRange(filter.min, filter.max, type);
        return `${lo} – ${hi}`;
      }
      const min = filter.min === undefined ? null : formatValue(filter.min, type);
      const max = filter.max === undefined ? null : formatValue(filter.max, type);
      if (min !== null && max !== null) return `${min} – ${max}`;
      if (min !== null) return `${filter.minInclusive ? '≥' : '>'} ${min}`;
      return `${filter.maxInclusive ? '≤' : '<'} ${max ?? ''}`;
    }
    case 'in':
      if (filter.values.length === 0) return 'matches nothing';
      if (filter.values.length === 1) return `= ${list(filter.values, type)}`;
      if (filter.values.length <= 3) return `in ${list(filter.values, type)}`;
      return `in ${formatInteger(filter.values.length)} values`;
    case 'notIn':
      if (filter.values.length === 0) return 'any value';
      if (filter.values.length === 1) return `≠ ${list(filter.values, type)}`;
      if (filter.values.length <= 3) return `not in ${list(filter.values, type)}`;
      return `not in ${formatInteger(filter.values.length)} values`;
    case 'isNull':
      return 'is null';
    case 'notNull':
      return 'is not null';
  }
}

/** `column condition`, e.g. `trip_distance 2.00 – 6.00` or `payment_type = Cash`. */
export function filterLabel(filter: Filter, type: ColumnType | null = null): string {
  return `${filter.column} ${filterCondition(filter, type)}`;
}

/**
 * Every active filter as a chip: user filters first (in the order added),
 * then each view's selection, one chip per clause (a 2-D brush shows two).
 * Removing a selection chip clears that view's selection, or only that
 * axis of a 2-D brush.
 */
export function filterChips(state: Pick<WorkspaceState, 'charts' | 'columns' | 'selections' | 'userFilters'>): FilterChip[] {
  const types = new Map(state.columns.map((column) => [column.name, effectiveColumnType(column)]));
  const typeOf = (column: string) => types.get(column) ?? null;
  const chips: FilterChip[] = state.userFilters.map((entry) => ({
    id: `filter:${entry.id}`,
    viewId: null,
    filterId: entry.id,
    column: entry.filter.column,
    condition: filterCondition(entry.filter, typeOf(entry.filter.column)),
    label: filterLabel(entry.filter, typeOf(entry.filter.column)),
    filter: entry.filter,
    remove: { command: 'clearFilter', input: { filterId: entry.id } },
  }));
  for (const viewId of selectionOrder(state)) {
    const selection = state.selections[viewId];
    if (!selection) continue;
    const several = selection.clauses.length > 1;
    selection.clauses.forEach((clause, index) => {
      const column = clause.filter.column;
      chips.push({
        id: `selection:${viewId}:${several ? `${clause.channel ?? index}:` : ''}${column}`,
        viewId,
        filterId: null,
        column,
        condition: filterCondition(clause.filter, typeOf(column)),
        label: filterLabel(clause.filter, typeOf(column)),
        filter: clause.filter,
        remove: {
          command: 'clearFilter',
          input: !several ? { viewId } : clause.channel === null ? { viewId, column } : { viewId, channel: clause.channel },
        },
      });
    });
  }
  return chips;
}
