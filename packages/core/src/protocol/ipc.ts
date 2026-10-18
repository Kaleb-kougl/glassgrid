import type { OpenCsvResult } from './bridge.js';
import type {
  CloseAnswer,
  ExternalOpenRequest,
  OpenWorkspaceRequest,
  OpenWorkspaceResult,
  RecentWorkspace,
  RecoverySnapshotInfo,
  RecoveryUpdate,
  SaveWorkspaceRequest,
  SaveWorkspaceResult,
} from './workspace.js';

/*
 * Renderer <-> main contract exposed through the preload bridge. Kept tiny on
 * purpose: everything data-related goes over the engine port instead.
 *
 * This module is deliberately free of runtime dependencies (no zod) so the
 * sandboxed preload bundle stays small.
 */

export const IpcChannel = {
  /** invoke: show the open dialog, register the file, resolve an OpenedFile. */
  openCsv: 'glassgrid:open-csv',
  /** send: ask main for a fresh MessagePort connected to the engine. */
  requestEnginePort: 'glassgrid:request-engine-port',
  /** main -> preload: carries the renderer end of the engine port. */
  enginePort: 'glassgrid:engine-port',
  /**
   * invoke (preload only): register a file dropped on the window. The preload
   * resolves the dropped File to its path with `webUtils.getPathForFile` and
   * sends it here; the page itself never sees the path.
   */
  openDropped: 'glassgrid:open-dropped',
  /** send: the theme the window should use ('system' | 'light' | 'dark'), for native chrome and the View menu. */
  setTheme: 'glassgrid:set-theme',
  /** main -> preload: an application-menu command for the focused window (MenuCommand). */
  menuCommand: 'glassgrid:menu-command',
  /** invoke: put plain text on the system clipboard (the `copySelection` command). */
  clipboardWriteText: 'glassgrid:clipboard-write-text',

  // --- Workspace files (M4; see docs/m4-persistence.md) ---------------------
  /** invoke(SaveWorkspaceRequest): save to the document's file, or Save As when it has none. */
  workspaceSave: 'glassgrid:workspace-save',
  /** invoke(SaveWorkspaceRequest): native save dialog, then save. */
  workspaceSaveAs: 'glassgrid:workspace-save-as',
  /** invoke(OpenWorkspaceRequest): open from the dialog, the recent list or an OS hand-off token. */
  workspaceOpen: 'glassgrid:workspace-open',
  /** invoke (preload only): open a dropped `.glassgrid` file; the preload resolves its path. */
  workspaceOpenDropped: 'glassgrid:workspace-open-dropped',
  /** invoke(token): ask the person to locate a workspace's missing data file. */
  workspaceLocateData: 'glassgrid:workspace-locate-data',
  /** invoke(token): forget a pending open. */
  workspaceCancelOpen: 'glassgrid:workspace-cancel-open',
  /** invoke: the recent workspaces (pruned of files that disappeared). */
  workspaceListRecent: 'glassgrid:workspace-list-recent',
  /** invoke: crash-recovery snapshots newer than their saved file. */
  workspaceListRecovery: 'glassgrid:workspace-list-recovery',
  /** invoke(id): open a recovery snapshot. */
  workspaceRestoreRecovery: 'glassgrid:workspace-restore-recovery',
  /** invoke(id): delete a recovery snapshot. */
  workspaceDiscardRecovery: 'glassgrid:workspace-discard-recovery',
  /** send(RecoveryUpdate | null): the window's unsaved work for the autosaver; null when clean. */
  workspaceRecoveryUpdate: 'glassgrid:workspace-recovery-update',
  /** invoke: start receiving OS open requests; returns the ones queued so far. */
  workspaceOpenRequestsListen: 'glassgrid:workspace-open-requests-listen',
  /** main -> preload: a workspace file handed over by the OS (ExternalOpenRequest). */
  workspaceOpenRequest: 'glassgrid:workspace-open-request',
  /** main -> preload: the window is closing; reply on `workspaceCloseReply` with the same request id. */
  workspaceCloseQuery: 'glassgrid:workspace-close-query',
  /** send(CloseReply): the renderer's answer to `workspaceCloseQuery`. */
  workspaceCloseReply: 'glassgrid:workspace-close-reply',
  /** main -> preload: a File-menu workspace command (WorkspaceMenuCommand). */
  workspaceMenuCommand: 'glassgrid:workspace-menu-command',
} as const;

/** File-menu workspace commands main forwards to the focused window (Open Workspace…, Save, Save As…). */
export type WorkspaceMenuCommand =
  | { readonly kind: 'openWorkspace' }
  | { readonly kind: 'saveWorkspace' }
  | { readonly kind: 'saveWorkspaceAs' };

/** Shape check for a pushed open request, without zod (the preload bundle stays small). */
export function isExternalOpenRequest(value: unknown): value is ExternalOpenRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as { token?: unknown; fileName?: unknown };
  return typeof request.token === 'string' && /^ot_[A-Za-z0-9-]{8,64}$/.test(request.token) && typeof request.fileName === 'string';
}

export function isWorkspaceMenuCommand(value: unknown): value is WorkspaceMenuCommand {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'openWorkspace' || kind === 'saveWorkspace' || kind === 'saveWorkspaceAs';
}

/** Largest text `clipboard.writeText` accepts (UTF-16 code units); copies are capped well below this. */
export const MAX_CLIPBOARD_TEXT = 64 * 1024 * 1024;

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** Application-menu commands main forwards to the focused window. */
export type MenuCommand = { readonly kind: 'open' } | { readonly kind: 'theme'; readonly theme: ThemePreference };

export function isMenuCommand(value: unknown): value is MenuCommand {
  if (typeof value !== 'object' || value === null) return false;
  const command = value as { kind?: unknown; theme?: unknown };
  return command.kind === 'open' || (command.kind === 'theme' && isThemePreference(command.theme));
}

/**
 * What the bridge needs from a dropped file: the DOM `File` object itself,
 * which the preload turns into a path. Typed structurally so core stays
 * free of DOM typings.
 */
export interface DroppedFile {
  readonly name: string;
}

/** `window.postMessage` tag the preload uses to hand the port to the page. */
export const ENGINE_PORT_WINDOW_MESSAGE = 'glassgrid:engine-port';

/** Shape of `window.glassgrid`, implemented by the desktop preload. */
export interface GlassgridBridge {
  readonly platform: string;
  openCsv(): Promise<OpenCsvResult>;
  /** Open a file dropped on the window (a DOM `File`). Resolves like `openCsv`, never with a path. */
  openDroppedFile(file: DroppedFile): Promise<OpenCsvResult>;
  requestEnginePort(): void;
  /** Tell main which theme the window uses (native frame colour, View menu check marks). */
  setTheme(theme: ThemePreference): void;
  /** Subscribe to application-menu commands. Returns an unsubscribe function. */
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  /** The system clipboard, write-only: the one way cells leave the app (`copySelection`). */
  readonly clipboard: {
    writeText(text: string): Promise<void>;
  };
  /** Workspace files: save, open, recent list, crash recovery and the close prompt. */
  readonly workspace: WorkspaceBridge;
}

/**
 * `window.glassgrid.workspace`: `.glassgrid` files through main. Paths never
 * reach the page; documents, recent entries, pending opens and recovery
 * snapshots are named by opaque ids. See docs/m4-persistence.md for the flows.
 */
export interface WorkspaceBridge {
  /** Save to the document's file (`request.documentId`); behaves like `saveAs` when it has none. */
  save(request: SaveWorkspaceRequest): Promise<SaveWorkspaceResult>;
  /** Native save dialog (default name from the data file, `.glassgrid` filter), then save. */
  saveAs(request: SaveWorkspaceRequest): Promise<SaveWorkspaceResult>;
  /** Open a workspace file and relink its data (relative path, absolute path, else `needsData`). */
  open(request: OpenWorkspaceRequest): Promise<OpenWorkspaceResult>;
  /** Open a `.glassgrid` file dropped on the window (a DOM `File`). */
  openDropped(file: DroppedFile): Promise<OpenWorkspaceResult>;
  /** After `needsData`: native open dialog for the data file, then fingerprint check. Cancelling keeps the token. */
  locateData(token: string): Promise<OpenWorkspaceResult>;
  /** Forget a pending open (`needsData` the person dismissed). */
  cancelOpen(token: string): Promise<void>;
  listRecent(): Promise<RecentWorkspace[]>;
  /** Unsaved work left by a crash, newest first; offer "Restore unsaved work" at launch. */
  listRecovery(): Promise<RecoverySnapshotInfo[]>;
  restoreRecovery(id: string): Promise<OpenWorkspaceResult>;
  discardRecovery(id: string): Promise<void>;
  /** Report the window's unsaved work (null when clean); main writes it to the recovery folder every few seconds. */
  updateRecovery(update: RecoveryUpdate | null): void;
  /** Workspace files the OS hands the app (double-click, Open with, second launch). Queued ones are delivered on subscribe. */
  onOpenRequest(listener: (request: ExternalOpenRequest) => void): () => void;
  /**
   * Answer main's "may this window close?". One handler per window (a new one
   * replaces the old). Without a handler the window closes without asking.
   */
  onCloseRequest(handler: () => CloseAnswer | Promise<CloseAnswer>): () => void;
  /** File-menu workspace commands (Open Workspace…, Save, Save As…). */
  onMenuCommand(listener: (command: WorkspaceMenuCommand) => void): () => void;
}
