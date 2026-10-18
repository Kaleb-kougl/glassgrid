/** The part of an IPC event the sender check reads (structurally Electron's IpcMainInvokeEvent / IpcMainEvent). */
export interface SenderEvent {
  readonly senderFrame: { readonly url: string; readonly parent: unknown } | null;
}

/**
 * IPC handlers only answer the app's own top-level renderer frame, so a
 * compromised or injected sub-frame cannot open dialogs or grab engine ports.
 * Electron-free so it can be unit-tested.
 */
export function createSenderGuard(isTrustedUrl: (url: string) => boolean) {
  return function assertTrustedSender(event: SenderEvent): void {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null || !isTrustedUrl(frame.url)) {
      throw new Error(`Rejected IPC from untrusted sender: ${frame?.url ?? '<detached frame>'}`);
    }
  };
}
