/*
 * @glassgrid/app: the Glassgrid React app shared by the desktop and web
 * shells. Shells import the stylesheets (`@glassgrid/ui/*.css`,
 * `@glassgrid/app/app.css`) and, first of all in render-perf builds,
 * `@glassgrid/app/render-perf-core`.
 */
export { App, type AppProps } from './App';
export {
  workspaceFilesOf,
  type AppMenuCommand,
  type DocumentChrome,
  type DroppedFileRef,
  type Platform,
  type PlatformCapabilities,
  type PlatformClipboard,
  type PlatformFiles,
  type PlatformName,
  type PlatformWindow,
  type SampleDataset,
  type WorkspaceFilesApi,
} from './platform';
export { describeMismatch, documentTitle, isWorkspaceFileName } from './workspace-files';
export { createAppWorkspace, appPolicy, type AppWorkspace } from './workspace';
export { applyInitialTheme, readThemePreference, resolveTheme, THEME_STORAGE_KEY } from './theme';
export { installRenderPerf, perfRegion } from './render-perf';
export {
  EngineError,
  isAbandoned,
  type AggregateResult,
  type CacheStats,
  type ColumnTypesResult,
  type CountResult,
  type CrossfilterQueryOptions,
  type EngineClientApi,
  type EngineClientLike,
  type FetchPage,
  type FilteredQueryOptions,
  type OpenResult,
  type PageOptions,
  type ParquetCacheResult,
  type PrepareCrossfilterResult,
  type ProfileResult,
  type QueryOptions,
  type RowsResult,
} from './engine';
