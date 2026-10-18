import { createElement, Profiler, type ReactNode } from 'react';
import type { WorkspaceStore } from '@glassgrid/core';
import { setChartPerfHook } from '@glassgrid/ui';
import { installRecorder, onProfilerCommit, onProfilerRender, renderPerf } from './render-perf-core';

/*
 * The React side of the render-perf instrumentation (render-perf-core.ts):
 * `<Profiler>` regions and the charts' draw-timing hook. Only reached behind
 * `if (__GG_RENDER_PERF__)`.
 */

export { renderPerf };

/**
 * Wraps `node` in a `<Profiler id>` region (render-perf builds); returns it
 * unchanged otherwise. In a list, pass the item's `key` (the Profiler takes it).
 */
export function perfRegion(id: string, node: ReactNode, key?: string): ReactNode {
  if (!__GG_RENDER_PERF__) return node;
  return createElement(Profiler, { id, onRender: onProfilerRender, onCommit: onProfilerCommit, ...(key === undefined ? {} : { key }) } as Parameters<typeof Profiler>[0], node);
}

/** Installs the recorder (main.tsx, before the first render). */
export function installRenderPerf(store: WorkspaceStore): void {
  installRecorder(store);
  setChartPerfHook((event, chart, ms) => {
    renderPerf.event(event, { name: chart, ms });
  });
}
