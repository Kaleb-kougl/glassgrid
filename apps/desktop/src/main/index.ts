import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, webContents, type OpenDialogOptions } from 'electron';
import { APP_NAME, IpcChannel, isThemePreference, MAX_CLIPBOARD_TEXT, type OpenCsvResult } from '@glassgrid/core';
import { fingerprintFile } from '@glassgrid/engine';
import { nodeFiles } from '@glassgrid/engine/native';
import { applyE2EOverrides, e2eEngineOverrides, e2eOpenPath, isE2E } from './e2e';
import { EngineHost } from './engine-host';
import { applyTheme, installAppMenu } from './menu';
import { AppStateStore } from './persistence/app-state';
import { CloseGuard } from './persistence/close-guard';
import { OpenRequestQueue, workspacePathsFromArgv } from './persistence/external-open';
import { registerWorkspaceIpc } from './persistence/ipc';
import { RecoveryStore } from './persistence/recovery';
import { WorkspaceService, type WindowRef } from './persistence/workspace-service';
import { createSenderGuard, installSecurityPolicies } from './security';

const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
const rendererIndex = join(__dirname, '../renderer/index.html');
const rendererOrigin = devServerUrl ?? pathToFileURL(rendererIndex).href;

applyE2EOverrides();

const engine = new EngineHost(() => ({
  cacheDir: join(app.getPath('userData'), 'cache', 'parquet'),
  tempDir: join(app.getPath('userData'), 'cache', 'duckdb-tmp'),
  ...e2eEngineOverrides(),
}));
const assertTrustedSender = createSenderGuard((url) => url.startsWith(rendererOrigin));

// --- Workspace files (docs/m4-persistence.md) ---------------------------------

const workspaces = new WorkspaceService<BrowserWindow | null>({
  app: { name: APP_NAME, version: app.getVersion() },
  dialogs: {
    showSaveDialog: (owner, options) => (owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options)),
    showOpenDialog: (owner, options) => (owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options)),
  },
  registerFile: (path) => engine.registerFile(path),
  pathOfHandle: (handle) => engine.pathOf(handle),
  // The engine's own fingerprint function, so a relinked file is compared exactly as the Parquet cache keys it.
  fingerprint: (path) => fingerprintFile(nodeFiles, path),
  appState: new AppStateStore(join(app.getPath('userData'), 'state.json')),
  recovery: new RecoveryStore(join(app.getPath('userData'), 'recovery')),
  addRecentDocument: (path) => app.addRecentDocument(path),
  onRecentChanged: () => refreshAppMenu(),
});

/** Rebuilds the application menu with the current recent list (File → Open Recent). */
function refreshAppMenu(): void {
  if (!ready) return;
  workspaces.listRecent().then(
    (recent) => installAppMenu(recent),
    (error: unknown) => console.warn('[main] could not read the recent workspaces', error),
  );
}

const windowRef = (win: BrowserWindow): WindowRef<BrowserWindow | null> => ({ key: win.webContents.id, owner: win });

const openRequests = new OpenRequestQueue(() => BrowserWindow.getFocusedWindow()?.webContents.id ?? null);

/** True between `before-quit` and the last window closing; cleared when the person cancels a close. */
let quitting = false;

const closeGuard = new CloseGuard<BrowserWindow>({
  showMessageBox: (win, options) => dialog.showMessageBox(win, options),
  showErrorBox: (title, content) => dialog.showErrorBox(title, content),
  save: (win, answer) => workspaces.save(windowRef(win), { documentId: answer.documentId, snapshot: answer.snapshot }),
  closed: (win, clean) => workspaces.windowClosed(windowRef(win), clean),
  displayName: (_win, answer) => {
    const path = workspaces.documentPath(answer.documentId);
    return path === undefined ? `the workspace for ${answer.snapshot.dataSource.fileName}` : basename(path);
  },
  decided: (_win, closed) => {
    if (!closed) quitting = false;
    else if (quitting) setImmediate(() => app.quit());
  },
});

/** Workspace files handed over by the OS before the app was ready. */
const earlyOpens: string[] = [];
let ready = false;

function requestExternalOpen(path: string): void {
  if (!ready) {
    earlyOpens.push(path);
    return;
  }
  openRequests.push(workspaces.externalOpen(path));
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

// macOS: double-click / "Open with" (also before `ready`, at launch).
app.on('open-file', (event, path) => {
  event.preventDefault();
  requestExternalOpen(path);
});

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
    // Under test only: macOS clamps a window to the screen, and CI's macOS displays are smaller than the
    // 1440x900 design frame. The grid mirrors only the columns on screen, so a clamped window hides columns
    // the E2E expects. Other platforms already allow larger-than-screen windows.
    ...(isE2E && isMac ? { enableLargerThanScreen: true } : {}),
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
  closeGuard.attach(win);
  const contentsId = win.webContents.id;
  win.on('closed', () => openRequests.remove(contentsId));

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

  ipcMain.handle(IpcChannel.clipboardWriteText, async (event, text: unknown) => {
    assertTrustedSender(event);
    if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_TEXT) throw new Error('Clipboard text must be a string of at most 64M characters');
    await clipboard.writeText(text);
  });

  ipcMain.on(IpcChannel.requestEnginePort, (event) => {
    assertTrustedSender(event);
    engine.connectRenderer(event.sender);
  });

  registerWorkspaceIpc<BrowserWindow | null>({
    ipcMain,
    service: workspaces,
    closeGuard,
    openRequests,
    assertTrustedSender,
    windowOf: (event) => {
      const contents = webContents.fromId(event.sender.id);
      return { key: event.sender.id, owner: contents ? BrowserWindow.fromWebContents(contents) : null };
    },
    sendOpenRequest: (key, request) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.id === key);
      if (win && !win.isDestroyed()) win.webContents.send(IpcChannel.workspaceOpenRequest, request);
    },
    // macOS: the proxy icon / title menu of the workspace file, and the edited dot in the close button.
    setDocumentState: ({ owner }, { path, edited }) => {
      if (process.platform !== 'darwin' || !owner || owner.isDestroyed()) return;
      owner.setRepresentedFilename(path ?? '');
      owner.setDocumentEdited(edited);
    },
  });
}

engine.on('restarted', () => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) engine.connectRenderer(win.webContents);
  }
});

// Windows and Linux hand a double-clicked workspace to a second launch; send it to the running app instead.
// (E2E runs get their own userData and may overlap while one shuts down, so they skip the lock.)
const primary = isE2E || app.requestSingleInstanceLock();
if (!primary) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    for (const path of workspacePathsFromArgv(argv, workingDirectory)) requestExternalOpen(path);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    installSecurityPolicies();
    installAppMenu();
    registerIpcHandlers();
    engine.start();
    workspaces.autosaver.start();
    createMainWindow();

    ready = true;
    refreshAppMenu();
    for (const path of [...workspacePathsFromArgv(process.argv, process.cwd()), ...earlyOpens.splice(0)]) requestExternalOpen(path);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  }, (error: unknown) => {
    console.error('[main] failed to start', error);
    app.exit(1);
  });
}

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Only once every window agreed to close: a cancelled "Save changes?" keeps the engine running.
app.on('will-quit', () => {
  workspaces.autosaver.stop();
  engine.stop();
});
