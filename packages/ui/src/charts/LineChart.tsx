import { useCallback } from 'react';
import type { ChartFonts } from './canvas.js';
import { ChartFrame } from './ChartFrame.js';
import { chartSummary, DEFAULT_CHART_HEIGHT, HIDDEN_TABLE_ROWS, useChartColumns, useSeriesColors, type ChartCommonProps } from './common.js';
import { SeriesLegend } from './Legend.js';
import { buildLineModel } from './marks/line.js';
import { ViewData } from './ViewData.js';

export interface LineChartProps extends ChartCommonProps {
  /** `area` fills each series down to zero (overlapping, not stacked). Default `line`. */
  mark?: 'line' | 'area';
}

/**
 * Line (or area) chart over `x, y` rows, one series per colour value.
 * M4-downsampled results draw as one polyline per series (pixel-faithful),
 * NULL measures leave gaps. Brushes along x.
 */
export function LineChart(props: LineChartProps) {
  const { table, tokens, label, xLabel, yLabel, colorLabel, height = DEFAULT_CHART_HEIGHT, selection, onBrush, formatValue, colorKeys, testId } = props;
  const mark = props.mark ?? 'line';
  const data = useChartColumns(table, mark, props.data);
  const colors = useSeriesColors(data, tokens, colorKeys);
  const build = useCallback(
    (width: number, h: number, fonts: ChartFonts) => buildLineModel(data, width, h, fonts, { mark, yLabel, colors, formatValue }),
    [data, mark, yLabel, colors, formatValue],
  );
  return (
    <ChartFrame
      build={build}
      tokens={tokens}
      height={height}
      summary={chartSummary(mark, label, xLabel, yLabel, data.length, data.seriesList.length > 0 ? colorLabel : undefined)}
      selection={selection}
      onBrush={onBrush}
      xLabel={xLabel}
      perfName={mark}
      legend={data.seriesList.length > 0 ? <SeriesLegend series={data.seriesList} colors={colors} label={colorLabel} /> : undefined}
      dataTable={<ViewData data={data} mark={mark} label={`${label} data`} xLabel={xLabel} yLabel={yLabel} colorLabel={colorLabel} maxRows={HIDDEN_TABLE_ROWS} formatValue={formatValue} />}
      testId={testId}
    />
  );
}

/** `LineChart` with `mark="area"`. */
export function AreaChart(props: Omit<LineChartProps, 'mark'>) {
  return <LineChart {...props} mark="area" />;
}
