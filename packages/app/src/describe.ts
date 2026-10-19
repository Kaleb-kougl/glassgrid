import { formatNumber, formatNumericRange, resolveAxis, type ChartSpec, type ChartState, type CubeColumn, type Field, type Filter, type FilterValue, type UndoEntry, type WorkspaceState, type YField } from '@glassgrid/core';

/*
 * Words for state: shelf expressions, filter conditions, chart titles and
 * history labels. Kept free of React so Node tests can import it.
 */


/** `month(pickup_datetime)`, `bin(trip_distance, 1)` or the bare column. */
export function fieldExpression(field: Field): string {
  if (field.timeUnit !== undefined) return `${field.timeUnit}(${field.column})`;
  if (field.bin !== undefined) return `bin(${field.column}, ${field.bin})`;
  return field.column;
}

/** The Y shelf: `sum(fare_amount)`, or `count(*)` when y is empty. The aggregate lives here. */
export function yExpression(y: YField | undefined): string {
  if (!y) return 'count(*)';
  return `${y.aggregate ?? 'count'}(${fieldExpression(y)})`;
}

/**
 * A positional field as the chart draws it: automatic time units and bin
 * widths resolved from the profile the way the compiler resolves them
 * (`hour(pickup_at)`, `bin(trip_distance, 0.5)`). Unchanged when the channel
 * is not binned or the profile is not known yet.
 */
export function resolvedField(spec: ChartSpec, channel: 'x' | 'y', columns: readonly CubeColumn[]): Field | undefined {
  const field: Field | undefined = channel === 'x' ? spec.x : spec.y;
  if (!field) return undefined;
  const axis = resolveAxis(spec, channel, columns);
  if (axis?.kind === 'time' && field.timeUnit === undefined) return { ...field, timeUnit: axis.unit, bin: undefined };
  if (axis?.kind === 'width' && field.bin === 'auto') return { ...field, bin: axis.width };
  return field;
}

/** The X shelf (and the y shelf of heatmaps and scatter plots) as drawn: `hour(pickup_at)`, `bin(trip_distance, 0.5)`. */
export function axisExpression(spec: ChartSpec, channel: 'x' | 'y', columns: readonly CubeColumn[]): string {
  const field = resolvedField(spec, channel, columns);
  return field ? fieldExpression(field) : 'count(*)';
}

const AGGREGATE_NOUNS = { count: 'Count', sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum' } as const;

/**
 * Title for a card without one: "Rows by category", "Sum of fare_amount over
 * pickup_at", "Distribution of trip_distance", "Rows by trip_distance and
 * fare_amount", "fare_amount against trip_distance".
 */
export function defaultChartTitle(spec: Pick<ChartSpec, 'x' | 'y'> & { mark?: ChartSpec['mark'] }): string {
  const x = spec.x.column;
  const measure = spec.y ? `${AGGREGATE_NOUNS[spec.y.aggregate ?? 'count']} of ${spec.y.column}` : 'Rows';
  switch (spec.mark) {
    case 'line':
    case 'area':
      return `${measure} over ${x}`;
    case 'histogram':
      return spec.y ? `${measure} by ${x}` : `Distribution of ${x}`;
    case 'heatmap':
      return spec.y ? `Rows by ${x} and ${spec.y.column}` : `Rows by ${x}`;
    case 'scatter':
      return spec.y ? `${spec.y.column} against ${x}` : `Rows by ${x}`;
    default:
      return `${measure} by ${fieldExpression(spec.x)}`;
  }
}

export function chartTitle(chart: Pick<ChartState, 'spec' | 'title'>): string {
  return chart.title ?? defaultChartTitle(chart.spec);
}

export function formatFilterValue(value: FilterValue | string | number): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return formatNumber(value);
  return String(value);
}

/** The condition in words: `= Cash`, `in alpha, bravo`, `2.00 – 6.00`, `is null`. */
export function filterCondition(filter: Filter): string {
  switch (filter.kind) {
    case 'in': {
      const values = filter.values.map(formatFilterValue);
      if (values.length === 0) return 'matches nothing';
      if (values.length === 1) return `= ${values[0] ?? ''}`;
      if (values.length <= 3) return `in ${values.join(', ')}`;
      return `in ${values.length} values`;
    }
    case 'range': {
      if (typeof filter.min === 'number' && typeof filter.max === 'number') {
        const [lo, hi] = formatNumericRange(filter.min, filter.max);
        return `${lo} – ${hi}`;
      }
      const min = filter.min === undefined ? null : formatFilterValue(filter.min);
      const max = filter.max === undefined ? null : formatFilterValue(filter.max);
      if (min !== null && max !== null) return `${min} – ${max}`;
      if (min !== null) return `${filter.minInclusive ? '≥' : '>'} ${min}`;
      return `${filter.maxInclusive ? '≤' : '<'} ${max ?? ''}`;
    }
    case 'notIn': {
      const values = filter.values.map(formatFilterValue);
      if (values.length === 0) return 'any value';
      if (values.length === 1) return `≠ ${values[0] ?? ''}`;
      if (values.length <= 3) return `not in ${values.join(', ')}`;
      return `not in ${values.length} values`;
    }
    case 'isNull':
      return 'is null';
    case 'notNull':
      return 'is not null';
  }
}

function record(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '?';
}

/**
 * One line per undo entry, e.g. `Set amount to text` or
 * `Selected payment_type = Cash`. `state` (the current workspace) names charts.
 */
export function describeEntry(entry: Pick<UndoEntry, 'name' | 'input'>, state?: Pick<WorkspaceState, 'charts'>): string {
  const input = record(entry.input);
  const chartName = (id: unknown) => {
    const chart = state?.charts.find((candidate) => candidate.id === id);
    return chart ? `“${chartTitle(chart)}”` : 'a chart';
  };
  switch (entry.name) {
    case 'openFile':
      return `Opened ${text(input, 'fileName')}`;
    case 'setColumnType':
      return `Set ${text(input, 'column')} to ${text(input, 'type')}`;
    case 'sortGrid': {
      const sort = Array.isArray(input['sort']) ? (input['sort'] as { column: string; direction?: string }[]) : [];
      if (sort.length === 0) return 'Cleared the sort';
      return `Sorted by ${sort.map((key) => `${key.column} ${key.direction === 'desc' ? '↓' : '↑'}`).join(', ')}`;
    }
    case 'resizeColumn':
      return `Resized ${text(input, 'column')} to ${typeof input['width'] === 'number' ? input['width'] : '?'} px`;
    case 'reorderColumn':
      return `Moved ${text(input, 'column')} to position ${typeof input['toIndex'] === 'number' ? input['toIndex'] + 1 : '?'}`;
    case 'setFilter': {
      const filter = input['filter'] as Filter | undefined;
      if (!filter) return 'Set a filter';
      const verb = filter.kind === 'in' || filter.kind === 'notIn' ? 'Selected' : filter.kind === 'range' ? 'Brushed' : 'Filtered';
      return `${verb} ${filter.column} ${filterCondition(filter)}`;
    }
    case 'clearFilter':
      if (typeof input['filterId'] === 'string') return 'Removed a filter';
      return input['viewId'] === 'grid' ? 'Cleared the grid filter' : `Cleared the selection on ${chartName(input['viewId'])}`;
    case 'addFilter': {
      const filter = input['filter'] as Filter | undefined;
      return filter ? `Filtered ${filter.column} ${filterCondition(filter)}` : 'Added a filter';
    }
    case 'brush': {
      const selection = record(input['selection']);
      if (input['selection'] === null) return `Cleared the selection on ${input['viewId'] === 'grid' ? 'the grid' : chartName(input['viewId'])}`;
      return `${selection['type'] === 'points' ? 'Selected on' : 'Brushed'} ${input['viewId'] === 'grid' ? 'the grid' : chartName(input['viewId'])}`;
    }
    case 'setMark':
      return `Changed ${chartName(input['chartId'])} to a ${text(input, 'mark')} chart`;
    case 'addChart': {
      const columns = Array.isArray(input['columns']) ? (input['columns'] as unknown[]).filter((c): c is string => typeof c === 'string') : null;
      if (columns && typeof input['title'] !== 'string') return `Added a chart of ${columns.join(' and ')}`;
      const spec = input['spec'] as ChartSpec | undefined;
      const title = typeof input['title'] === 'string' ? input['title'] : spec ? defaultChartTitle(spec) : 'chart';
      return `Added chart “${title}”`;
    }
    case 'removeChart':
      return 'Removed a chart';
    case 'renameChart':
      return typeof input['title'] === 'string' ? `Renamed a chart to “${input['title']}”` : 'Reset a chart title';
    case 'setShelf': {
      const shelf = text(input, 'shelf');
      const field = input['field'] as YField | null | undefined;
      const label = shelf === 'color' ? 'Color' : shelf.toUpperCase();
      if (!field) return shelf === 'y' ? `Set Y to count(*) on ${chartName(input['chartId'])}` : `Cleared ${label} on ${chartName(input['chartId'])}`;
      return `Set ${label} to ${shelf === 'y' ? yExpression(field) : fieldExpression(field)}`;
    }
    default:
      return entry.name;
  }
}
