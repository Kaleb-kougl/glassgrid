/*
 * @glassgrid/app: the Glassgrid React app shared by the desktop and web
 * shells. Shells import the stylesheets (`@glassgrid/ui/*.css`,
 * `@glassgrid/app/app.css`) and, first of all in render-perf builds,
 * `@glassgrid/app/render-perf-core`.
 */
export { App, AUTOSAVE_DELAY_MS, type AppProps } from './App';
export {
  workspaceFilesOf,
  type DroppedFileRef,
  type Platform,
  type PlatformCapabilities,
  type PlatformClipboard,
  type PlatformFiles,
  type PlatformName,
  type PlatformWindow,
  type RecoveryOffer,
  type SampleDataset,
  type WorkspaceFileContext,
  type WorkspaceFileOutcome,
  type WorkspaceFilesApi,
} from './platform';
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
