import type { GlassgridBridge } from '@glassgrid/core';
import type { EngineClientLike, Platform, PlatformName } from '@glassgrid/app';

/*
 * The desktop Platform: the preload bridge (`window.glassgrid`) for files,
 * clipboard, theme and menus, and the MessagePort EngineClient for data.
 * Behaviour is what the renderer did before the app moved to
 * @glassgrid/app; the page never sees a path.
 */

/** `process.platform` as the preload reports it → the app's platform name. */
export function platformName(nodePlatform: string): Exclude<PlatformName, 'web'> {
  if (nodePlatform === 'darwin') return 'mac';
  if (nodePlatform === 'win32') return 'win';
  return 'linux';
}

export function createDesktopPlatform(bridge: GlassgridBridge, engine: EngineClientLike, target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): Platform {
  const name = platformName(bridge.platform);
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
      syncTheme: (preference) => bridge.setTheme(preference),
      onMenuCommand: (listener) => bridge.onMenuCommand(listener),
      onBeforeClose: (listener) => {
        target.addEventListener('pagehide', listener);
        return () => target.removeEventListener('pagehide', listener);
      },
    },
    // `.glassgrid` files arrive with the persistence work (workspaceFiles + canSaveWorkspace).
    capabilities: { canSaveWorkspace: false, canOpenFromPath: true, maxFileBytes: null },
  };
}
