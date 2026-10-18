import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  ENGINE_PORT_WINDOW_MESSAGE,
  IpcChannel,
  isMenuCommand,
  type DroppedFile,
  type GlassgridBridge,
  type MenuCommand,
  type OpenCsvResult,
  type ThemePreference,
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

/**
 * Drag-and-drop keeps the M0 rule that the page never sees a path: the page
 * hands over the dropped File, this isolated preload resolves its path and
 * sends it straight to main, and only the handle comes back. A File the page
 * constructed itself has no path and is refused here.
 */
function openDroppedFile(file: DroppedFile): Promise<OpenCsvResult> {
  let path: string;
  try {
    path = webUtils.getPathForFile(file as File);
  } catch {
    path = '';
  }
  if (path === '') {
    return Promise.resolve({ status: 'failed', message: `${file.name} is not a file on this computer` });
  }
  return ipcRenderer.invoke(IpcChannel.openDropped, path) as Promise<OpenCsvResult>;
}

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
};

contextBridge.exposeInMainWorld('glassgrid', bridge);
