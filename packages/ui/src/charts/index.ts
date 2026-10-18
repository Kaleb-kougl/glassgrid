export type { AxisKind, BrushHandler, BrushPhase, BrushValue, ChartCategory, ChartColumns, ChartMark, ChartSeries, IntervalSelection } from './types.js';
export { chartColumnsFromArrow, fillNumbers, axisKindOf, valueKey, OTHER_SERIES_KEY } from './arrow.js';
export {
  formatAggregate,
  formatAxisValue,
  formatRange,
  formatTimeAt,
  timeResolution,
  toIsoTimestamp,
  parseTimeBound,
  boundToNumber,
  numberToBound,
  type TimeResolution,
} from './format.js';
export { makeScale, niceDomain, measureDomain, extent, timeTickFormat, tickCount, type AxisScale } from './scales.js';
export { seriesColors, rampAt, rampLut, rampPosition, rampValue, parseColor, type RampTransform } from './colors.js';
export { layoutAxes, drawAxes, type ChartLayout, type PlotRect, type Axes } from './axes.js';
export { chartFonts, type ChartFonts } from './canvas.js';
export {
  lowerBound,
  nearestSorted,
  buildBinIndex,
  binAt,
  buildGridIndex,
  gridCellAt,
  buildPointGrid,
  nearestPoint,
  type BinIndex,
  type GridIndex,
  type PointGrid,
} from './hit.js';
export {
  beginDrag,
  dragBrush,
  endDrag,
  keyBrush,
  brushToSelection,
  selectionToBrush,
  edgeSnapper,
  hitBrushTarget,
  type Brush,
  type BrushAxes,
  type BrushDims,
  type Snapper,
} from './brush.js';
export type { ChartModel, HoverInfo, DrawContext } from './model.js';
export { buildLineModel } from './marks/line.js';
export { buildHistogramModel } from './marks/histogram.js';
export { buildHeatmapModel } from './marks/heatmap.js';
export { buildScatterModel } from './marks/scatter.js';
export { ChartFrame, describeBrush, type ChartFrameProps } from './ChartFrame.js';
export { DEFAULT_CHART_HEIGHT, chartSummary, type ChartCommonProps } from './common.js';
export { LineChart, AreaChart, type LineChartProps } from './LineChart.js';
export { Histogram, type HistogramProps } from './Histogram.js';
export { Heatmap, type HeatmapProps } from './Heatmap.js';
export { ScatterChart, SCATTER_WEBGL_THRESHOLD, type ScatterChartProps } from './ScatterChart.js';
export { ViewData, formatDimension, type ViewDataProps } from './ViewData.js';
export { SeriesLegend, RampLegend, type SeriesLegendProps, type RampLegendProps } from './Legend.js';
export { WebGLOverlayProvider, useWebGLOverlay, type WebGLOverlayProviderProps } from './webgl/WebGLOverlayProvider.js';
export { WebGLOverlayManager, computeViewport, type GLViewport, type OverlayClient, type OverlayEnvironment, type RectLike } from './webgl/overlay.js';
export { ScatterGLClient, scatterInstances } from './webgl/scatter.js';
export { setChartPerfHook, type ChartPerfHook, type ChartPerfEvent } from './perf.js';
export {
  prng,
  syntheticLineTable,
  syntheticHistogramTable,
  syntheticHeatmapTable,
  syntheticScatterTable,
  syntheticBarTable,
  type SyntheticLineOptions,
  type SyntheticHistogramOptions,
  type SyntheticHeatmapOptions,
  type SyntheticScatterOptions,
  type SyntheticBarOptions,
} from './synthetic.js';
