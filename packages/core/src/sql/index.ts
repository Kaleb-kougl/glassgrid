export { CompileError, isCompileError, type CompileErrorCode } from './errors.js';
export { quoteIdent, ROW_COUNT_COLUMN, type CompiledQuery } from './builder.js';
export { compileWhere } from './where.js';
export { compileRowsQuery, compileCountQuery } from './rows.js';
export {
  compileChartQuery,
  compileScatterCountQuery,
  scatterAsHeatmap,
  scatterPointLimit,
  DEFAULT_PIXEL_WIDTH,
  HEATMAP_TARGET_BINS,
  HISTOGRAM_TARGET_BINS,
  LINE_AUTO_MAX_BUCKETS,
  MAX_HEATMAP_BINS_PER_AXIS,
  MAX_HISTOGRAM_BINS,
  MAX_PIXEL_WIDTH,
  type ChartCompileOptions,
} from './chart.js';
export { autoTimeUnit, niceBinWidth, numericBinCount, parseTemporal, timeBucketCount, type TimeUnitStrategy } from './bins.js';
