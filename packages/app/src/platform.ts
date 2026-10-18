import type { MenuCommand, OpenCsvResult, ThemePreference, WorkspaceState } from '@glassgrid/core';
import type { EngineClientLike } from './engine';
import type { AppWorkspace } from './workspace';

/*
 * Everything the app needs from the shell it runs in. The desktop shell
 * (apps/desktop/src/renderer/src/desktop-platform.ts) builds one from the
 * preload bridge and the MessagePort EngineClient; the web shell
 * (apps/web/src/web-platform.ts) from browser APIs and the DuckDB-WASM
 * worker client. The app itself never touches Electron, Node, `window.glassgrid`
 * or a particular engine transport.
 *
 * Render-perf instrumentation is not part of this interface: it is
 * compile-time (`__GG_RENDER_PERF__`, a Vite `define` each shell sets), and
 * shells wire it by importing `@glassgrid/app/render-perf-core` first and
 * calling `installRenderPerf(workspace.store)`; engine transports report
 * request/reply phases to `renderPerf` from that module.
 */

/** Where the app runs: the OS of the desktop app, or any browser. */
export type PlatformName = 'mac' | 'win' | 'linux' | 'web';

/**
 * A file the user dropped, as `fileFromDrop` hands it back: a DOM `File` on
 * both shells today (the desktop preload resolves it to a path that the
 * page never sees), or any other opaque handle a shell prefers. The app
 * only passes it back to `openDropped`.
 */
export interface DroppedFileRef {
  readonly name: string;
}

/** A dataset the shell can open without a file from the user (the web demo's samples). */
export interface SampleDataset {
  readonly id: string;
  /** Button label, e.g. "NYC taxi trips". */
  readonly label: string;
  /** One line under the label, e.g. "3M rows · Parquet". */
  readonly detail?: string;
}

export interface PlatformFiles {
  /**
   * Ask the person for a CSV (native dialog, `<input type=file>`), register
   * it with the engine and resolve with its handle; never a path.
   */
  pickCsv(): Promise<OpenCsvResult>;
  /** The file a drop event carries (the first one), or null. Called synchronously in the drop handler. */
  fileFromDrop(data: DataTransfer): DroppedFileRef | null;
  /** Register a dropped file with the engine; resolves like `pickCsv`. */
  openDropped(file: DroppedFileRef): Promise<OpenCsvResult>;
  /** Shown under "Drop a CSV file here": where the data is read, e.g. "…never uploaded." */
  readonly privacyNote: string;
  /** Datasets offered on the empty state; absent or empty for none. */
  readonly samples?: readonly SampleDataset[];
  /** Open one of `samples` by id; resolves like `pickCsv`. Required when `samples` is non-empty. */
  openSample?(id: string): Promise<OpenCsvResult>;
}

export interface PlatformClipboard {
  /** Put plain text on the system clipboard (`copySelection`). */
  writeText(text: string): Promise<void>;
}

export interface PlatformWindow {
  /**
   * Leave room at the start of the title bar for native window controls
   * (macOS traffic lights; width `--gg-titlebar-inset`). False in browsers.
   */
  readonly titleBarInset: boolean;
  /** How shortcuts are written and read out: `⌘Z` (`mac`) or `Ctrl+Z` (`pc`). */
  readonly shortcuts: 'mac' | 'pc';
  /** Tell the native shell the theme preference in use (desktop: native frame colour, View menu ticks). */
  syncTheme?(preference: ThemePreference): void;
  /** Native application-menu commands (desktop: File → Open, View → Theme). Returns an unsubscribe function. */
  onMenuCommand?(listener: (command: MenuCommand) => void): () => void;
  /**
   * The window or page is going away (`pagehide` on both shells today): the
   * app closes its engine table here. Returns an unsubscribe function.
   * Persistence may later need a veto (unsaved changes); see
   * docs/m4-app-package.md.
   */
  onBeforeClose(listener: () => void): () => void;
}

export interface PlatformCapabilities {
  /** Workspaces save to and open from `.glassgrid` files. The UI also needs `workspaceFiles`. */
  readonly canSaveWorkspace: boolean;
  /**
   * A saved workspace can reopen its data file from a stored path (desktop:
   * relative → absolute → locate). False in browsers, where the person picks
   * the file again.
   */
  readonly canOpenFromPath: boolean;
  /** Largest data file the engine accepts, in bytes; null for no limit (desktop). The web demo is bounded by WASM memory. */
  readonly maxFileBytes: number | null;
}

/** Outcome of a workspace-file operation, as the UI reports it. */
export type WorkspaceFileOutcome =
  | { readonly status: 'done'; readonly displayName: string }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly message: string };

/** What a workspace-file operation may read and change. */
export interface WorkspaceFileContext {
  readonly workspace: AppWorkspace;
  readonly engine: EngineClientLike;
}

/** An autosaved workspace found at start (crash recovery). */
export interface RecoveryOffer {
  readonly id: string;
  /** Workspace or data file name to show. */
  readonly displayName: string;
  /** Epoch ms of the autosave. */
  readonly savedAt: number;
}

/**
 * `.glassgrid` workspace files (M4 persistence, implemented by the shells
 * once core can serialise a workspace). Optional: without it the save/open
 * controls, the edited indicator and recovery stay hidden. The app owns the
 * UI (buttons, shortcut, edited dot, recovery toast, autosave timing); the
 * implementation owns the format, the file system and the data-file
 * fallbacks.
 */
export interface WorkspaceFilesApi {
  /** Save the workspace; `saveAs` asks for a location even when it has one. */
  save(context: WorkspaceFileContext, options: { saveAs: boolean }): Promise<WorkspaceFileOutcome>;
  /** Pick a `.glassgrid` file, reopen its data source and replace the workspace state. */
  open(context: WorkspaceFileContext): Promise<WorkspaceFileOutcome>;
  /** Called (debounced by the app) after workspace changes, for crash recovery. */
  autosave?(state: WorkspaceState): void;
  /** Crash recovery: checked once when the app starts. */
  readonly recovery?: {
    /** An autosave newer than the last save, if any; the app offers to restore it. */
    check(): Promise<RecoveryOffer | null>;
    restore(offer: RecoveryOffer, context: WorkspaceFileContext): Promise<WorkspaceFileOutcome>;
  };
  /** Opens started by the shell (File → Open Workspace…, a double-clicked file). Returns an unsubscribe function. */
  onOpenRequest?(listener: () => void): () => void;
}

/** Everything platform-specific, passed to `<App platform={…} />` once per window or page. */
export interface Platform {
  readonly name: PlatformName;
  readonly engine: EngineClientLike;
  readonly files: PlatformFiles;
  readonly clipboard: PlatformClipboard;
  readonly window: PlatformWindow;
  readonly capabilities: PlatformCapabilities;
  /** Absent until the persistence work provides it (and on shells that cannot save). */
  readonly workspaceFiles?: WorkspaceFilesApi;
}

/** Whether the save/open controls show: the capability and an implementation. */
export function workspaceFilesOf(platform: Pick<Platform, 'capabilities' | 'workspaceFiles'>): WorkspaceFilesApi | null {
  return platform.capabilities.canSaveWorkspace && platform.workspaceFiles ? platform.workspaceFiles : null;
}
