import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel, toFileHandle, type CloseAnswer, type SaveWorkspaceResult } from '@glassgrid/core';
import { CANCEL_BUTTON, CloseGuard, DONT_SAVE_BUTTON, SAVE_BUTTON, type GuardedWindow } from './close-guard';

class FakeWindow extends EventEmitter implements GuardedWindow {
  destroyed = false;
  closed = false;
  readonly sent: unknown[][] = [];
  readonly webContents = { id: 5, send: (...args: unknown[]) => this.sent.push(args) };

  /** Like BrowserWindow.close(): emits 'close'; closes unless a listener prevented it. */
  close(): void {
    const event = { prevented: false, preventDefault: () => (event.prevented = true) };
    this.emit('close', event);
    if (!event.prevented) this.closed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  lastRequestId(): string {
    const last = this.sent.at(-1);
    expect(last?.[0]).toBe(IpcChannel.workspaceCloseQuery);
    return String(last?.[1]);
  }
}

const dirty: Extract<CloseAnswer, { dirty: true }> = {
  dirty: true,
  documentId: 'doc_12345678',
  snapshot: {
    dataSource: { handleId: toFileHandle('00000000-0000-0000-0000-000000000001'), fileName: 'trips.csv', fingerprint: { sizeBytes: 1, mtimeMs: 1, headTailSha256: 'a'.repeat(64), key: 'b'.repeat(32) } },
    workspace: { columns: [], charts: [], selections: {}, userFilters: [], grid: { sort: [], columnOrder: [], columnWidths: [] }, layout: { cards: [] } },
  },
};

function setup(options: { response?: number; save?: SaveWorkspaceResult; timeoutMs?: number } = {}) {
  const deps = {
    showMessageBox: vi.fn(() => Promise.resolve({ response: options.response ?? SAVE_BUTTON })),
    showErrorBox: vi.fn(),
    save: vi.fn(() => Promise.resolve(options.save ?? ({ status: 'saved', documentId: 'doc_12345678', workspaceFile: { fileName: 'a.glassgrid', directory: '/' } } as const))),
    closed: vi.fn(() => Promise.resolve()),
    displayName: () => 'trips.glassgrid',
    decided: vi.fn(),
    timeoutMs: options.timeoutMs ?? 1_000,
  };
  const guard = new CloseGuard<FakeWindow>(deps);
  const win = new FakeWindow();
  guard.attach(win);
  return { guard, win, deps };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CloseGuard', () => {
  it('asks the renderer and closes at once when nothing is unsaved', async () => {
    const { guard, win, deps } = setup();
    win.close();
    expect(win.closed).toBe(false);
    guard.reply(win.webContents.id, { requestId: win.lastRequestId(), answer: { dirty: false } });
    await vi.waitFor(() => expect(win.closed).toBe(true));
    expect(deps.showMessageBox).not.toHaveBeenCalled();
    expect(deps.closed).toHaveBeenCalledWith(win, true);
    expect(deps.decided).toHaveBeenCalledWith(win, true);
  });

  it('closes without asking when the renderer has no handler, keeping the recovery snapshot', async () => {
    const { guard, win, deps } = setup();
    win.close();
    guard.reply(5, { requestId: win.lastRequestId(), answer: null });
    await vi.waitFor(() => expect(win.closed).toBe(true));
    expect(deps.closed).toHaveBeenCalledWith(win, false);
  });

  it('Save writes the snapshot, then closes', async () => {
    const { guard, win, deps } = setup({ response: SAVE_BUTTON });
    win.close();
    guard.reply(5, { requestId: win.lastRequestId(), answer: dirty });
    await vi.waitFor(() => expect(win.closed).toBe(true));
    expect(deps.showMessageBox).toHaveBeenCalledWith(win, expect.objectContaining({
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: SAVE_BUTTON,
      cancelId: CANCEL_BUTTON,
      message: 'Do you want to save the changes you made to trips.glassgrid?',
    }));
    expect(deps.save).toHaveBeenCalledWith(win, dirty);
    expect(deps.closed).toHaveBeenCalledWith(win, true);
  });

  it("Don't Save closes and drops the recovery snapshot", async () => {
    const { guard, win, deps } = setup({ response: DONT_SAVE_BUTTON });
    win.close();
    guard.reply(5, { requestId: win.lastRequestId(), answer: dirty });
    await vi.waitFor(() => expect(win.closed).toBe(true));
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.closed).toHaveBeenCalledWith(win, true);
  });

  it('Cancel, a cancelled Save As or a failed save keep the window open (and stop a quit)', async () => {
    for (const [options, errorShown] of [
      [{ response: CANCEL_BUTTON }, false],
      [{ response: SAVE_BUTTON, save: { status: 'cancelled' } as const }, false],
      [{ response: SAVE_BUTTON, save: { status: 'failed', message: 'Disk full' } as const }, true],
    ] as const) {
      const { guard, win, deps } = setup(options);
      win.close();
      guard.reply(5, { requestId: win.lastRequestId(), answer: dirty });
      await vi.waitFor(() => expect(deps.decided).toHaveBeenCalledWith(win, false));
      expect(win.closed).toBe(false);
      expect(deps.closed).not.toHaveBeenCalled();
      expect(deps.showErrorBox).toHaveBeenCalledTimes(errorShown ? 1 : 0);
      // Asking again starts a new round.
      win.close();
      expect(win.sent).toHaveLength(2);
    }
  });

  it('a renderer that does not answer does not keep the window open', async () => {
    vi.useFakeTimers();
    const { win, deps } = setup({ timeoutMs: 3_000 });
    win.close();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(win.closed).toBe(true);
    expect(deps.closed).toHaveBeenCalledWith(win, false);
  });

  it('ignores replies from other windows and repeated close clicks while deciding', async () => {
    const { guard, win } = setup();
    win.close();
    win.close();
    expect(win.sent).toHaveLength(1);
    const requestId = win.lastRequestId();
    guard.reply(6, { requestId, answer: { dirty: false } });
    guard.reply(5, { requestId: 'someone-else', answer: { dirty: false } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(win.closed).toBe(false);
    guard.reply(5, { requestId, answer: { dirty: false } });
    await vi.waitFor(() => expect(win.closed).toBe(true));
  });
});
