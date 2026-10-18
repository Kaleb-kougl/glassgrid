import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, type OpenDialogOptions } from 'electron';
import { APP_NAME, IpcChannel, isThemePreference, type OpenCsvResult } from '@glassgrid/core';
import { applyE2EOverrides, e2eOpenPath } from './e2e';
import { EngineHost } from './engine-host';
import { applyTheme, installAppMenu } from './menu';
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

/** `--gg-ground` of each theme, so the window never flashes the wrong colour before the page paints. */
const GROUND = { light: '#e3e6ea', dark: '#0d1013' } as const;

function createMainWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? GROUND.dark : GROUND.light,
    // macOS: the traffic lights sit inset in the app's own 44px title bar.
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } } : { autoHideMenuBar: true }),
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

  ipcMain.handle(IpcChannel.openDropped, async (event, path: unknown): Promise<OpenCsvResult> => {
    assertTrustedSender(event);
    // Sent by the preload from webUtils.getPathForFile; still checked here.
    if (typeof path !== 'string' || !isAbsolute(path)) return { status: 'failed', message: 'Only files on this computer can be opened' };
    try {
      if (!(await stat(path)).isFile()) return { status: 'failed', message: `${basename(path)} is not a file` };
      const { handle, sizeBytes } = await engine.registerFile(path);
      return { status: 'opened', file: { handle, displayName: basename(path), sizeBytes } };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.on(IpcChannel.setTheme, (event, theme: unknown) => {
    assertTrustedSender(event);
    if (isThemePreference(theme)) applyTheme(theme);
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
  installAppMenu();
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
