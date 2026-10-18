import {
  formatChipNumber,
  formatChipTemporal,
  isTemporalType,
  type BrushSelectionInput,
  type ColumnType,
  type FilterValue,
  type Selection,
} from '@glassgrid/core';
import { OTHER_BAR_KEY, valueKey, type BarDatum, type BrushValue, type IntervalSelection } from '@glassgrid/ui';

/*
 * Between the store's selections (filters per view, snapped by the `brush`
 * command) and what the chart components draw and report (data-space
 * intervals, bar keys).
 */

/** A chart's own selection as the brushable marks draw it; null without one (or with an open-ended range). */
export function intervalOf(selection: Selection | undefined): IntervalSelection | null {
  if (!selection) return null;
  let x: readonly [BrushValue, BrushValue] | undefined;
  let y: readonly [BrushValue, BrushValue] | undefined;
  for (const clause of selection.clauses) {
    const filter = clause.filter;
    if (filter.kind !== 'range' || filter.min === undefined || filter.max === undefined) continue;
    if (clause.channel === 'y') y = [filter.min, filter.max];
    else x = [filter.min, filter.max];
  }
  if (!x) return null;
  return y ? { x, y } : { x };
}

/** The `brush` command's input for a released brush (raw extent; the command snaps it). */
export function brushInputOf(selection: IntervalSelection): BrushSelectionInput {
  return {
    type: 'interval',
    x: { min: selection.x[0], max: selection.x[1] },
    ...(selection.y ? { y: { min: selection.y[0], max: selection.y[1] } } : {}),
  };
}

/** Keys of the bars a selection covers: clicked values (`in`), or the "Other" bar plus every bar not excluded (`notIn`). */
export function selectedBarKeys(selection: Selection | undefined, column: string, rows: readonly BarDatum[]): Set<string> {
  const keys = new Set<string>();
  const filter = selection?.clauses.find((clause) => clause.filter.column === column)?.filter;
  if (!filter) return keys;
  if (filter.kind === 'in') {
    for (const value of filter.values) keys.add(valueKey(value));
  } else if (filter.kind === 'notIn') {
    const excluded = new Set(filter.values.map(valueKey));
    for (const row of rows) if (!row.isOther && !excluded.has(row.key)) keys.add(row.key);
    keys.add(OTHER_BAR_KEY);
  }
  return keys;
}

/**
 * Toggling one bar: the `brush` points for the new set of bars, or null when
 * none is left. With the "Other" bar selected, `other.shown` lists every
 * named bar on screen (Other = every value not shown).
 */
export function toggleBar(selected: ReadonlySet<string>, rows: readonly BarDatum[], bar: BarDatum): BrushSelectionInput | null {
  const next = new Set(selected);
  if (next.has(bar.key)) next.delete(bar.key);
  else next.add(bar.key);
  const named = rows.filter((row) => !row.isOther);
  const values: FilterValue[] = named.filter((row) => next.has(row.key)).map((row) => row.filterValue ?? null);
  if (next.has(OTHER_BAR_KEY)) return { type: 'points', values, other: { shown: named.map((row) => row.filterValue ?? null) } };
  return values.length === 0 ? null : { type: 'points', values };
}

function bound(value: BrushValue, type: ColumnType | null): string {
  if (type !== null && isTemporalType(type)) return formatChipTemporal(value, type);
  return typeof value === 'number' ? formatChipNumber(value, type) : value;
}

/** A brush being dragged, in words for the card header: `2.00 – 6.00`, `2024-03-03 – 2024-03-06`. */
export function intervalSummary(selection: IntervalSelection, xType: ColumnType | null, yType: ColumnType | null): string {
  const x = `${bound(selection.x[0], xType)} – ${bound(selection.x[1], xType)}`;
  return selection.y ? `${x} × ${bound(selection.y[0], yType)} – ${bound(selection.y[1], yType)}` : x;
}
