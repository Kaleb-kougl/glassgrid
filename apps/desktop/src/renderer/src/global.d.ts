import type { GlassgridBridge } from '@glassgrid/core';

declare global {
  /**
   * Build-time flag (electron.vite.config.ts `define`): true only in
   * `GLASSGRID_RENDER_PERF=1` builds, which compile in render-perf.ts.
   */
  const __GG_RENDER_PERF__: boolean;

  interface Window {
    /** Exposed by the preload script via contextBridge. */
    readonly glassgrid: GlassgridBridge;
  }
}

export {};
