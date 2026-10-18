import { useState, type ReactNode } from 'react';
import {
  AreaChart,
  BarChart,
  ChartCard,
  Heatmap,
  Histogram,
  LineChart,
  ScatterChart,
  ShelfChip,
  ViewData,
  WebGLOverlayProvider,
  barDataFromArrow,
  chartColumnsFromArrow,
  formatRange,
  parseTimeBound,
  syntheticBarTable,
  syntheticHeatmapTable,
  syntheticHistogramTable,
  syntheticLineTable,
  syntheticScatterTable,
  tokensFor,
  type ChartMark,
  type IntervalSelection,
  type ThemeName,
} from '@glassgrid/ui';

/*
 * Every M3 mark on synthetic results shaped like the compiler's output, each
 * with a live brush (state kept here, as the app keeps it in its store) and
 * "View data". The dense scatter draws on the sheet's shared WebGL overlay.
 */

const DAY = 86_400_000;
const tables = {
  line: syntheticLineTable({ points: 31 }),
  area: syntheticLineTable({ points: 400, series: 4, other: true, nulls: 0.01, stepMs: DAY / 4, seed: 21 }),
  histogram: syntheticHistogramTable({ bins: 50, width: 0.5 }),
  heatmap: syntheticHeatmapTable({ bins: 100 }),
  scatter: syntheticScatterTable({ points: 2_000, series: 3 }),
  scatterDense: syntheticScatterTable({ points: 200_000, series: 4, seed: 17 }),
  bar: syntheticBarTable({ categories: 6 }),
};
const columns = {
  line: chartColumnsFromArrow(tables.line, 'line'),
  area: chartColumnsFromArrow(tables.area, 'area'),
  histogram: chartColumnsFromArrow(tables.histogram, 'histogram'),
  heatmap: chartColumnsFromArrow(tables.heatmap, 'heatmap'),
  scatter: chartColumnsFromArrow(tables.scatter, 'scatter'),
  scatterDense: chartColumnsFromArrow(tables.scatterDense, 'scatter'),
};
const bars = barDataFromArrow(tables.bar);

function describe(selection: IntervalSelection | null, kind: 'number' | 'time'): string | null {
  if (!selection) return null;
  const n = (v: number | string) => (kind === 'time' ? parseTimeBound(v) : Math.round(Number(v) * 100) / 100);
  const x = formatRange(n(selection.x[0]), n(selection.x[1]), kind, kind === 'time' ? 'day' : 'millisecond');
  return selection.y ? `${x} × ${formatRange(n(selection.y[0]), n(selection.y[1]), 'number')}` : x;
}

interface DemoProps {
  title: string;
  mark: ChartMark;
  x: string;
  y: string;
  color?: string;
  rows: number;
  kind?: 'number' | 'time';
  initial?: IntervalSelection | null;
  table?: ReactNode;
  children: (brush: { selection: IntervalSelection | null; onBrush: (s: IntervalSelection | null) => void }) => ReactNode;
  testId: string;
}

function Demo({ title, x, y, color, rows, kind = 'number', initial = null, table, children, testId }: DemoProps) {
  const [selection, setSelection] = useState<IntervalSelection | null>(initial);
  const [viewData, setViewData] = useState(false);
  const summary = describe(selection, kind);
  return (
    <ChartCard
      title={title}
      testId={testId}
      selection={summary ? { summary, onClear: () => setSelection(null) } : undefined}
      shelves={
        <div className="gg-shelves">
          <ShelfChip shelf="X" value={x} />
          <ShelfChip shelf="Y" value={y} />
          <ShelfChip shelf="Color" value={color} />
        </div>
      }
      viewData={{ on: viewData, onToggle: setViewData, table }}
      rowsLabel={`${rows.toLocaleString('en-US')} rows`}
    >
      {/* The app commits `move` to its store at most once per frame; the gallery keeps every phase. */}
      {children({ selection, onBrush: setSelection })}
    </ChartCard>
  );
}

export function ChartsGallery({ theme }: { theme: ThemeName }) {
  const tokens = tokensFor(theme);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(['"Cash"']));
  return (
    <WebGLOverlayProvider className="sheet__charts" testId={`charts-${theme}`}>
      <Demo
        title="Trips per day"
        mark="line"
        x="day(pickup_datetime)"
        y="count(*)"
        rows={columns.line.length}
        kind="time"
        testId={`chart-line-${theme}`}
        table={<ViewData data={columns.line} mark="line" label="Trips per day data" xLabel="day(pickup_datetime)" yLabel="count(*)" />}
      >
        {(b) => <LineChart table={tables.line} data={columns.line} tokens={tokens} label="Trips per day" xLabel="day(pickup_datetime)" yLabel="count(*)" {...b} testId={`line-${theme}`} />}
      </Demo>
      <Demo
        title="Trips by payment type, 6-hourly"
        mark="area"
        x="hour(pickup_datetime)"
        y="count(*)"
        color="payment_type"
        rows={columns.area.length}
        kind="time"
        testId={`chart-area-${theme}`}
        table={<ViewData data={columns.area} mark="area" label="Trips by payment type data" xLabel="hour(pickup_datetime)" yLabel="count(*)" colorLabel="payment_type" />}
      >
        {(b) => (
          <AreaChart table={tables.area} data={columns.area} tokens={tokens} label="Trips by payment type" xLabel="hour(pickup_datetime)" yLabel="count(*)" colorLabel="payment_type" {...b} />
        )}
      </Demo>
      <Demo
        title="Trip distance"
        mark="histogram"
        x="bin(trip_distance, 0.5)"
        y="count(*)"
        rows={columns.histogram.length}
        initial={{ x: [2, 6] }}
        testId={`chart-histogram-${theme}`}
        table={<ViewData data={columns.histogram} mark="histogram" label="Trip distance data" xLabel="bin(trip_distance, 0.5)" yLabel="count(*)" />}
      >
        {(b) => <Histogram table={tables.histogram} data={columns.histogram} tokens={tokens} label="Trip distance" xLabel="bin(trip_distance, 0.5)" yLabel="count(*)" {...b} testId={`histogram-${theme}`} />}
      </Demo>
      <Demo
        title="Pickup hour by zone"
        mark="heatmap"
        x="bin(PULocationID)"
        y="bin(DOLocationID)"
        rows={columns.heatmap.length}
        testId={`chart-heatmap-${theme}`}
        table={<ViewData data={columns.heatmap} mark="heatmap" label="Heatmap data" xLabel="bin(PULocationID)" yLabel="bin(DOLocationID)" maxRows={200} />}
      >
        {(b) => <Heatmap table={tables.heatmap} data={columns.heatmap} tokens={tokens} label="Pickup by drop-off zone" xLabel="bin(PULocationID)" yLabel="bin(DOLocationID)" height={200} {...b} />}
      </Demo>
      <Demo
        title="Fare by distance"
        mark="scatter"
        x="trip_distance"
        y="fare_amount"
        color="payment_type"
        rows={columns.scatter.length}
        testId={`chart-scatter-${theme}`}
        table={<ViewData data={columns.scatter} mark="scatter" label="Fare by distance data" xLabel="trip_distance" yLabel="fare_amount" colorLabel="payment_type" maxRows={200} />}
      >
        {(b) => (
          <ScatterChart table={tables.scatter} data={columns.scatter} tokens={tokens} label="Fare by distance" xLabel="trip_distance" yLabel="fare_amount" colorLabel="payment_type" height={200} {...b} />
        )}
      </Demo>
      <Demo
        title="Fare by distance · 200,000 points (WebGL)"
        mark="scatter"
        x="trip_distance"
        y="fare_amount"
        color="payment_type"
        rows={columns.scatterDense.length}
        testId={`chart-scatter-gl-${theme}`}
        table={<ViewData data={columns.scatterDense} mark="scatter" label="Dense scatter data" xLabel="trip_distance" yLabel="fare_amount" colorLabel="payment_type" maxRows={200} />}
      >
        {(b) => (
          <ScatterChart
            table={tables.scatterDense}
            data={columns.scatterDense}
            tokens={tokens}
            label="Fare by distance, dense"
            xLabel="trip_distance"
            yLabel="fare_amount"
            colorLabel="payment_type"
            height={200}
            radius={1.5}
            {...b}
            testId={`scatter-gl-${theme}`}
          />
        )}
      </Demo>
      <ChartCard title="Trips by payment type" selection={selected.size > 0 ? { summary: `${selected.size} selected`, onClear: () => setSelected(new Set()) } : undefined} rowsLabel={`${bars.rows.length} rows`}>
        <BarChart
          data={bars.rows}
          selected={selected}
          tokens={tokens}
          valueLabel="count(*)"
          label="Trips by payment type"
          onToggle={(d) => {
            const next = new Set(selected);
            if (next.has(d.key)) next.delete(d.key);
            else next.add(d.key);
            setSelected(next);
          }}
        />
      </ChartCard>
    </WebGLOverlayProvider>
  );
}
