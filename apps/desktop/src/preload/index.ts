import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  ENGINE_PORT_WINDOW_MESSAGE,
  IpcChannel,
  isExternalOpenRequest,
  isMenuCommand,
  isWorkspaceMenuCommand,
  type CloseAnswer,
  type CloseReply,
  type DroppedFile,
  type ExternalOpenRequest,
  type GlassgridBridge,
  type MenuCommand,
  type OpenCsvResult,
  type OpenWorkspaceResult,
  type RecentWorkspace,
  type RecoverySnapshotInfo,
  type SaveWorkspaceResult,
  type ThemePreference,
  type WorkspaceBridge,
  type WorkspaceMenuCommand,
} from '@glassgrid/core';

/*
 * MessagePorts cannot be passed through contextBridge, so the engine port is
 * forwarded to the page with window.postMessage (Electron's documented
 * pattern). The page validates `event.source === window` before accepting it,
 * and navigation away from the app is blocked in main, so '*' cannot leak the
 * port to another origin.
 */
ipcRenderer.on(IpcChannel.enginePort, (event) => {
  window.postMessage(ENGINE_PORT_WINDOW_MESSAGE, '*', event.ports);
});

const menuListeners = new Set<(command: MenuCommand) => void>();
ipcRenderer.on(IpcChannel.menuCommand, (_event, command: unknown) => {
  if (!isMenuCommand(command)) return;
  for (const listener of menuListeners) listener(command);
});

/** The path of a dropped DOM File, or '' for one the page constructed itself. */
function pathOfDroppedFile(file: DroppedFile): string {
  try {
    return webUtils.getPathForFile(file as File);
  } catch {
    return '';
  }
}

/**
 * Drag-and-drop keeps the M0 rule that the page never sees a path: the page
 * hands over the dropped File, this isolated preload resolves its path and
 * sends it straight to main, and only the handle comes back. A File the page
 * constructed itself has no path and is refused here.
 */
function openDroppedFile(file: DroppedFile): Promise<OpenCsvResult> {
  const path = pathOfDroppedFile(file);
  if (path === '') {
    return Promise.resolve({ status: 'failed', message: `${file.name} is not a file on this computer` });
  }
  return ipcRenderer.invoke(IpcChannel.openDropped, path) as Promise<OpenCsvResult>;
}

// --- Workspace files ----------------------------------------------------------

const workspaceMenuListeners = new Set<(command: WorkspaceMenuCommand) => void>();
ipcRenderer.on(IpcChannel.workspaceMenuCommand, (_event, command: unknown) => {
  if (!isWorkspaceMenuCommand(command)) return;
  for (const listener of workspaceMenuListeners) listener(command);
});

/*
 * OS open requests: main queues them until the page subscribes, then pushes
 * new ones. The first subscription asks main for the queue.
 */
const openRequestListeners = new Set<(request: ExternalOpenRequest) => void>();
let listeningForOpenRequests = false;
function deliverOpenRequest(request: unknown): void {
  if (!isExternalOpenRequest(request)) return;
  for (const listener of openRequestListeners) listener(request);
}
ipcRenderer.on(IpcChannel.workspaceOpenRequest, (_event, request: unknown) => deliverOpenRequest(request));

/*
 * Close prompt: main asks before closing the window. Without a handler (or
 * if it throws) the answer is null and main closes without asking; the
 * autosaved recovery snapshot, if any, is kept.
 */
let closeHandler: (() => CloseAnswer | Promise<CloseAnswer>) | null = null;
ipcRenderer.on(IpcChannel.workspaceCloseQuery, (_event, requestId: unknown) => {
  if (typeof requestId !== 'string') return;
  const reply = (answer: CloseAnswer | null) => {
    const message: CloseReply = { requestId, answer };
    ipcRenderer.send(IpcChannel.workspaceCloseReply, message);
  };
  const handler = closeHandler;
  if (handler === null) {
    reply(null);
    return;
  }
  Promise.resolve()
    .then(handler)
    .then(reply, (error: unknown) => {
      console.error('[preload] close handler failed', error);
      reply(null);
    });
});

const workspace: WorkspaceBridge = {
  save: (request) => ipcRenderer.invoke(IpcChannel.workspaceSave, request) as Promise<SaveWorkspaceResult>,
  saveAs: (request) => ipcRenderer.invoke(IpcChannel.workspaceSaveAs, request) as Promise<SaveWorkspaceResult>,
  open: (request) => ipcRenderer.invoke(IpcChannel.workspaceOpen, request) as Promise<OpenWorkspaceResult>,
  openDropped: (file) => {
    const path = pathOfDroppedFile(file);
    if (path === '') return Promise.resolve({ status: 'failed', code: 'io', message: `${file.name} is not a file on this computer` });
    return ipcRenderer.invoke(IpcChannel.workspaceOpenDropped, path) as Promise<OpenWorkspaceResult>;
  },
  locateData: (token) => ipcRenderer.invoke(IpcChannel.workspaceLocateData, token) as Promise<OpenWorkspaceResult>,
  cancelOpen: (token) => ipcRenderer.invoke(IpcChannel.workspaceCancelOpen, token) as Promise<void>,
  listRecent: () => ipcRenderer.invoke(IpcChannel.workspaceListRecent) as Promise<RecentWorkspace[]>,
  listRecovery: () => ipcRenderer.invoke(IpcChannel.workspaceListRecovery) as Promise<RecoverySnapshotInfo[]>,
  restoreRecovery: (id) => ipcRenderer.invoke(IpcChannel.workspaceRestoreRecovery, id) as Promise<OpenWorkspaceResult>,
  discardRecovery: (id) => ipcRenderer.invoke(IpcChannel.workspaceDiscardRecovery, id) as Promise<void>,
  updateRecovery: (update) => ipcRenderer.send(IpcChannel.workspaceRecoveryUpdate, update),
  onOpenRequest: (listener) => {
    openRequestListeners.add(listener);
    if (!listeningForOpenRequests) {
      listeningForOpenRequests = true;
      void (ipcRenderer.invoke(IpcChannel.workspaceOpenRequestsListen) as Promise<unknown>).then((queued) => {
        if (Array.isArray(queued)) for (const request of queued) deliverOpenRequest(request);
      });
    }
    return () => openRequestListeners.delete(listener);
  },
  onCloseRequest: (handler) => {
    closeHandler = handler;
    return () => {
      if (closeHandler === handler) closeHandler = null;
    };
  },
  onMenuCommand: (listener) => {
    workspaceMenuListeners.add(listener);
    return () => workspaceMenuListeners.delete(listener);
  },
};

const bridge: GlassgridBridge = {
  platform: process.platform,
  openCsv: () => ipcRenderer.invoke(IpcChannel.openCsv) as Promise<OpenCsvResult>,
  openDroppedFile,
  requestEnginePort: () => ipcRenderer.send(IpcChannel.requestEnginePort),
  setTheme: (theme: ThemePreference) => ipcRenderer.send(IpcChannel.setTheme, theme),
  onMenuCommand: (listener) => {
    menuListeners.add(listener);
    return () => menuListeners.delete(listener);
  },
  // One purpose-built call, not a generic IPC: main checks the sender and the text before writing it.
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke(IpcChannel.clipboardWriteText, text) as Promise<void>,
  },
  workspace,
};

contextBridge.exposeInMainWorld('glassgrid', bridge);
