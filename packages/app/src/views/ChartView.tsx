import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  compileChartQuery,
  effectiveColumnType,
  formatInteger,
  isNumericType,
  measureFormatter,
  isTemporalType,
  specForMark,
  type Aggregate,
  type BrushSelectionInput,
  type ChartSpec,
  type ChartState,
  type ChartViewQuery,
  type ColumnState,
  type ColumnType,
  type CubeColumn,
  type FilterChip,
  type Mark,
  type Selection,
  type TableId,
} from '@glassgrid/core';
import {
  AreaChart,
  BarChart,
  barDataFromArrow,
  chartColumnsFromArrow,
  ChartCard,
  decimalScaleOf,
  Heatmap,
  Histogram,
  LineChart,
  ScatterChart,
  ShelfChip,
  ViewData,
  type ChartColumns,
  type IntervalSelection,
  type MenuEntry,
  type ResolvedTokens,
} from '@glassgrid/ui';
import { axisExpression, chartTitle, yExpression } from '../describe';
import type { EngineClientLike } from '../engine';
import { renderPerf } from '../render-perf-core';
import { useChartQuery, type ChartResult } from './chart-data';
import { brushInputOf, intervalOf, intervalSummary, selectedBarKeys, toggleBar } from './selection';

export interface ChartViewProps {
  engine: Pick<EngineClientLike, 'aggregate'>;
  tableId: TableId | null;
  /** Bumped when the engine's data changed under the same spec (type overrides, engine restart). */
  dataVersion: number;
  chart: ChartState;
  /** The chart's query inputs from `viewQueries`: its spec with every other view's selection, key and cube hint. */
  query: ChartViewQuery;
  /** This chart's own selection, if any. */
  selection: Selection | undefined;
  /** The filter chips of this chart's selection (header summary). */
  chips: readonly FilterChip[];
  columns: readonly ColumnState[];
  /** The workspace's columns as the compiler sees them (resolved bins, valid marks). */
  compileColumns: readonly CubeColumn[];
  /** Plot width in device pixels sent with line and area aggregates (M4). */
  pixelWidth: number;
  tokens: ResolvedTokens;
  /** Caller of the latest change to this chart, for the "by AI" label. */
  addedBy: 'user' | 'ai';
  /** Column being dragged from the list, for drop hints. */
  draggingColumn: string | null;
  dispatch: (name: string, input: unknown) => void;
  onRemove: () => void;
  /** Pointer down on the plot: a brush or click may follow (build the cross-filter cubes now). */
  onBrushStart: (chartId: string) => void;
  /** A brush released or a bar toggled: the `brush` command's selection, or null to clear. */
  onBrushEnd: (chartId: string, selection: BrushSelectionInput | null) => void;
  /** The chart drew `result` on its canvas. */
  onDrawn: (chartId: string, result: ChartResult) => void;
  /** Place among the cards, for the accessible name ("Line chart, 2 of 4"). */
  position: { index: number; count: number };
}

const AGGREGATES: readonly Aggregate[] = ['count', 'sum', 'avg', 'min', 'max'];

const MARKS: readonly { mark: Mark; label: string }[] = [
  { mark: 'bar', label: 'Bar chart' },
  { mark: 'line', label: 'Line chart' },
  { mark: 'area', label: 'Area chart' },
  { mark: 'histogram', label: 'Histogram' },
  { mark: 'heatmap', label: 'Heatmap' },
  { mark: 'scatter', label: 'Scatter plot' },
];

function aggregateAllowed(aggregate: Aggregate, type: ColumnType | null): boolean {
  if (type === null) return aggregate === 'count';
  if (aggregate === 'sum' || aggregate === 'avg') return isNumericType(type);
  if (aggregate === 'min' || aggregate === 'max') return isNumericType(type) || isTemporalType(type);
  return true;
}

/** Whether the chart can switch to `mark` (the shelves `setMark` would derive compile). */
function markAllowed(spec: ChartSpec, mark: Mark, columns: readonly CubeColumn[]): boolean {
  if (spec.mark === mark) return true;
  try {
    compileChartQuery('"t"', specForMark(spec, mark, columns), columns);
    return true;
  } catch {
    return false;
  }
}

/** Positional marks with a second axis on y. */
function twoAxes(mark: Mark): boolean {
  return mark === 'heatmap' || mark === 'scatter';
}

/** Series keys in palette order: the first result's, with series first seen later appended (colours stay put while filters change). */
function mergeColorKeys(previous: readonly string[], data: ChartColumns): string[] {
  const keys = [...previous];
  for (const series of data.seriesList) if (!keys.includes(series.key)) keys.push(series.key);
  return keys;
}

/** One chart card wired to the store: shelves, the mark's renderer, brushing and clicks, menu and "View data". */
export function ChartView({
  engine,
  tableId,
  dataVersion,
  chart,
  query,
  selection,
  chips,
  columns,
  compileColumns,
  pixelWidth,
  tokens,
  addedBy,
  draggingColumn,
  dispatch,
  onRemove,
  onBrushStart,
  onBrushEnd,
  onDrawn,
  position,
}: ChartViewProps) {
  const { spec } = chart;
  const data = useChartQuery(engine, tableId, query, pixelWidth, dataVersion);
  const [viewData, setViewData] = useState(false);
  const title = chartTitle(chart);
  const testId = `chart-${chart.id}`;
  const typeOf = useCallback(
    (name: string | undefined): ColumnType | null => {
      const column = name === undefined ? undefined : columns.find((candidate) => candidate.name === name);
      return column ? effectiveColumnType(column) : null;
    },
    [columns],
  );

  // The result on screen: the latest, or the previous one while a new query runs (or failed).
  const result = data.status === 'ready' ? data.result : data.previous;
  const mark: Mark = result?.mark ?? spec.mark;
  if (__GG_RENDER_PERF__ && result) renderPerf.chartResult(chart.id, result);
  const adapted = useMemo(() => {
    if (!result) return null;
    if (__GG_RENDER_PERF__) return renderPerf.timed('adapt', chart.id, () => chartColumnsFromArrow(result.table, mark));
    return chartColumnsFromArrow(result.table, mark);
  }, [result, mark, chart.id]);
  const bars = useMemo(() => (result && adapted && mark === 'bar' ? barDataFromArrow(result.table, adapted) : null), [result, adapted, mark]);

  // Stable series colours per colour field across re-queries.
  const colorColumn = spec.color?.column ?? null;
  const [colors, setColors] = useState<{ column: string | null; data: ChartColumns | null; keys: string[] }>({ column: colorColumn, data: null, keys: [] });
  let colorKeys = colors.keys;
  if (adapted && (colors.data !== adapted || colors.column !== colorColumn)) {
    colorKeys = mergeColorKeys(colors.column === colorColumn ? colors.keys : [], adapted);
    setColors({ column: colorColumn, data: adapted, keys: colorKeys });
  }

  // A brush being dragged: shown in the header, updated at most once per frame.
  const [draft, setDraft] = useState<IntervalSelection | null>(null);
  const draftFrame = useRef<{ id: number | null; value: IntervalSelection | null }>({ id: null, value: null });
  useEffect(
    () => () => {
      if (draftFrame.current.id !== null) cancelAnimationFrame(draftFrame.current.id);
    },
    [],
  );
  const onBrush = useCallback(
    (next: IntervalSelection | null, phase: 'move' | 'end') => {
      const frame = draftFrame.current;
      if (phase === 'move') {
        frame.value = next;
        if (frame.id === null) {
          frame.id = requestAnimationFrame(() => {
            frame.id = null;
            setDraft(frame.value);
          });
        }
        return;
      }
      if (frame.id !== null) cancelAnimationFrame(frame.id);
      frame.id = null;
      setDraft(null);
      onBrushEnd(chart.id, next ? brushInputOf(next) : null);
    },
    [chart.id, onBrushEnd],
  );

  const interval = useMemo(() => intervalOf(selection), [selection]);
  const selectedKeys = useMemo(() => selectedBarKeys(selection, spec.x.column, bars?.rows ?? []), [selection, spec.x.column, bars]);

  const drawn = useCallback(() => {
    if (result) onDrawn(chart.id, result);
  }, [chart.id, result, onDrawn]);

  // Labels: positional fields as drawn (auto bins and time units resolved), measures as `sum(fare_amount)`.
  const fellBack = result?.fellBackToHeatmap === true;
  const xLabel = fellBack ? spec.x.column : axisExpression(spec, 'x', compileColumns);
  const yLabel = fellBack ? (spec.y?.column ?? 'y') : twoAxes(spec.mark) ? axisExpression(spec, 'y', compileColumns) : yExpression(spec.y);
  const colorLabel = spec.color?.column;

  // Measures: one number format per result, from the aggregate, the column's type and the result's DECIMAL scale.
  const yType = typeOf(spec.y?.column);
  const yAggregate = spec.y?.aggregate;
  const formatValue = useMemo(() => {
    if (!result || !adapted) return undefined;
    // Heatmaps colour by row count; scatter plots draw no measure.
    if (mark === 'heatmap' || mark === 'scatter' || !spec.y) return measureFormatter({ aggregate: 'count' }, mark === 'heatmap' ? (adapted.count ?? adapted.y) : adapted.y);
    return measureFormatter({ aggregate: yAggregate ?? 'count', type: yType, scale: decimalScaleOf(result.table, 'y') }, adapted.y);
  }, [result, adapted, mark, spec.y, yAggregate, yType]);

  let body: ReactNode = null;
  if (result && adapted) {
    const common = { table: result.table, data: adapted, tokens, label: title, xLabel, yLabel, onDrawn: drawn, testId: `${testId}-chart`, formatValue };
    switch (mark) {
      case 'bar':
        body = bars && (
          <BarChart
            data={bars.rows}
            series={bars.series}
            selected={selectedKeys}
            onToggle={(bar) => onBrushEnd(chart.id, toggleBar(selectedKeys, bars.rows, bar))}
            tokens={tokens}
            valueLabel={yLabel}
            {...(formatValue ? { formatValue } : {})}
            label={`${title}: bar chart of ${yLabel} by ${xLabel}`}
            {...(colorLabel === undefined ? {} : { colorLabel })}
            colorKeys={colorKeys}
            onDrawn={drawn}
            testId={`${testId}-bars`}
          />
        );
        break;
      case 'line':
        body = <LineChart {...common} colorLabel={colorLabel} colorKeys={colorKeys} selection={interval} onBrush={onBrush} />;
        break;
      case 'area':
        body = <AreaChart {...common} colorLabel={colorLabel} colorKeys={colorKeys} selection={interval} onBrush={onBrush} />;
        break;
      case 'histogram':
        body = <Histogram {...common} colorLabel={colorLabel} colorKeys={colorKeys} selection={interval} onBrush={onBrush} />;
        break;
      case 'heatmap':
        body = <Heatmap {...common} selection={interval} onBrush={onBrush} />;
        break;
      case 'scatter':
        body = <ScatterChart {...common} colorLabel={colorLabel} colorKeys={colorKeys} selection={interval} onBrush={onBrush} />;
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Shelves

  const binned = spec.mark === 'histogram' || spec.mark === 'heatmap';
  const setShelf = (shelf: 'x' | 'y' | 'color', field: unknown) => dispatch('setShelf', { chartId: chart.id, shelf, field });
  const dropOnX = (column: string) => setShelf('x', binned ? { column, bin: 'auto' } : { column });
  const dropOnY = (column: string) => {
    if (spec.mark === 'heatmap') setShelf('y', { column, bin: 'auto' });
    else if (spec.mark === 'scatter') setShelf('y', { column });
    else {
      const type = typeOf(column);
      setShelf('y', { column, aggregate: type !== null && isNumericType(type) ? 'sum' : 'count' });
    }
  };
  const dropOnColor = (column: string) => setShelf('color', { column });
  // A column dropped on the card itself: numbers go to Y, dates to X, categories split by colour (heatmaps colour by count).
  const dropOnCard = (column: string) => {
    const type = typeOf(column);
    if (type !== null && isTemporalType(type)) dropOnX(column);
    else if ((type !== null && isNumericType(type)) || spec.mark === 'heatmap') dropOnY(column);
    else dropOnColor(column);
  };

  const countRows: MenuEntry = {
    kind: 'radio',
    id: 'rows',
    label: 'count(*)',
    checked: !spec.y,
    onSelect: () => setShelf('y', null),
  };
  const yMenu: MenuEntry[] | undefined = twoAxes(spec.mark)
    ? undefined
    : spec.y
      ? [
          ...AGGREGATES.filter((aggregate) => aggregateAllowed(aggregate, yType)).map(
            (aggregate): MenuEntry => ({
              kind: 'radio',
              id: aggregate,
              label: `${aggregate}(${spec.y?.column ?? ''})`,
              checked: spec.y?.aggregate === aggregate,
              onSelect: () => setShelf('y', { column: spec.y?.column, aggregate }),
            }),
          ),
          countRows,
        ]
      : [countRows];

  const shelves = (
    <div className="gg-shelves">
      <ShelfChip shelf="X" value={xLabel} addedBy={addedBy} onDropColumn={dropOnX} pendingColumn={draggingColumn} testId={`${testId}-shelf-x`} />
      <ShelfChip
        shelf="Y"
        value={twoAxes(spec.mark) ? (spec.y ? yLabel : undefined) : yExpression(spec.y)}
        addedBy={addedBy}
        {...(yMenu ? { menu: yMenu, menuLabel: 'Y aggregate' } : {})}
        onDropColumn={dropOnY}
        pendingColumn={draggingColumn}
        onRemove={spec.y && !twoAxes(spec.mark) ? () => setShelf('y', null) : undefined}
        testId={`${testId}-shelf-y`}
      />
      {spec.mark === 'heatmap' ? (
        <ShelfChip shelf="Color" title="Heatmap cells are coloured by their row count." testId={`${testId}-shelf-color`} />
      ) : (
        <ShelfChip
          shelf="Color"
          {...(colorLabel === undefined ? {} : { value: colorLabel })}
          addedBy={addedBy}
          onDropColumn={dropOnColor}
          pendingColumn={draggingColumn}
          {...(colorLabel === undefined ? {} : { onRemove: () => setShelf('color', null) })}
          testId={`${testId}-shelf-color`}
        />
      )}
    </div>
  );

  // ---------------------------------------------------------------------------
  // Header: this chart's own selection (the brush being dragged, else its chips)

  const ownSelection =
    draft !== null
      ? intervalSummary(draft, typeOf(spec.x.column), typeOf(spec.y?.column))
      : spec.mark === 'bar' && selectedKeys.size > 0
        ? `${selectedKeys.size} selected`
        : chips.length > 0
          ? chips.map((chip) => chip.condition).join(' × ')
          : null;

  const status = data.status === 'loading' ? 'loading' : data.status === 'error' ? 'error' : 'ready';

  return (
    <ChartCard
      testId={testId}
      title={title}
      description={`${MARKS.find((option) => option.mark === mark)?.label ?? mark}, ${position.index + 1} of ${position.count}`}
      attribution={addedBy === 'ai' ? 'ai' : undefined}
      onRename={(next) => dispatch('renameChart', { chartId: chart.id, title: next })}
      selection={ownSelection === null ? undefined : { summary: ownSelection, onClear: () => dispatch('clearFilter', { viewId: chart.id }) }}
      menu={[
        ...(chart.title !== undefined
          ? [{ id: 'reset-title', label: 'Reset title', onSelect: () => dispatch('renameChart', { chartId: chart.id, title: null }) } satisfies MenuEntry]
          : []),
        { kind: 'separator', id: 'marks-start' },
        ...MARKS.map(
          ({ mark: option, label }): MenuEntry => ({
            kind: 'radio',
            id: `mark-${option}`,
            label,
            checked: spec.mark === option,
            disabled: !markAllowed(spec, option, compileColumns),
            onSelect: () => dispatch('setMark', { chartId: chart.id, mark: option }),
          }),
        ),
        { kind: 'separator', id: 'marks-end' },
        { id: 'remove', label: 'Remove chart', tone: 'danger', onSelect: onRemove },
      ]}
      shelves={shelves}
      status={status}
      error={data.status === 'error' ? { message: data.message, ...(data.path ? { detail: data.path } : {}) } : undefined}
      rowsLabel={result ? `${formatInteger(result.table.numRows)} ${result.table.numRows === 1 ? 'row' : 'rows'}` : '–'}
      onDropColumn={dropOnCard}
      viewData={{
        on: viewData,
        onToggle: setViewData,
        table: adapted ? (
          <ViewData
            data={adapted}
            mark={mark}
            label={`${title} data`}
            xLabel={xLabel}
            yLabel={yLabel}
            {...(colorLabel === undefined || mark === 'heatmap' ? {} : { colorLabel })}
            {...(formatValue ? { formatValue } : {})}
            testId={`${testId}-data`}
          />
        ) : null,
      }}
    >
      {/* A press on the plot may start a brush or click: build the cross-filter cubes while the pointer moves. */}
      <div
        className="chart-view__plot"
        data-mark={mark}
        onPointerDownCapture={(event) => {
          if (event.button === 0) onBrushStart(chart.id);
        }}
      >
        {body}
      </div>
    </ChartCard>
  );
}

