/*
 * @glassgrid/app: the Glassgrid React app shared by the desktop and web
 * shells. Shells import the stylesheets (`@glassgrid/ui/*.css`,
 * `@glassgrid/app/app.css`) and, first of all in render-perf builds,
 * `@glassgrid/app/render-perf-core`.
 */
export { App, type AppProps } from './App';
export { createAppWorkspace, appPolicy, type AppWorkspace } from './workspace';
export { applyInitialTheme, readThemePreference, resolveTheme, THEME_STORAGE_KEY } from './theme';
export { installRenderPerf, perfRegion } from './render-perf';
export {
  EngineError,
  isAbandoned,
  type AggregateResult,
  type ColumnTypesResult,
  type CountResult,
  type CrossfilterQueryOptions,
  type EngineClientLike,
  type FetchPage,
  type FilteredQueryOptions,
  type OpenResult,
  type PrepareCrossfilterResult,
  type ProfileResult,
  type QueryOptions,
  type RowsResult,
} from './engine';
