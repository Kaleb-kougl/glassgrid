import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Brush } from './brush.js';
import type { ChartFonts } from './canvas.js';
import { ChartFrame } from './ChartFrame.js';
import { chartSummary, DEFAULT_CHART_HEIGHT, HIDDEN_TABLE_ROWS, useChartColumns, useSeriesColors, type ChartCommonProps } from './common.js';
import { SeriesLegend } from './Legend.js';
import { buildScatterModel } from './marks/scatter.js';
import type { ChartModel } from './model.js';
import { ViewData } from './ViewData.js';
import { ScatterGLClient, scatterInstances } from './webgl/scatter.js';
import { useWebGLOverlay } from './webgl/WebGLOverlayProvider.js';

export interface ScatterChartProps extends ChartCommonProps {
  /** Above this many points, draw on the shared WebGL overlay when there is one (default 10,000). */
  webglThreshold?: number;
  /** Point radius, CSS px (default 2.5). */
  radius?: number;
}

/** Points drawn with Canvas 2D at most (the WebGL threshold default). */
export const SCATTER_WEBGL_THRESHOLD = 10_000;

/**
 * Scatter plot over raw `x, y` rows, coloured by series. Up to the threshold
 * it draws with Canvas 2D; above it, inside a `WebGLOverlayProvider`, its
 * points go to the panel's shared WebGL canvas (one instanced draw call),
 * falling back to Canvas 2D when WebGL is unavailable or its context is
 * lost. Brushes a rectangle.
 */
export function ScatterChart(props: ScatterChartProps) {
  const { table, tokens, label, xLabel, yLabel, colorLabel, height = DEFAULT_CHART_HEIGHT, selection, onBrush, formatValue, colorKeys, webglThreshold = SCATTER_WEBGL_THRESHOLD, radius = 2.5, onDrawn, testId } = props;
  const data = useChartColumns(table, 'scatter', props.data);
  const colors = useSeriesColors(data, tokens, colorKeys);
  const overlay = useWebGLOverlay();
  /** Whether the overlay can draw: null until it says (dense charts then draw nothing rather than a million canvas points). */
  const [glAvailable, setGlAvailable] = useState<boolean | null>(null);
  const dense = overlay !== null && data.length > webglThreshold;
  const useGL = dense && glAvailable === true;

  const client = useMemo(() => (overlay ? new ScatterGLClient(overlay, setGlAvailable) : null), [overlay]);

  useEffect(() => {
    if (!overlay || !client) return;
    const unregister = overlay.register(client);
    return () => {
      unregister();
      client.dispose();
    };
  }, [overlay, client]);

  useEffect(() => {
    client?.setInstances(useGL ? scatterInstances(data, colors) : null);
  }, [client, useGL, data, colors]);

  const opacity = 0.8;
  const onFrame = useCallback(
    (brush: Brush | null, model: ChartModel) => {
      if (!client || !useGL) return;
      client.setView({
        xDomain: model.axes.x.domain,
        yDomain: model.axes.y.domain,
        brush,
        radius,
        opacity,
        dimOpacity: tokens.chart.unselectedOpacity,
      });
    },
    [client, useGL, radius, tokens],
  );

  const onCanvas = useCallback(
    (canvas: HTMLCanvasElement | null, model: ChartModel | null) => {
      client?.setPlacement(canvas, model ? model.axes.layout.plot : null);
    },
    [client],
  );

  const build = useCallback(
    (width: number, h: number, fonts: ChartFonts) => buildScatterModel(data, width, h, fonts, { xLabel, yLabel, colors, radius, opacity }),
    [data, xLabel, yLabel, colors, radius],
  );

  return (
    <ChartFrame
      build={build}
      tokens={tokens}
      height={height}
      summary={chartSummary('scatter', label, xLabel, yLabel, data.length, data.seriesList.length > 0 ? colorLabel : undefined)}
      selection={selection}
      onBrush={onBrush}
      xLabel={xLabel}
      yLabel={yLabel}
      marksExternal={dense && glAvailable !== false}
      onFrame={onFrame}
      onCanvas={onCanvas}
      perfName={useGL ? 'scatter-webgl' : 'scatter'}
      legend={data.seriesList.length > 0 ? <SeriesLegend series={data.seriesList} colors={colors} label={colorLabel} /> : undefined}
      dataTable={<ViewData data={data} mark="scatter" label={`${label} data`} xLabel={xLabel} yLabel={yLabel} colorLabel={colorLabel} maxRows={HIDDEN_TABLE_ROWS} formatValue={formatValue} />}
      onDrawn={onDrawn}
      testId={testId}
    />
  );
}
