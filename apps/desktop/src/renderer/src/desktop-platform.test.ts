import { describe, expect, it, vi } from 'vitest';
import { toFileHandle, type GlassgridBridge, type MenuCommand, type OpenCsvResult } from '@glassgrid/core';
import type { EngineClientLike } from '@glassgrid/app';
import { createDesktopPlatform, platformName } from './desktop-platform';

const opened: OpenCsvResult = { status: 'opened', file: { handle: toFileHandle('0b6c8f0e-6d0a-4f43-9d3e-2f1f1a0d9c11'), displayName: 'trips.csv', sizeBytes: 10 } };

function setup(nodePlatform = 'darwin') {
  const menuListeners = new Set<(command: MenuCommand) => void>();
  const bridge = {
    platform: nodePlatform,
    openCsv: vi.fn(() => Promise.resolve(opened)),
    openDroppedFile: vi.fn((_file: { name: string }) => Promise.resolve(opened)),
    requestEnginePort: vi.fn(),
    setTheme: vi.fn(),
    onMenuCommand: vi.fn((listener: (command: MenuCommand) => void) => {
      menuListeners.add(listener);
      return () => menuListeners.delete(listener);
    }),
    clipboard: { writeText: vi.fn((_text: string) => Promise.resolve()) },
  } satisfies GlassgridBridge;
  const target = new EventTarget();
  const engine = {} as EngineClientLike;
  const platform = createDesktopPlatform(bridge, engine, target);
  return { bridge, target, engine, platform, menuListeners };
}

describe('desktop platform', () => {
  it('names the OS and reserves the traffic-light inset on macOS only', () => {
    expect(['darwin', 'win32', 'linux', 'freebsd'].map(platformName)).toEqual(['mac', 'win', 'linux', 'linux']);
    const mac = setup('darwin').platform;
    expect([mac.name, mac.window.titleBarInset, mac.window.shortcuts]).toEqual(['mac', true, 'mac']);
    const win = setup('win32').platform;
    expect([win.name, win.window.titleBarInset, win.window.shortcuts]).toEqual(['win', false, 'pc']);
  });

  it('opens files through main: the dialog, and dropped Files handed to the preload unchanged', async () => {
    const { bridge, platform } = setup();
    expect(await platform.files.pickCsv()).toBe(opened);
    expect(bridge.openCsv).toHaveBeenCalledOnce();

    const file = new File(['a\n1\n'], 'trips.csv');
    const data = { files: [file] } as unknown as DataTransfer;
    const dropped = platform.files.fileFromDrop(data);
    expect(dropped).toBe(file);
    await platform.files.openDropped(file);
    expect(bridge.openDroppedFile).toHaveBeenCalledWith(file);
    expect(platform.files.fileFromDrop({ files: [] } as unknown as DataTransfer)).toBeNull();
    expect(platform.files.samples).toBeUndefined();
  });

  it('passes the engine, clipboard, theme and menu commands through', async () => {
    const { bridge, platform, engine, menuListeners } = setup();
    expect(platform.engine).toBe(engine);
    await platform.clipboard.writeText('a\tb');
    expect(bridge.clipboard.writeText).toHaveBeenCalledWith('a\tb');
    platform.window.syncTheme?.('dark');
    expect(bridge.setTheme).toHaveBeenCalledWith('dark');
    const listener = vi.fn();
    const off = platform.window.onMenuCommand?.(listener);
    menuListeners.forEach((deliver) => deliver({ kind: 'open' }));
    expect(listener).toHaveBeenCalledWith({ kind: 'open' });
    off?.();
    expect(menuListeners.size).toBe(0);
  });

  it('closes on pagehide, has no size limit and no workspace files yet', () => {
    const { platform, target } = setup();
    const listener = vi.fn();
    const off = platform.window.onBeforeClose(listener);
    target.dispatchEvent(new Event('pagehide'));
    expect(listener).toHaveBeenCalledOnce();
    off();
    target.dispatchEvent(new Event('pagehide'));
    expect(listener).toHaveBeenCalledOnce();
    expect(platform.capabilities).toEqual({ canSaveWorkspace: false, canOpenFromPath: true, maxFileBytes: null });
    expect(platform.workspaceFiles).toBeUndefined();
  });
});
