import { app, BrowserWindow, Menu, nativeTheme, type MenuItemConstructorOptions } from 'electron';
import { IpcChannel, type MenuCommand, type ThemePreference } from '@glassgrid/core';

const THEME_LABELS: Record<ThemePreference, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/** Menu item id of a theme choice, e.g. `theme-dark` (E2E tests click these). */
export function themeMenuId(theme: ThemePreference): string {
  return `theme-${theme}`;
}

function send(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(IpcChannel.menuCommand, command);
}

/**
 * Application menu. Undo/Redo are deliberately not menu accelerators: the
 * renderer handles Cmd/Ctrl+Z through the command registry, and a menu
 * accelerator would swallow or double the key on some platforms.
 */
export function installAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { id: 'open', label: 'Open CSV…', accelerator: 'CmdOrCtrl+O', click: () => send({ kind: 'open' }) },
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
