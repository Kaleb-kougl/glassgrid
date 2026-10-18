import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import {
  CloseReplySchema,
  DocumentStateSchema,
  IpcChannel,
  OpenTokenSchema,
  OpenWorkspaceRequestSchema,
  RecoveryIdSchema,
  RecoveryUpdateSchema,
  SaveWorkspaceRequestSchema,
  WORKSPACE_FILE_EXTENSION,
  type ExternalOpenRequest,
  type OpenWorkspaceResult,
} from '@glassgrid/core';
import type { z } from 'zod';
import type { CloseGuard, GuardedWindow } from './close-guard';
import type { OpenRequestQueue } from './external-open';
import type { WindowRef, WorkspaceService } from './workspace-service';

/*
 * The workspace-file IPC channels. Every handler first checks the sender
 * (the app's own top-level frame, like the existing channels), then parses
 * its arguments with the core schemas; a request that fails either is
 * rejected before the service sees it.
 */

/** What a handler receives as its event (structurally Electron's IpcMainInvokeEvent / IpcMainEvent). */
export interface IpcEventLike {
  readonly sender: { readonly id: number };
  readonly senderFrame: { readonly url: string; readonly parent: unknown } | null;
}

/** The part of Electron's `ipcMain` used here (method syntax, so Electron's own event types fit). */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void): void;
}

export interface WorkspaceIpcDeps<Owner> {
  readonly ipcMain: IpcMainLike;
  readonly service: WorkspaceService<Owner>;
  readonly closeGuard: Pick<CloseGuard<GuardedWindow>, 'reply'>;
  readonly openRequests: Pick<OpenRequestQueue, 'listen'>;
  /** Throws for anything but the app's own top-level renderer frame (security.ts). */
  readonly assertTrustedSender: (event: IpcEventLike) => void;
  /** The window that sent the event, for dialogs and per-window state. */
  readonly windowOf: (event: IpcEventLike) => WindowRef<Owner>;
  /** Sends a pushed open request to the window with this webContents id. */
  readonly sendOpenRequest: (key: number, request: ExternalOpenRequest) => void;
  /**
   * The window's document and unsaved state, for native chrome (macOS
   * represented file and edited dot). `path` is the workspace file main
   * knows for the document id, or null (untitled, or an id it never issued).
   */
  readonly setDocumentState?: (win: WindowRef<Owner>, state: { path: string | null; edited: boolean }) => void;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid ${what}`);
  return parsed.data;
}

export function registerWorkspaceIpc<Owner>(deps: WorkspaceIpcDeps<Owner>): void {
  const { ipcMain, service } = deps;

  /** `ipcMain.handle` with the sender check first; the listener sees a checked event. */
  const handle = (channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      deps.assertTrustedSender(event);
      return listener(event, ...args);
    });
  };
  const on = (channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void) => {
    ipcMain.on(channel, (event, ...args) => {
      deps.assertTrustedSender(event);
      listener(event, ...args);
    });
  };

  handle(IpcChannel.workspaceSave, (event, request) =>
    service.save(deps.windowOf(event), parse(SaveWorkspaceRequestSchema, request, 'save request')),
  );
  handle(IpcChannel.workspaceSaveAs, (event, request) =>
    service.saveAs(deps.windowOf(event), parse(SaveWorkspaceRequestSchema, request, 'save request')),
  );
  handle(IpcChannel.workspaceOpen, (event, request) =>
    service.open(deps.windowOf(event), parse(OpenWorkspaceRequestSchema, request, 'open request')),
  );
  handle(IpcChannel.workspaceOpenDropped, async (_event, path): Promise<OpenWorkspaceResult> => {
    // Sent by the preload from webUtils.getPathForFile; still checked here.
    if (typeof path !== 'string' || !isAbsolute(path)) return { status: 'failed', code: 'io', message: 'Only files on this computer can be opened' };
    if (!path.toLowerCase().endsWith(`.${WORKSPACE_FILE_EXTENSION}`)) {
      return { status: 'failed', code: 'not_a_workspace', message: `${basename(path)} is not a Glassgrid workspace (.${WORKSPACE_FILE_EXTENSION})` };
    }
    const isFile = await stat(path).then((info) => info.isFile(), () => false);
    if (!isFile) return { status: 'failed', code: 'io', message: `${basename(path)} is not a file` };
    return service.openPath(path);
  });
  handle(IpcChannel.workspaceLocateData, (event, token) => service.locateData(deps.windowOf(event), parse(OpenTokenSchema, token, 'token')));
  handle(IpcChannel.workspaceCancelOpen, (_event, token) => {
    service.cancelOpen(parse(OpenTokenSchema, token, 'token'));
  });
  handle(IpcChannel.workspaceListRecent, () => service.listRecent());
  handle(IpcChannel.workspaceListRecovery, () => service.listRecovery());
  handle(IpcChannel.workspaceRestoreRecovery, (event, id) => service.restoreRecovery(deps.windowOf(event), parse(RecoveryIdSchema, id, 'recovery id')));
  handle(IpcChannel.workspaceDiscardRecovery, (_event, id) => service.discardRecovery(parse(RecoveryIdSchema, id, 'recovery id')));
  handle(IpcChannel.workspaceOpenRequestsListen, (event) => {
    const key = deps.windowOf(event).key;
    return deps.openRequests.listen({ key, send: (request) => deps.sendOpenRequest(key, request) });
  });

  on(IpcChannel.workspaceRecoveryUpdate, (event, update) => {
    // Fire-and-forget channel: a malformed update is dropped, not thrown back.
    const parsed = update === null ? { success: true as const, data: null } : RecoveryUpdateSchema.safeParse(update);
    if (parsed.success) service.updateRecovery(deps.windowOf(event), parsed.data);
    else console.warn('[workspace-ipc] dropped a malformed recovery update');
  });
  on(IpcChannel.workspaceDocumentState, (event, state) => {
    const parsed = DocumentStateSchema.safeParse(state);
    if (!parsed.success) return;
    deps.setDocumentState?.(deps.windowOf(event), { path: service.documentPath(parsed.data.documentId) ?? null, edited: parsed.data.edited });
  });
  on(IpcChannel.workspaceCloseReply, (event, reply) => {
    const parsed = CloseReplySchema.safeParse(reply);
    if (parsed.success) deps.closeGuard.reply(event.sender.id, parsed.data);
  });
}
