import { useCallback } from 'react';
import type { ChartFonts } from './canvas.js';
import { ChartFrame } from './ChartFrame.js';
import { chartSummary, DEFAULT_CHART_HEIGHT, HIDDEN_TABLE_ROWS, useChartColumns, useSeriesColors, type ChartCommonProps } from './common.js';
import { SeriesLegend } from './Legend.js';
import { buildHistogramModel } from './marks/histogram.js';
import { ViewData } from './ViewData.js';

export interface HistogramProps extends ChartCommonProps {
  /**
   * Snap brushes to bin edges (default true). Snapped selections are
   * half-open, `lo <= x < hi`: pass `maxInclusive: false` in the range filter.
   */
  snap?: boolean;
}

/** Histogram over `x, x_end, y` bins; series stack within a bin. Brushes along x, snapped to bin edges. */
export function Histogram(props: HistogramProps) {
  const { table, tokens, label, xLabel, yLabel, colorLabel, height = DEFAULT_CHART_HEIGHT, selection, onBrush, formatValue, colorKeys, snap, testId } = props;
  const data = useChartColumns(table, 'histogram', props.data);
  const colors = useSeriesColors(data, tokens, colorKeys);
  const build = useCallback(
    (width: number, h: number, fonts: ChartFonts) => buildHistogramModel(data, width, h, fonts, { yLabel, colors, formatValue, snap }),
    [data, yLabel, colors, formatValue, snap],
  );
  return (
    <ChartFrame
      build={build}
      tokens={tokens}
      height={height}
      summary={chartSummary('histogram', label, xLabel, yLabel, data.length, data.seriesList.length > 0 ? colorLabel : undefined)}
      selection={selection}
      onBrush={onBrush}
      xLabel={xLabel}
      perfName="histogram"
      legend={data.seriesList.length > 0 ? <SeriesLegend series={data.seriesList} colors={colors} label={colorLabel} /> : undefined}
      dataTable={<ViewData data={data} mark="histogram" label={`${label} data`} xLabel={xLabel} yLabel={yLabel} colorLabel={colorLabel} maxRows={HIDDEN_TABLE_ROWS} formatValue={formatValue} />}
      testId={testId}
    />
  );
}
