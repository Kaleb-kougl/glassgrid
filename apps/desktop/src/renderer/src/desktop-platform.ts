import { APP_NAME, type GlassgridBridge } from '@glassgrid/core';
import type { AppMenuCommand, DocumentChrome, EngineClientLike, Platform, PlatformName, WorkspaceFilesApi } from '@glassgrid/app';

/*
 * The desktop Platform: the preload bridge (`window.glassgrid`) for files,
 * clipboard, theme, menus and `.glassgrid` workspace files, and the
 * MessagePort EngineClient for data. The page never sees a path: workspace
 * files are named by main's opaque ids (docs/m4-persistence.md).
 */

/** `process.platform` as the preload reports it → the app's platform name. */
export function platformName(nodePlatform: string): Exclude<PlatformName, 'web'> {
  if (nodePlatform === 'darwin') return 'mac';
  if (nodePlatform === 'win32') return 'win';
  return 'linux';
}

/**
 * The window title: "trips.glassgrid — Glassgrid". With unsaved changes
 * Windows and Linux prefix a dot (macOS shows it in the close button,
 * `setDocumentEdited`, and hides the title behind the app's own title bar).
 */
export function windowTitle(chrome: DocumentChrome, name: PlatformName): string {
  if (chrome.title === null) return APP_NAME;
  return `${chrome.edited && name !== 'mac' ? '● ' : ''}${chrome.title} — ${APP_NAME}`;
}

export interface DesktopPlatformTarget {
  addEventListener: Window['addEventListener'];
  removeEventListener: Window['removeEventListener'];
  /** Where the window title is set (the page title; Electron mirrors it on the native window). */
  readonly document: { title: string };
}

export function createDesktopPlatform(bridge: GlassgridBridge, engine: EngineClientLike, target: DesktopPlatformTarget = window): Platform {
  const name = platformName(bridge.platform);
  const ws = bridge.workspace;
  const workspaceFiles: WorkspaceFilesApi = {
    save: (request) => ws.save(request),
    saveAs: (request) => ws.saveAs(request),
    open: (request) => ws.open(request),
    // The DOM File itself: the isolated preload resolves its path and main checks it is a local .glassgrid file.
    openDropped: (file) => ws.openDropped(file),
    locateData: (token) => ws.locateData(token),
    cancelOpen: (token) => ws.cancelOpen(token),
    listRecent: () => ws.listRecent(),
    listRecovery: () => ws.listRecovery(),
    restoreRecovery: (id) => ws.restoreRecovery(id),
    discardRecovery: (id) => ws.discardRecovery(id),
    // Main's autosaver writes the latest report to the recovery folder every few seconds.
    updateRecovery: (update) => ws.updateRecovery(update),
    onOpenRequest: (listener) => ws.onOpenRequest(listener),
  };
  let lastChrome: string | null = null;
  return {
    name,
    engine,
    files: {
      // Main's native dialog registers the file and returns its handle.
      pickCsv: () => bridge.openCsv(),
      // The DOM File itself: the isolated preload resolves its path and main registers it.
      fileFromDrop: (data) => data.files[0] ?? null,
      openDropped: (file) => bridge.openDroppedFile(file),
      privacyNote: 'The file is read on this computer and never uploaded.',
    },
    // One purpose-built IPC call; main checks the sender and the text.
    clipboard: { writeText: (text) => bridge.clipboard.writeText(text) },
    window: {
      titleBarInset: name === 'mac',
      shortcuts: name === 'mac' ? 'mac' : 'pc',
      // File → Open CSV… (⌘O), Open Workspace… (⇧⌘O), Save (⌘S) and Save As… (⇧⌘S) are menu accelerators.
      menuShortcuts: true,
      syncTheme: (preference) => bridge.setTheme(preference),
      // One stream for both menu channels: File → Open CSV and View → Theme, and the workspace items.
      onMenuCommand: (listener: (command: AppMenuCommand) => void) => {
        const offApp = bridge.onMenuCommand(listener);
        const offWorkspace = ws.onMenuCommand(listener);
        return () => {
          offApp();
          offWorkspace();
        };
      },
      onBeforeClose: (listener) => {
        target.addEventListener('pagehide', listener);
        return () => target.removeEventListener('pagehide', listener);
      },
      // Main asks before closing; with unsaved work it shows the native Save / Don't Save / Cancel dialog.
      onCloseRequest: (handler) => ws.onCloseRequest(handler),
      setDocumentChrome: (chrome) => {
        target.document.title = windowTitle(chrome, name);
        const key = `${chrome.documentId ?? ''}|${String(chrome.edited)}`;
        if (key === lastChrome) return;
        lastChrome = key;
        ws.setDocumentState({ documentId: chrome.documentId, edited: chrome.edited });
      },
    },
    capabilities: { canSaveWorkspace: true, canOpenFromPath: true, maxFileBytes: null },
    workspaceFiles,
  };
}
