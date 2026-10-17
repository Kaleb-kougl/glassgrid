import type { GlassgridBridge } from '@glassgrid/core';

declare global {
  interface Window {
    /** Exposed by the preload script via contextBridge. */
    readonly glassgrid: GlassgridBridge;
  }
}

export {};
