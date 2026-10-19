import { vi } from 'vitest';
import type { CloseAnswer, OpenCsvResult, ThemePreference } from '@glassgrid/core';
import type { EngineClientLike } from '../engine';
import type { AppMenuCommand, DocumentChrome, DroppedFileRef, Platform, PlatformCapabilities, SampleDataset, WorkspaceFilesApi } from '../platform';

/*
 * A Platform for tests: every capability a vi.fn the test can inspect and
 * steer, around the engine the test passes in. Menu commands, the
 * before-close hook and the close veto are driven with `menu()`, `close()`
 * and `requestClose()`.
 */

export interface FakePlatformOptions {
  /** What the picker resolves with (default: cancelled). */
  picked?: OpenCsvResult;
  /** What a drop resolves with (default: cancelled). */
  dropped?: OpenCsvResult;
  name?: Platform['name'];
  samples?: readonly SampleDataset[];
  capabilities?: Partial<PlatformCapabilities>;
  workspaceFiles?: WorkspaceFilesApi;
  /** A native menu owns the file shortcuts (desktop). */
  menuShortcuts?: boolean;
}

export function fakePlatform<E extends EngineClientLike>(engine: E, options: FakePlatformOptions = {}) {
  const menuListeners = new Set<(command: AppMenuCommand) => void>();
  const closeListeners = new Set<() => void>();
  let closeHandler: (() => CloseAnswer | Promise<CloseAnswer>) | null = null;
  const cancelled: OpenCsvResult = { status: 'cancelled' };
  const files = {
    pickCsv: vi.fn((): Promise<OpenCsvResult> => Promise.resolve(options.picked ?? cancelled)),
    fileFromDrop: vi.fn((data: DataTransfer): DroppedFileRef | null => data.files[0] ?? null),
    openDropped: vi.fn((_file: DroppedFileRef): Promise<OpenCsvResult> => Promise.resolve(options.dropped ?? cancelled)),
    privacyNote: 'The file is read on this computer and never uploaded.',
    ...(options.samples ? { samples: options.samples } : {}),
    openSample: vi.fn((_id: string): Promise<OpenCsvResult> => Promise.resolve(options.picked ?? cancelled)),
  };
  const clipboard = { writeText: vi.fn((_text: string) => Promise.resolve()) };
  const shell = {
    titleBarInset: false,
    shortcuts: 'pc' as const,
    menuShortcuts: options.menuShortcuts ?? false,
    syncTheme: vi.fn((_preference: ThemePreference) => undefined),
    setDocumentChrome: vi.fn((_chrome: DocumentChrome) => undefined),
    onCloseRequest: (handler: () => CloseAnswer | Promise<CloseAnswer>) => {
      closeHandler = handler;
      return () => {
        if (closeHandler === handler) closeHandler = null;
      };
    },
    onMenuCommand: (listener: (command: AppMenuCommand) => void) => {
      menuListeners.add(listener);
      return () => menuListeners.delete(listener);
    },
    onBeforeClose: (listener: () => void) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };
  const platform: Platform = {
    name: options.name ?? 'linux',
    engine,
    files,
    clipboard,
    window: shell,
    capabilities: { canSaveWorkspace: false, canOpenFromPath: true, maxFileBytes: null, ...options.capabilities },
    ...(options.workspaceFiles ? { workspaceFiles: options.workspaceFiles } : {}),
  };
  return {
    platform,
    engine,
    files,
    clipboard,
    shell,
    /** Deliver a native menu command to the app. */
    menu: (command: AppMenuCommand) => menuListeners.forEach((listener) => listener(command)),
    /** The window is going away. */
    close: () => closeListeners.forEach((listener) => listener()),
    /** The shell asks whether the window may close: the app's answer, or null without a handler. */
    requestClose: async (): Promise<CloseAnswer | null> => (closeHandler ? closeHandler() : null),
  };
}
