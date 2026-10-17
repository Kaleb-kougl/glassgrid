import type { OpenCsvResult } from './bridge.js';

/*
 * Renderer <-> main contract exposed through the preload bridge. Kept tiny on
 * purpose: everything data-related goes over the engine port instead.
 *
 * This module is deliberately free of runtime dependencies (no zod) so the
 * sandboxed preload bundle stays small.
 */

export const IpcChannel = {
  /** invoke: show the open dialog, register the file, resolve an OpenedFile. */
  openCsv: 'glassgrid:open-csv',
  /** send: ask main for a fresh MessagePort connected to the engine. */
  requestEnginePort: 'glassgrid:request-engine-port',
  /** main -> preload: carries the renderer end of the engine port. */
  enginePort: 'glassgrid:engine-port',
} as const;

/** `window.postMessage` tag the preload uses to hand the port to the page. */
export const ENGINE_PORT_WINDOW_MESSAGE = 'glassgrid:engine-port';

/** Shape of `window.glassgrid`, implemented by the desktop preload. */
export interface GlassgridBridge {
  readonly platform: string;
  openCsv(): Promise<OpenCsvResult>;
  requestEnginePort(): void;
}
