import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel, toFileHandle, type CloseReply, type WorkspaceSnapshot } from '@glassgrid/core';
import { createSenderGuard } from '../sender-guard';
import { registerWorkspaceIpc, type IpcEventLike } from './ipc';
import type { WorkspaceService } from './workspace-service';

const ORIGIN = 'file:///app/renderer/index.html';

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown;

function fakeIpcMain() {
  const handlers = new Map<string, Listener>();
  const listeners = new Map<string, Listener>();
  return {
    handlers,
    listeners,
    handle: (channel: string, listener: Listener) => handlers.set(channel, listener),
    on: (channel: string, listener: Listener) => listeners.set(channel, listener),
  };
}

const trusted = (id = 7): IpcEventLike => ({ sender: { id }, senderFrame: { url: ORIGIN, parent: null } });
const subframe: IpcEventLike = { sender: { id: 7 }, senderFrame: { url: ORIGIN, parent: {} } };
const foreign: IpcEventLike = { sender: { id: 7 }, senderFrame: { url: 'https://evil.example/', parent: null } };
const detached: IpcEventLike = { sender: { id: 7 }, senderFrame: null };

const snapshot: WorkspaceSnapshot = {
  dataSource: {
    handleId: toFileHandle('00000000-0000-0000-0000-000000000001'),
    fileName: 'trips.csv',
    fingerprint: { sizeBytes: 1, mtimeMs: 1, headTailSha256: 'a'.repeat(64), key: 'b'.repeat(32) },
  },
  workspace: { columns: [], charts: [], selections: {}, userFilters: [], grid: { sort: [], columnOrder: [], columnWidths: [] }, layout: { cards: [] } },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gg-ipc-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup() {
  const ipcMain = fakeIpcMain();
  const service = {
    save: vi.fn(() => Promise.resolve({ status: 'cancelled' })),
    saveAs: vi.fn(() => Promise.resolve({ status: 'cancelled' })),
    open: vi.fn(() => Promise.resolve({ status: 'cancelled' })),
    openPath: vi.fn(() => Promise.resolve({ status: 'cancelled' })),
    locateData: vi.fn(() => Promise.resolve({ status: 'cancelled' })),
    cancelOpen: vi.fn(),
    listRecent: vi.fn(() => Promise.resolve([])),
    listRecovery: vi.fn(() => Promise.resolve([])),
    restoreRecovery: vi.fn(() => Promise.resolve({ status: 'cancelled' })),
    discardRecovery: vi.fn(() => Promise.resolve()),
    updateRecovery: vi.fn(),
    documentPath: vi.fn((id: string | null) => (id === 'doc_12345678' ? '/work/trips.glassgrid' : undefined)),
  };
  const closeGuard = { reply: vi.fn() };
  const openRequests = { listen: vi.fn(() => [{ token: 'ot_12345678', fileName: 'a.glassgrid' }]) };
  const sendOpenRequest = vi.fn();
  const setDocumentState = vi.fn();
  registerWorkspaceIpc<null>({
    ipcMain,
    service: service as unknown as WorkspaceService<null>,
    closeGuard,
    openRequests,
    assertTrustedSender: createSenderGuard((url) => url.startsWith(ORIGIN)),
    windowOf: (event) => ({ key: event.sender.id, owner: null }),
    sendOpenRequest,
    setDocumentState,
  });
  const invoke = (channel: string, event: IpcEventLike, ...args: unknown[]) => {
    const handler = ipcMain.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return Promise.resolve().then(() => handler(event, ...args));
  };
  const send = (channel: string, event: IpcEventLike, ...args: unknown[]) => {
    const listener = ipcMain.listeners.get(channel);
    if (!listener) throw new Error(`no listener for ${channel}`);
    listener(event, ...args);
  };
  return { ipcMain, service, closeGuard, openRequests, sendOpenRequest, setDocumentState, invoke, send };
}

const HANDLED = [
  IpcChannel.workspaceSave,
  IpcChannel.workspaceSaveAs,
  IpcChannel.workspaceOpen,
  IpcChannel.workspaceOpenDropped,
  IpcChannel.workspaceLocateData,
  IpcChannel.workspaceCancelOpen,
  IpcChannel.workspaceListRecent,
  IpcChannel.workspaceListRecovery,
  IpcChannel.workspaceRestoreRecovery,
  IpcChannel.workspaceDiscardRecovery,
  IpcChannel.workspaceOpenRequestsListen,
];
const SENT = [IpcChannel.workspaceRecoveryUpdate, IpcChannel.workspaceCloseReply, IpcChannel.workspaceDocumentState];

describe('workspace IPC', () => {
  it('registers every workspace channel', () => {
    const { ipcMain } = setup();
    expect([...ipcMain.handlers.keys()].sort()).toEqual([...HANDLED].sort());
    expect([...ipcMain.listeners.keys()].sort()).toEqual([...SENT].sort());
  });

  it.each(HANDLED)('%s refuses sub-frames, other origins and detached frames before doing anything', async (channel) => {
    const { invoke, service, openRequests } = setup();
    for (const event of [subframe, foreign, detached]) {
      await expect(invoke(channel, event, { documentId: null, snapshot })).rejects.toThrow(/untrusted sender/);
    }
    for (const fn of [...Object.values(service), openRequests.listen]) expect(fn).not.toHaveBeenCalled();
  });

  it.each(SENT)('%s ignores untrusted senders', (channel) => {
    const { send, service, closeGuard, setDocumentState } = setup();
    for (const event of [subframe, foreign, detached]) expect(() => send(channel, event, null)).toThrow(/untrusted sender/);
    expect(service.updateRecovery).not.toHaveBeenCalled();
    expect(closeGuard.reply).not.toHaveBeenCalled();
    expect(setDocumentState).not.toHaveBeenCalled();
  });

  it('validates requests with the core schemas', async () => {
    const { invoke, service } = setup();
    await expect(invoke(IpcChannel.workspaceSave, trusted(), { documentId: null })).rejects.toThrow('Invalid save request');
    await expect(invoke(IpcChannel.workspaceSave, trusted(), { documentId: '/etc/passwd', snapshot })).rejects.toThrow('Invalid save request');
    await expect(invoke(IpcChannel.workspaceOpen, trusted(), { source: 'path', path: '/etc/passwd' })).rejects.toThrow('Invalid open request');
    await expect(invoke(IpcChannel.workspaceLocateData, trusted(), '../x')).rejects.toThrow('Invalid token');
    await expect(invoke(IpcChannel.workspaceRestoreRecovery, trusted(), '../../state')).rejects.toThrow('Invalid recovery id');
    expect(service.save).not.toHaveBeenCalled();
    expect(service.open).not.toHaveBeenCalled();

    await invoke(IpcChannel.workspaceSave, trusted(3), { documentId: 'doc_12345678', snapshot });
    expect(service.save).toHaveBeenCalledWith({ key: 3, owner: null }, { documentId: 'doc_12345678', snapshot });
    await invoke(IpcChannel.workspaceOpen, trusted(), { source: 'recent', id: `rw_${'c'.repeat(24)}` });
    expect(service.open).toHaveBeenCalledWith({ key: 7, owner: null }, { source: 'recent', id: `rw_${'c'.repeat(24)}` });
    await invoke(IpcChannel.workspaceCancelOpen, trusted(), 'ot_12345678');
    expect(service.cancelOpen).toHaveBeenCalledWith('ot_12345678');
  });

  it('opens dropped files only when they are local .glassgrid files', async () => {
    const { invoke, service } = setup();
    expect(await invoke(IpcChannel.workspaceOpenDropped, trusted(), 'relative.glassgrid')).toMatchObject({ status: 'failed', code: 'io' });
    expect(await invoke(IpcChannel.workspaceOpenDropped, trusted(), join(dir, 'data.csv'))).toMatchObject({ status: 'failed', code: 'not_a_workspace' });
    expect(await invoke(IpcChannel.workspaceOpenDropped, trusted(), join(dir, 'missing.glassgrid'))).toMatchObject({ status: 'failed', code: 'io' });
    expect(service.openPath).not.toHaveBeenCalled();
    await writeFile(join(dir, 'a.glassgrid'), '{}');
    await invoke(IpcChannel.workspaceOpenDropped, trusted(), join(dir, 'a.glassgrid'));
    expect(service.openPath).toHaveBeenCalledWith(join(dir, 'a.glassgrid'));
  });

  it('forwards recovery updates and close replies from the sending window, dropping malformed ones', () => {
    const { send, service, closeGuard } = setup();
    send(IpcChannel.workspaceRecoveryUpdate, trusted(4), { documentId: null, snapshot });
    send(IpcChannel.workspaceRecoveryUpdate, trusted(4), null);
    send(IpcChannel.workspaceRecoveryUpdate, trusted(4), { snapshot: 'nope' });
    expect(service.updateRecovery.mock.calls).toEqual([
      [{ key: 4, owner: null }, { documentId: null, snapshot }],
      [{ key: 4, owner: null }, null],
    ]);
    const reply: CloseReply = { requestId: 'r1', answer: { dirty: false } };
    send(IpcChannel.workspaceCloseReply, trusted(4), reply);
    send(IpcChannel.workspaceCloseReply, trusted(4), { requestId: 'r2', answer: { dirty: true } });
    expect(closeGuard.reply.mock.calls).toEqual([[4, reply]]);
  });

  it('resolves the document id of a window\'s document state to its path in main, dropping malformed ones', () => {
    const { send, setDocumentState } = setup();
    send(IpcChannel.workspaceDocumentState, trusted(5), { documentId: 'doc_12345678', edited: true });
    send(IpcChannel.workspaceDocumentState, trusted(5), { documentId: null, edited: false });
    send(IpcChannel.workspaceDocumentState, trusted(5), { documentId: 'doc_unknown-1', edited: false });
    send(IpcChannel.workspaceDocumentState, trusted(5), { documentId: '/etc/passwd', edited: true });
    send(IpcChannel.workspaceDocumentState, trusted(5), { edited: 'yes' });
    expect(setDocumentState.mock.calls).toEqual([
      [{ key: 5, owner: null }, { path: '/work/trips.glassgrid', edited: true }],
      [{ key: 5, owner: null }, { path: null, edited: false }],
      [{ key: 5, owner: null }, { path: null, edited: false }],
    ]);
  });

  it('a listening window gets the queued OS open requests, and later ones pushed to it', async () => {
    const { invoke, openRequests, sendOpenRequest } = setup();
    expect(await invoke(IpcChannel.workspaceOpenRequestsListen, trusted(9))).toEqual([{ token: 'ot_12345678', fileName: 'a.glassgrid' }]);
    const [[target]] = openRequests.listen.mock.calls as unknown as [[{ key: number; send: (request: unknown) => void }]];
    expect(target.key).toBe(9);
    target.send({ token: 'ot_abcdefgh', fileName: 'b.glassgrid' });
    expect(sendOpenRequest).toHaveBeenCalledWith(9, { token: 'ot_abcdefgh', fileName: 'b.glassgrid' });
  });
});
