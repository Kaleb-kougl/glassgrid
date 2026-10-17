import { contextBridge, ipcRenderer } from 'electron';
import {
  ENGINE_PORT_WINDOW_MESSAGE,
  IpcChannel,
  type GlassgridBridge,
  type OpenCsvResult,
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

const bridge: GlassgridBridge = {
  platform: process.platform,
  openCsv: () => ipcRenderer.invoke(IpcChannel.openCsv) as Promise<OpenCsvResult>,
  requestEnginePort: () => ipcRenderer.send(IpcChannel.requestEnginePort),
};

contextBridge.exposeInMainWorld('glassgrid', bridge);
