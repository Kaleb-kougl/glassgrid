import type { OpenCsvResult } from './bridge.js';

/*
 * Renderer <-> main contract exposed through the preload bridge. Kept tiny on
 * purpose: everything data-related goes over the engine port instead.
 *
 * This module is deliberately free of runtime dependencies (no zod) so the
 * sandboxed preload bundle stays small.
 */

export const IpcChannel = {
  /** invoke: show the open dialog, register the file, resolve an OpenedFile. */
  openCsv: 'glassgrid:open-csv',
  /** send: ask main for a fresh MessagePort connected to the engine. */
  requestEnginePort: 'glassgrid:request-engine-port',
  /** main -> preload: carries the renderer end of the engine port. */
  enginePort: 'glassgrid:engine-port',
  /**
   * invoke (preload only): register a file dropped on the window. The preload
   * resolves the dropped File to its path with `webUtils.getPathForFile` and
   * sends it here; the page itself never sees the path.
   */
  openDropped: 'glassgrid:open-dropped',
  /** send: the theme the window should use ('system' | 'light' | 'dark'), for native chrome and the View menu. */
  setTheme: 'glassgrid:set-theme',
  /** main -> preload: an application-menu command for the focused window (MenuCommand). */
  menuCommand: 'glassgrid:menu-command',
} as const;

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** Application-menu commands main forwards to the focused window. */
export type MenuCommand = { readonly kind: 'open' } | { readonly kind: 'theme'; readonly theme: ThemePreference };

export function isMenuCommand(value: unknown): value is MenuCommand {
  if (typeof value !== 'object' || value === null) return false;
  const command = value as { kind?: unknown; theme?: unknown };
  return command.kind === 'open' || (command.kind === 'theme' && isThemePreference(command.theme));
}

/**
 * What the bridge needs from a dropped file: the DOM `File` object itself,
 * which the preload turns into a path. Typed structurally so core stays
 * free of DOM typings.
 */
export interface DroppedFile {
  readonly name: string;
}

/** `window.postMessage` tag the preload uses to hand the port to the page. */
export const ENGINE_PORT_WINDOW_MESSAGE = 'glassgrid:engine-port';

/** Shape of `window.glassgrid`, implemented by the desktop preload. */
export interface GlassgridBridge {
  readonly platform: string;
  openCsv(): Promise<OpenCsvResult>;
  /** Open a file dropped on the window (a DOM `File`). Resolves like `openCsv`, never with a path. */
  openDroppedFile(file: DroppedFile): Promise<OpenCsvResult>;
  requestEnginePort(): void;
  /** Tell main which theme the window uses (native frame colour, View menu check marks). */
  setTheme(theme: ThemePreference): void;
  /** Subscribe to application-menu commands. Returns an unsubscribe function. */
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
}
