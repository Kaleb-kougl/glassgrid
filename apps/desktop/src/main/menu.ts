import { app, BrowserWindow, Menu, nativeTheme, type MenuItemConstructorOptions } from 'electron';
import { IpcChannel, type MenuCommand, type RecentWorkspace, type ThemePreference, type WorkspaceMenuCommand } from '@glassgrid/core';

const THEME_LABELS: Record<ThemePreference, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/** Menu item id of a theme choice, e.g. `theme-dark` (E2E tests click these). */
export function themeMenuId(theme: ThemePreference): string {
  return `theme-${theme}`;
}

function send(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(IpcChannel.menuCommand, command);
}

/** Workspace-file menu commands go on their own channel (the renderer dispatches the matching command). */
function sendWorkspace(command: WorkspaceMenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(IpcChannel.workspaceMenuCommand, command);
}

/** Most entries File → Open Recent shows (the recent list keeps 10). */
const MAX_RECENT_ITEMS = 10;

/**
 * File → Open Recent: one item per recent workspace (file name, with the
 * folder when two share a name), each sending `openRecentWorkspace` with the
 * entry's opaque id, so the renderer opens it through the `openWorkspace`
 * command like the start screen's list.
 */
export function recentMenuItems(recent: readonly RecentWorkspace[]): MenuItemConstructorOptions[] {
  if (recent.length === 0) return [{ id: 'open-recent-empty', label: 'No Recent Workspaces', enabled: false }];
  const shown = recent.slice(0, MAX_RECENT_ITEMS);
  const names = new Map<string, number>();
  for (const entry of shown) names.set(entry.fileName, (names.get(entry.fileName) ?? 0) + 1);
  return shown.map((entry) => ({
    id: `open-recent-${entry.id}`,
    label: (names.get(entry.fileName) ?? 0) > 1 ? `${entry.fileName} — ${entry.directory}` : entry.fileName,
    click: () => sendWorkspace({ kind: 'openRecentWorkspace', id: entry.id }),
  }));
}

/**
 * Application menu. Undo/Redo are deliberately not menu accelerators: the
 * renderer handles Cmd/Ctrl+Z through the command registry, and a menu
 * accelerator would swallow or double the key on some platforms. The file
 * shortcuts (Open, Open Workspace, Save, Save As) are menu accelerators, and
 * the desktop renderer leaves those keys to the menu (`menuShortcuts`).
 * Rebuilt with the latest recent list whenever it changes.
 */
export function installAppMenu(recent: readonly RecentWorkspace[] = []): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { id: 'open', label: 'Open CSV…', accelerator: 'CmdOrCtrl+O', click: () => send({ kind: 'open' }) },
        {
          id: 'open-workspace',
          label: 'Open Workspace…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendWorkspace({ kind: 'openWorkspace' }),
        },
        { id: 'open-recent', label: 'Open Recent', submenu: recentMenuItems(recent) },
        { type: 'separator' },
        { id: 'save-workspace', label: 'Save Workspace', accelerator: 'CmdOrCtrl+S', click: () => sendWorkspace({ kind: 'saveWorkspace' }) },
        {
          id: 'save-workspace-as',
          label: 'Save Workspace As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendWorkspace({ kind: 'saveWorkspaceAs' }),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Theme',
          submenu: (['system', 'light', 'dark'] as const).map((theme) => ({
            id: themeMenuId(theme),
            label: THEME_LABELS[theme],
            type: 'radio' as const,
            checked: nativeTheme.themeSource === theme,
            click: () => send({ kind: 'theme', theme }),
          })),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(app.isPackaged ? [] : [{ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const }]),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Applies the window's theme to native chrome and ticks the matching View → Theme item. */
export function applyTheme(theme: ThemePreference): void {
  nativeTheme.themeSource = theme;
  const item = Menu.getApplicationMenu()?.getMenuItemById(themeMenuId(theme));
  if (item) item.checked = true;
}
