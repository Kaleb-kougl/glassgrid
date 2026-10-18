import { describe, expect, it, vi } from 'vitest';
import {
  toFileHandle,
  type CloseAnswer,
  type DocumentState,
  type DroppedFile,
  type ExternalOpenRequest,
  type GlassgridBridge,
  type MenuCommand,
  type OpenCsvResult,
  type OpenWorkspaceRequest,
  type OpenWorkspaceResult,
  type RecentWorkspace,
  type RecoverySnapshotInfo,
  type RecoveryUpdate,
  type SaveWorkspaceRequest,
  type SaveWorkspaceResult,
  type WorkspaceBridge,
  type WorkspaceMenuCommand,
} from '@glassgrid/core';
import type { AppMenuCommand, EngineClientLike } from '@glassgrid/app';
import { createDesktopPlatform, platformName, windowTitle } from './desktop-platform';

const opened: OpenCsvResult = { status: 'opened', file: { handle: toFileHandle('0b6c8f0e-6d0a-4f43-9d3e-2f1f1a0d9c11'), displayName: 'trips.csv', sizeBytes: 10 } };
const saved: SaveWorkspaceResult = { status: 'saved', documentId: 'doc_12345678', workspaceFile: { fileName: 'trips.glassgrid', directory: '/work' } };
const needsData: OpenWorkspaceResult = { status: 'needsData', token: 'ot_12345678', workspaceFile: null, dataFileName: 'trips.csv', warnings: [] };
const recent: RecentWorkspace[] = [{ id: `rw_${'a'.repeat(24)}`, fileName: 'trips.glassgrid', directory: '/work', lastOpenedAt: '2026-10-18T09:00:00.000Z' }];
const recovery: RecoverySnapshotInfo[] = [{ id: 'rs_12345678', workspaceFile: null, dataFileName: 'trips.csv', savedAt: '2026-10-18T09:00:00.000Z' }];

/** The preload's `window.glassgrid.workspace`, with the events it pushes driven by the test. */
function fakeWorkspaceBridge() {
  const openListeners = new Set<(request: ExternalOpenRequest) => void>();
  const menuListeners = new Set<(command: WorkspaceMenuCommand) => void>();
  let closeHandler: (() => CloseAnswer | Promise<CloseAnswer>) | null = null;
  const workspace = {
    save: vi.fn((_request: SaveWorkspaceRequest) => Promise.resolve(saved)),
    saveAs: vi.fn((_request: SaveWorkspaceRequest) => Promise.resolve(saved)),
    open: vi.fn((_request: OpenWorkspaceRequest) => Promise.resolve(needsData)),
    openDropped: vi.fn((_file: DroppedFile) => Promise.resolve(needsData)),
    locateData: vi.fn((_token: string): Promise<OpenWorkspaceResult> => Promise.resolve({ status: 'cancelled' })),
    cancelOpen: vi.fn((_token: string) => Promise.resolve()),
    listRecent: vi.fn(() => Promise.resolve(recent)),
    listRecovery: vi.fn(() => Promise.resolve(recovery)),
    restoreRecovery: vi.fn((_id: string) => Promise.resolve(needsData)),
    discardRecovery: vi.fn((_id: string) => Promise.resolve()),
    updateRecovery: vi.fn((_update: RecoveryUpdate | null) => undefined),
    onOpenRequest: vi.fn((listener: (request: ExternalOpenRequest) => void) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    }),
    onCloseRequest: vi.fn((handler: () => CloseAnswer | Promise<CloseAnswer>) => {
      closeHandler = handler;
      return () => {
        if (closeHandler === handler) closeHandler = null;
      };
    }),
    onMenuCommand: vi.fn((listener: (command: WorkspaceMenuCommand) => void) => {
      menuListeners.add(listener);
      return () => menuListeners.delete(listener);
    }),
    setDocumentState: vi.fn((_state: DocumentState) => undefined),
  } satisfies WorkspaceBridge;
  return {
    workspace,
    openListeners,
    menuListeners,
    askClose: () => (closeHandler ? closeHandler() : null),
  };
}

function setup(nodePlatform = 'darwin') {
  const menuListeners = new Set<(command: MenuCommand) => void>();
  const ws = fakeWorkspaceBridge();
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
    workspace: ws.workspace,
  } satisfies GlassgridBridge;
  const events = new EventTarget();
  const target = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    document: { title: 'Glassgrid' },
  };
  const engine = {} as EngineClientLike;
  const platform = createDesktopPlatform(bridge, engine, target);
  return { bridge, ws, events, target, engine, platform, menuListeners };
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

  it('passes the engine, clipboard and theme through', async () => {
    const { bridge, platform, engine } = setup();
    expect(platform.engine).toBe(engine);
    await platform.clipboard.writeText('a\tb');
    expect(bridge.clipboard.writeText).toHaveBeenCalledWith('a\tb');
    platform.window.syncTheme?.('dark');
    expect(bridge.setTheme).toHaveBeenCalledWith('dark');
  });

  it('delivers both menu channels as one stream, and leaves the file shortcuts to the menu', () => {
    const { platform, menuListeners, ws } = setup();
    expect(platform.window.menuShortcuts).toBe(true);
    const received: AppMenuCommand[] = [];
    const off = platform.window.onMenuCommand?.((command) => received.push(command));
    menuListeners.forEach((deliver) => deliver({ kind: 'open' }));
    ws.menuListeners.forEach((deliver) => deliver({ kind: 'saveWorkspace' }));
    ws.menuListeners.forEach((deliver) => deliver({ kind: 'openRecentWorkspace', id: `rw_${'b'.repeat(24)}` }));
    expect(received).toEqual([{ kind: 'open' }, { kind: 'saveWorkspace' }, { kind: 'openRecentWorkspace', id: `rw_${'b'.repeat(24)}` }]);
    off?.();
    expect(menuListeners.size).toBe(0);
    expect(ws.menuListeners.size).toBe(0);
  });

  it('closes on pagehide, has no size limit and saves workspaces', () => {
    const { platform, events } = setup();
    const listener = vi.fn();
    const off = platform.window.onBeforeClose(listener);
    events.dispatchEvent(new Event('pagehide'));
    expect(listener).toHaveBeenCalledOnce();
    off();
    events.dispatchEvent(new Event('pagehide'));
    expect(listener).toHaveBeenCalledOnce();
    expect(platform.capabilities).toEqual({ canSaveWorkspace: true, canOpenFromPath: true, maxFileBytes: null });
  });

  it('workspace files go to main through the preload bridge', async () => {
    const { platform, ws } = setup();
    const api = platform.workspaceFiles;
    if (!api) throw new Error('expected workspace files');
    const snapshot = {} as SaveWorkspaceRequest['snapshot'];
    expect(await api.save({ documentId: null, snapshot })).toBe(saved);
    expect(await api.saveAs({ documentId: 'doc_12345678', snapshot })).toBe(saved);
    expect(ws.workspace.saveAs).toHaveBeenCalledWith({ documentId: 'doc_12345678', snapshot });
    expect(await api.open({ source: 'dialog' })).toBe(needsData);
    const file = new File(['{}'], 'a.glassgrid');
    await api.openDropped(file);
    expect(ws.workspace.openDropped).toHaveBeenCalledWith(file);
    await api.locateData('ot_12345678');
    await api.cancelOpen('ot_12345678');
    expect(ws.workspace.cancelOpen).toHaveBeenCalledWith('ot_12345678');
    expect(await api.listRecent()).toBe(recent);
    expect(await api.listRecovery()).toBe(recovery);
    await api.restoreRecovery('rs_12345678');
    await api.discardRecovery('rs_12345678');
    expect(ws.workspace.discardRecovery).toHaveBeenCalledWith('rs_12345678');
    api.updateRecovery(null);
    expect(ws.workspace.updateRecovery).toHaveBeenCalledWith(null);

    const requests: ExternalOpenRequest[] = [];
    const off = api.onOpenRequest((request) => requests.push(request));
    ws.openListeners.forEach((deliver) => deliver({ token: 'ot_abcdefgh', fileName: 'b.glassgrid' }));
    off();
    expect(requests).toEqual([{ token: 'ot_abcdefgh', fileName: 'b.glassgrid' }]);
    expect(ws.openListeners.size).toBe(0);
  });

  it('answers main\'s close query with the app\'s handler', async () => {
    const { platform, ws } = setup();
    expect(ws.askClose()).toBeNull();
    const off = platform.window.onCloseRequest?.(() => ({ dirty: false }));
    expect(await ws.askClose()).toEqual({ dirty: false });
    off?.();
    expect(ws.askClose()).toBeNull();
  });

  it('shows the document in the window title and tells main (once per change) for macOS chrome', () => {
    const { platform, target, ws } = setup('linux');
    platform.window.setDocumentChrome?.({ title: 'trips.glassgrid', edited: true, documentId: 'doc_12345678' });
    expect(target.document.title).toBe('● trips.glassgrid — Glassgrid');
    platform.window.setDocumentChrome?.({ title: 'trips.glassgrid', edited: true, documentId: 'doc_12345678' });
    platform.window.setDocumentChrome?.({ title: null, edited: false, documentId: null });
    expect(target.document.title).toBe('Glassgrid');
    expect(ws.workspace.setDocumentState.mock.calls).toEqual([[{ documentId: 'doc_12345678', edited: true }], [{ documentId: null, edited: false }]]);
    // macOS shows the edited state in the close button, not the title.
    expect(windowTitle({ title: 'trips.csv', edited: true, documentId: null }, 'mac')).toBe('trips.csv — Glassgrid');
  });
});
