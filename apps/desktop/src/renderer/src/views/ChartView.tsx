import { useMemo, useState } from 'react';
import {
  isNumericType,
  isTemporalType,
  type Aggregate,
  type ChartState,
  type ColumnState,
  type Filter,
  type TableId,
} from '@glassgrid/core';
import { BarChart, ChartCard, ShelfChip, formatAggregate, type MenuEntry, type ResolvedTokens } from '@glassgrid/ui';
import { chartTitle, fieldExpression, yExpression } from '../describe';
import type { EngineClient } from '../engine-client';
import { useChartData, valueKey, type BarRow } from './chart-data';

export interface ChartViewProps {
  engine: Pick<EngineClient, 'aggregate'>;
  tableId: TableId | null;
  chart: ChartState;
  /** This chart's own selection, if any. */
  selection: Filter | undefined;
  /** Every other view's selection (cross-filtering excludes the chart's own). */
  crossFilters: readonly Filter[];
  columns: readonly ColumnState[];
  tokens: ResolvedTokens;
  /** Caller of the latest change to this chart, for the "by AI" label. */
  addedBy: 'user' | 'ai';
  /** Column being dragged from the list, for drop hints. */
  draggingColumn: string | null;
  dispatch: (name: string, input: unknown) => void;
  onRemove: () => void;
}

const AGGREGATES: readonly Aggregate[] = ['count', 'sum', 'avg', 'min', 'max'];

function aggregateAllowed(aggregate: Aggregate, column: ColumnState | undefined): boolean {
  if (!column) return aggregate === 'count';
  if (aggregate === 'sum' || aggregate === 'avg') return isNumericType(column.inferredType);
  if (aggregate === 'min' || aggregate === 'max') return isNumericType(column.inferredType) || isTemporalType(column.inferredType);
  return true;
}

/** One chart card wired to the store: shelves, bar chart, selection and menu. */
export function ChartView({
  engine,
  tableId,
  chart,
  selection,
  crossFilters,
  columns,
  tokens,
  addedBy,
  draggingColumn,
  dispatch,
  onRemove,
}: ChartViewProps) {
  const { spec } = chart;
  const data = useChartData(engine, tableId, chart.id, spec, crossFilters);
  const [viewData, setViewData] = useState(false);
  const title = chartTitle(chart);
  const testId = `chart-${chart.id}`;

  const selectedValues = useMemo(
    () => (selection?.kind === 'in' && selection.column === spec.x.column ? selection.values : []),
    [selection, spec.x.column],
  );
  const selectedKeys = useMemo(() => new Set(selectedValues.map(valueKey)), [selectedValues]);

  const rows: readonly BarRow[] = data.status === 'ready' ? data.rows : data.status === 'loading' ? (data.previous ?? []) : [];

  const toggle = (row: BarRow) => {
    const without = selectedValues.filter((value) => valueKey(value) !== row.key);
    const values = without.length === selectedValues.length ? [...selectedValues, row.filterValue] : without;
    if (values.length === 0) dispatch('clearFilter', { viewId: chart.id });
    else dispatch('setFilter', { viewId: chart.id, filter: { kind: 'in', column: spec.x.column, values } });
  };

  const yColumn = spec.y ? columns.find((column) => column.name === spec.y?.column) : undefined;
  const countRows: MenuEntry = {
    kind: 'radio',
    id: 'rows',
    label: 'count(*)',
    checked: !spec.y,
    onSelect: () => dispatch('setShelf', { chartId: chart.id, shelf: 'y', field: null }),
  };
  const yMenu: MenuEntry[] = spec.y
    ? [
        ...AGGREGATES.filter((aggregate) => aggregateAllowed(aggregate, yColumn)).map(
          (aggregate): MenuEntry => ({
            kind: 'radio',
            id: aggregate,
            label: `${aggregate}(${spec.y?.column ?? ''})`,
            checked: spec.y?.aggregate === aggregate,
            onSelect: () => dispatch('setShelf', { chartId: chart.id, shelf: 'y', field: { column: spec.y?.column, aggregate } }),
          }),
        ),
        countRows,
      ]
    : [countRows];

  const dropOnY = (column: string) => {
    const target = columns.find((candidate) => candidate.name === column);
    const aggregate: Aggregate = target && isNumericType(target.inferredType) ? 'sum' : 'count';
    dispatch('setShelf', { chartId: chart.id, shelf: 'y', field: { column, aggregate } });
  };

  const shelves = (
    <div className="gg-shelves">
      <ShelfChip
        shelf="X"
        value={fieldExpression(spec.x)}
        addedBy={addedBy}
        onDropColumn={(column) => dispatch('setShelf', { chartId: chart.id, shelf: 'x', field: { column } })}
        pendingColumn={draggingColumn}
        testId={`${testId}-shelf-x`}
      />
      <ShelfChip
        shelf="Y"
        value={yExpression(spec.y)}
        addedBy={addedBy}
        menu={yMenu}
        menuLabel="Y aggregate"
        onDropColumn={dropOnY}
        pendingColumn={draggingColumn}
        onRemove={spec.y ? () => dispatch('setShelf', { chartId: chart.id, shelf: 'y', field: null }) : undefined}
        testId={`${testId}-shelf-y`}
      />
      <ShelfChip shelf="Color" title="Splitting bars by colour arrives with the M3 chart layer." testId={`${testId}-shelf-color`} />
    </div>
  );

  const status = data.status === 'loading' ? 'loading' : data.status === 'error' ? 'error' : 'ready';
  const valueLabel = yExpression(spec.y);

  return (
    <ChartCard
      testId={testId}
      title={title}
      attribution={addedBy === 'ai' ? 'ai' : undefined}
      onRename={(next) => dispatch('renameChart', { chartId: chart.id, title: next })}
      selection={selectedValues.length > 0 ? { summary: `${selectedValues.length} selected`, onClear: () => dispatch('clearFilter', { viewId: chart.id }) } : undefined}
      menu={[
        ...(chart.title !== undefined
          ? [{ id: 'reset-title', label: 'Reset title', onSelect: () => dispatch('renameChart', { chartId: chart.id, title: null }) } satisfies MenuEntry]
          : []),
        { id: 'remove', label: 'Remove chart', tone: 'danger', onSelect: onRemove },
      ]}
      shelves={shelves}
      status={status}
      error={data.status === 'error' ? { message: data.message, ...(data.path ? { detail: data.path } : {}) } : undefined}
      rowsLabel={data.status === 'ready' ? `${data.rows.length} ${data.rows.length === 1 ? 'row' : 'rows'}` : '–'}
      onDropColumn={(column) => dispatch('setShelf', { chartId: chart.id, shelf: 'x', field: { column } })}
      viewData={{
        on: viewData,
        onToggle: setViewData,
        table: (
          <table aria-label={`${title} data`}>
            <thead>
              <tr>
                <th scope="col">{fieldExpression(spec.x)}</th>
                <th scope="col" style={{ textAlign: 'right' }}>
                  {valueLabel}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} aria-selected={selectedKeys.has(row.key)}>
                  <td>{row.label}</td>
                  <td className="gg-num">{row.value === null ? '–' : formatAggregate(row.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ),
      }}
    >
      <BarChart
        data={rows}
        selected={selectedKeys}
        onToggle={(datum) => {
          const row = rows.find((candidate) => candidate.key === datum.key);
          if (row) toggle(row);
        }}
        tokens={tokens}
        valueLabel={valueLabel}
        label={`${title}: bar chart of ${valueLabel} by ${fieldExpression(spec.x)}`}
        testId={`${testId}-bars`}
      />
    </ChartCard>
  );
}
