import { randomUUID } from 'node:crypto';
import { IpcChannel, type CloseAnswer, type CloseReply, type SaveWorkspaceResult } from '@glassgrid/core';

/*
 * "Save changes before closing?" Main asks the window's renderer whether it
 * has unsaved work (it owns the state), and if so shows the native
 * Save / Don't Save / Cancel dialog. Save writes the snapshot the renderer
 * sent with its answer (to its file, or through Save As). A renderer that
 * does not answer in time (hung, crashed) does not keep the window open:
 * it closes, and the autosaver's latest snapshot stays for recovery.
 */

/** The part of a BrowserWindow the guard uses. */
export interface GuardedWindow {
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
  close(): void;
  isDestroyed(): boolean;
  readonly webContents: { readonly id: number; send(channel: string, ...args: unknown[]): void };
}

export interface MessageBoxOptions {
  type: 'warning';
  buttons: string[];
  defaultId: number;
  cancelId: number;
  message: string;
  detail: string;
  noLink: true;
}

export interface CloseGuardDeps<W extends GuardedWindow> {
  showMessageBox(win: W, options: MessageBoxOptions): Promise<{ response: number }>;
  showErrorBox(title: string, content: string): void;
  /** Save the answer's snapshot (to its document, or Save As when it has none). */
  save(win: W, answer: Extract<CloseAnswer, { dirty: true }>): Promise<SaveWorkspaceResult>;
  /** The window closes: drop its recovery snapshot when `clean`, else flush and keep it. */
  closed(win: W, clean: boolean): Promise<void>;
  /** The display name to ask about ("trips.glassgrid", or "Untitled"). */
  displayName(win: W, answer: Extract<CloseAnswer, { dirty: true }>): string;
  /** Called after each decision: whether the window closed. The app uses it to resume or cancel quitting. */
  decided?(win: W, closed: boolean): void;
  readonly timeoutMs?: number;
}

export const SAVE_BUTTON = 0;
export const DONT_SAVE_BUTTON = 1;
export const CANCEL_BUTTON = 2;

export class CloseGuard<W extends GuardedWindow> {
  private readonly allowed = new WeakSet<W>();
  private readonly deciding = new WeakSet<W>();
  private readonly waiting = new Map<string, { contentsId: number; resolve: (answer: CloseAnswer | null | 'timeout') => void }>();

  constructor(private readonly deps: CloseGuardDeps<W>) {}

  attach(win: W): void {
    win.on('close', (event) => {
      if (this.allowed.has(win)) return;
      event.preventDefault();
      if (this.deciding.has(win)) return;
      this.deciding.add(win);
      void this.decide(win).finally(() => this.deciding.delete(win));
    });
  }

  /** A reply on `workspaceCloseReply`, from the webContents `senderId`. Replies from any other window are ignored. */
  reply(senderId: number, reply: CloseReply): void {
    const waiting = this.waiting.get(reply.requestId);
    if (waiting?.contentsId !== senderId) return;
    this.waiting.delete(reply.requestId);
    waiting.resolve(reply.answer);
  }

  private ask(win: W): Promise<CloseAnswer | null | 'timeout'> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        resolve('timeout');
      }, this.deps.timeoutMs ?? 3_000);
      this.waiting.set(requestId, {
        contentsId: win.webContents.id,
        resolve: (answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
      });
      try {
        win.webContents.send(IpcChannel.workspaceCloseQuery, requestId);
      } catch {
        this.waiting.delete(requestId);
        clearTimeout(timer);
        resolve('timeout');
      }
    });
  }

  private async decide(win: W): Promise<void> {
    const answer = await this.ask(win);
    if (win.isDestroyed()) return;
    if (answer === 'timeout' || answer === null) return this.finish(win, false);
    if (!answer.dirty) return this.finish(win, true);

    const { response } = await this.deps.showMessageBox(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: SAVE_BUTTON,
      cancelId: CANCEL_BUTTON,
      message: `Do you want to save the changes you made to ${this.deps.displayName(win, answer)}?`,
      detail: "Your changes will be lost if you don't save them.",
      noLink: true,
    });
    if (win.isDestroyed()) return;
    if (response === DONT_SAVE_BUTTON) return this.finish(win, true);
    if (response !== SAVE_BUTTON) {
      this.keepOpen(win);
      return;
    }

    const saved = await this.deps.save(win, answer);
    if (saved.status === 'saved') return this.finish(win, true);
    if (saved.status === 'failed') this.deps.showErrorBox('The workspace was not saved', saved.message);
    this.keepOpen(win);
  }

  private async finish(win: W, clean: boolean): Promise<void> {
    await this.deps.closed(win, clean);
    if (win.isDestroyed()) return;
    this.allowed.add(win);
    this.deps.decided?.(win, true);
    win.close();
  }

  private keepOpen(win: W): void {
    this.deps.decided?.(win, false);
  }
}
