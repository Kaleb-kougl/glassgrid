import type { CloseAnswer, MenuCommand, OpenCsvResult, ThemePreference, WorkspaceBridge, WorkspaceMenuCommand } from '@glassgrid/core';
import type { EngineClientLike } from './engine';

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
  /**
   * The person is about to open something (pointer or focus on an open
   * button or a sample, a file dragged over the window): a shell whose
   * engine starts lazily warms it up. Optional; cheap to call repeatedly.
   */
  prepare?(): void;
}

export interface PlatformClipboard {
  /** Put plain text on the system clipboard (`copySelection`). */
  writeText(text: string): Promise<void>;
}

/**
 * A native application-menu command: File → Open and View → Theme
 * (`MenuCommand`), and the workspace-file items Open Workspace…, Open
 * Recent, Save and Save As… (`WorkspaceMenuCommand`). The app turns each
 * into the matching command on the registry.
 */
export type AppMenuCommand = MenuCommand | WorkspaceMenuCommand;

/** What the window shows, for native chrome: the title and whether there are unsaved changes. */
export interface DocumentChrome {
  /** The workspace file's name, else the data file's; null with nothing open. */
  readonly title: string | null;
  /** Unsaved changes (`isWorkspaceDirty`); always false without workspace files. */
  readonly edited: boolean;
  /** The workspace's document id (opaque, from the shell), or null when untitled. */
  readonly documentId: string | null;
}

export interface PlatformWindow {
  /**
   * Leave room at the start of the title bar for native window controls
   * (macOS traffic lights; width `--gg-titlebar-inset`). False in browsers.
   */
  readonly titleBarInset: boolean;
  /** How shortcuts are written and read out: `⌘Z` (`mac`) or `Ctrl+Z` (`pc`). */
  readonly shortcuts: 'mac' | 'pc';
  /**
   * A native application menu owns the file shortcuts (⌘O, ⇧⌘O, ⌘S, ⇧⌘S)
   * as accelerators and reports them through `onMenuCommand`; the page then
   * leaves those keys alone, so each fires exactly once. False or absent
   * (browsers): the page handles them itself.
   */
  readonly menuShortcuts?: boolean;
  /** Tell the native shell the theme preference in use (desktop: native frame colour, View menu ticks). */
  syncTheme?(preference: ThemePreference): void;
  /** Native application-menu commands (desktop: File and View menus). Returns an unsubscribe function. */
  onMenuCommand?(listener: (command: AppMenuCommand) => void): () => void;
  /**
   * The window or page is going away (`pagehide` on both shells today): the
   * app closes its engine table here. Returns an unsubscribe function.
   */
  onBeforeClose(listener: () => void): () => void;
  /**
   * Veto for closing the window with unsaved work. The shell asks before it
   * closes; the handler answers with core's `closeAnswer` (dirty, and the
   * snapshot to save if the person picks Save). Desktop: main shows the
   * native Save / Don't Save / Cancel dialog. One handler at a time; returns
   * an unsubscribe function. Absent: the window closes without asking.
   */
  onCloseRequest?(handler: () => CloseAnswer | Promise<CloseAnswer>): () => void;
  /** Show the document in native chrome (desktop: window title; macOS represented file and edited dot). */
  setDocumentChrome?(chrome: DocumentChrome): void;
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

/**
 * `.glassgrid` workspace files: the host half of core's `WorkspaceBridge`
 * (desktop: main through the preload, `window.glassgrid.workspace`; the web
 * could implement it over OPFS and downloads). The app wires it with core's
 * glue (docs/m4-persistence.md):
 *
 * - `provideWorkspacePersistence` implements the `saveWorkspace`,
 *   `saveWorkspaceAs`, `openWorkspace` and `listRecentWorkspaces` commands
 *   over `save`/`saveAs`/`open`/`listRecent`; every button, shortcut and menu
 *   item dispatches those commands.
 * - `reportUnsavedWork` feeds `updateRecovery`, the one autosave path (the
 *   host writes crash-recovery snapshots on its own schedule).
 * - `completeWorkspaceOpen` / `locateWorkspaceData` finish drops
 *   (`openDropped`), located data files (`locateData`, `cancelOpen`) and
 *   restored recovery snapshots (`listRecovery`, `restoreRecovery`,
 *   `discardRecovery`).
 * - `onOpenRequest` hands over files the OS opened with the app.
 *
 * Unsaved changes are core's digest-based `isWorkspaceDirty`. Optional:
 * without it (or without `capabilities.canSaveWorkspace`) the save/open
 * controls, the edited dot, the recent list and recovery stay hidden.
 */
export type WorkspaceFilesApi = Pick<
  WorkspaceBridge,
  | 'save'
  | 'saveAs'
  | 'open'
  | 'openDropped'
  | 'locateData'
  | 'cancelOpen'
  | 'listRecent'
  | 'listRecovery'
  | 'restoreRecovery'
  | 'discardRecovery'
  | 'updateRecovery'
  | 'onOpenRequest'
>;

/** Everything platform-specific, passed to `<App platform={…} />` once per window or page. */
export interface Platform {
  readonly name: PlatformName;
  readonly engine: EngineClientLike;
  readonly files: PlatformFiles;
  readonly clipboard: PlatformClipboard;
  readonly window: PlatformWindow;
  readonly capabilities: PlatformCapabilities;
  /** `.glassgrid` files (desktop); absent on shells that cannot save them. */
  readonly workspaceFiles?: WorkspaceFilesApi;
}

/** Whether the save/open controls show: the capability and an implementation. */
export function workspaceFilesOf(platform: Pick<Platform, 'capabilities' | 'workspaceFiles'>): WorkspaceFilesApi | null {
  return platform.capabilities.canSaveWorkspace && platform.workspaceFiles ? platform.workspaceFiles : null;
}
