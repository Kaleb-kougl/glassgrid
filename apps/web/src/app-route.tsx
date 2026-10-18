import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@glassgrid/app/app.css';
import { App, applyInitialTheme, createAppWorkspace, installRenderPerf, perfRegion } from '@glassgrid/app';
import { sampleFromSearch } from './samples';
import { createDuckdbWebEngine } from './web-engine';
import { createWebPlatform } from './web-platform';

/**
 * `/`: the shared app on the web platform, with DuckDB-WASM in a Web Worker
 * as its engine. `/?sample=<id>` opens that sample workspace at start
 * (shareable: opening a sample from the start screen puts its link in the
 * address bar, and opening any other file takes it out again).
 */
export function mountApp(root: HTMLElement): void {
  // Theme before the first paint (prefers-color-scheme, or the stored override).
  applyInitialTheme();
  const workspace = createAppWorkspace();
  if (__GG_RENDER_PERF__) installRenderPerf(workspace.store);

  let sampleHandle: string | null = null;
  const web = createDuckdbWebEngine({
    registry: workspace.registry,
    onSampleOpened: (sample) => {
      sampleHandle = workspace.store.getState().dataSource?.handleId ?? null;
      setSampleParam(sample.id);
    },
  });
  workspace.store.subscribe(() => {
    const handle = workspace.store.getState().dataSource?.handleId ?? null;
    if (sampleHandle !== null && handle !== sampleHandle) {
      sampleHandle = null;
      setSampleParam(null);
    }
  });
  const platform = createWebPlatform(web);
  const linked = sampleFromSearch(window.location.search);
  const initialOpen = linked ? () => platform.files.openSample?.(linked.id) ?? Promise.resolve({ status: 'cancelled' as const }) : undefined;

  createRoot(root).render(
    <StrictMode>{perfRegion('App', <App platform={platform} workspace={workspace} {...(initialOpen ? { initialOpen } : {})} />)}</StrictMode>,
  );
}

/** Keep `?sample=` in the address bar in step with what is open (no reload, no history entry). */
function setSampleParam(id: string | null): void {
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete('sample');
  else url.searchParams.set('sample', id);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
}
