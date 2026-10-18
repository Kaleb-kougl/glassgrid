import { useCallback, useMemo } from 'react';
import type { ChartFonts } from './canvas.js';
import { ChartFrame } from './ChartFrame.js';
import type { RampTransform } from './colors.js';
import { chartSummary, DEFAULT_CHART_HEIGHT, HIDDEN_TABLE_ROWS, useChartColumns, type ChartCommonProps } from './common.js';
import { RampLegend } from './Legend.js';
import { buildHeatmapModel, maxCount } from './marks/heatmap.js';
import { ViewData } from './ViewData.js';

export interface HeatmapProps extends Omit<ChartCommonProps, 'colorLabel' | 'colorKeys'> {
  /** Name of the cell measure (default `count(*)`). */
  countLabel?: string;
  /** Count → colour mapping on the sequential ramp (default `sqrt`). */
  transform?: RampTransform;
  /** Snap brushes to bin edges (default true); snapped selections are half-open on both axes. */
  snap?: boolean;
}

/**
 * Heatmap over `x, x_end, y, y_end, count` cells on the sequential ramp,
 * with a ramp legend. Brushes a rectangle, snapped to bin edges. Also the
 * scatter fallback when the engine answers with binned cells.
 */
export function Heatmap(props: HeatmapProps) {
  const { table, tokens, label, xLabel, yLabel, countLabel = 'count(*)', height = DEFAULT_CHART_HEIGHT, selection, onBrush, formatValue, transform = 'sqrt', snap, onDrawn, testId } = props;
  const data = useChartColumns(table, 'heatmap', props.data);
  const ramp = tokens.chart.sequential;
  const max = useMemo(() => maxCount(data.count), [data]);
  const build = useCallback(
    (width: number, h: number, fonts: ChartFonts) => buildHeatmapModel(data, width, h, fonts, { xLabel, yLabel, countLabel, ramp, transform, formatValue, snap }),
    [data, xLabel, yLabel, countLabel, ramp, transform, formatValue, snap],
  );
  return (
    <ChartFrame
      build={build}
      tokens={tokens}
      height={height}
      summary={chartSummary('heatmap', label, xLabel, yLabel, data.length)}
      selection={selection}
      onBrush={onBrush}
      xLabel={xLabel}
      yLabel={yLabel}
      perfName="heatmap"
      legend={<RampLegend ramp={ramp} max={max} transform={transform} label={countLabel} formatValue={formatValue} />}
      dataTable={<ViewData data={data} mark="heatmap" label={`${label} data`} xLabel={xLabel} yLabel={yLabel} countLabel={countLabel} maxRows={HIDDEN_TABLE_ROWS} formatValue={formatValue} />}
      onDrawn={onDrawn}
      testId={testId}
    />
  );
}
