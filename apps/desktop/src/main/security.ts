import { app, session, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';

/**
 * Process-wide hardening. Every WebContents (including any created later)
 * is barred from navigating away, opening windows or attaching webviews,
 * and the app grants no web permissions (camera, notifications, ...).
 */
export function installSecurityPolicies(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

/**
 * IPC handlers only answer the app's own top-level renderer frame, so a
 * compromised or injected sub-frame cannot open dialogs or grab engine ports.
 */
export function createSenderGuard(isTrustedUrl: (url: string) => boolean) {
  return function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null || !isTrustedUrl(frame.url)) {
      throw new Error(`Rejected IPC from untrusted sender: ${frame?.url ?? '<detached frame>'}`);
    }
  };
}
