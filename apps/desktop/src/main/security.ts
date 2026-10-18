import { app, session } from 'electron';

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

export { createSenderGuard, type SenderEvent } from './sender-guard';
