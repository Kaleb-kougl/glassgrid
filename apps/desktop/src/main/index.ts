import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { APP_NAME, IpcChannel, type OpenCsvResult } from '@glassgrid/core';
import { applyE2EOverrides, e2eOpenPath } from './e2e';
import { EngineHost } from './engine-host';
import { createSenderGuard, installSecurityPolicies } from './security';

const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
const rendererIndex = join(__dirname, '../renderer/index.html');
const rendererOrigin = devServerUrl ?? pathToFileURL(rendererIndex).href;

applyE2EOverrides();

const engine = new EngineHost(() => ({
  cacheDir: join(app.getPath('userData'), 'cache', 'parquet'),
  tempDir: join(app.getPath('userData'), 'cache', 'duckdb-tmp'),
}));
const assertTrustedSender = createSenderGuard((url) => url.startsWith(rendererOrigin));

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: APP_NAME,
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 420,
    show: false,
    backgroundColor: '#111317',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(rendererIndex);
  }
  return win;
}

async function pickCsvPath(owner: BrowserWindow | null): Promise<string | undefined> {
  const options: OpenDialogOptions = {
    title: 'Open CSV',
    properties: ['openFile'],
    filters: [
      { name: 'Delimited text', extensions: ['csv', 'tsv', 'txt', 'gz'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.openCsv, async (event): Promise<OpenCsvResult> => {
    assertTrustedSender(event);
    const path = e2eOpenPath() ?? (await pickCsvPath(BrowserWindow.fromWebContents(event.sender)));
    if (!path) return { status: 'cancelled' };

    try {
      const { handle, sizeBytes } = await engine.registerFile(path);
      return { status: 'opened', file: { handle, displayName: basename(path), sizeBytes } };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.on(IpcChannel.requestEnginePort, (event) => {
    assertTrustedSender(event);
    engine.connectRenderer(event.sender);
  });
}

engine.on('restarted', () => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) engine.connectRenderer(win.webContents);
  }
});

app.whenReady().then(() => {
  installSecurityPolicies();
  registerIpcHandlers();
  engine.start();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}, (error: unknown) => {
  console.error('[main] failed to start', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => engine.stop());
