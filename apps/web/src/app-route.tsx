import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@glassgrid/app/app.css';
import { App, applyInitialTheme, createAppWorkspace, installRenderPerf, perfRegion } from '@glassgrid/app';
import './app-route.css';
import { createStubEngine } from './stub-engine/stub-engine';
import { createWebPlatform } from './web-platform';

/**
 * `/`: the shared app on the web platform. The engine is the TEMPORARY stub
 * (fixed sample rows); M4 integration replaces `createStubEngine()` with the
 * DuckDB-WASM worker client and drops the badge.
 */
export function mountApp(root: HTMLElement): void {
  // Theme before the first paint (prefers-color-scheme, or the stored override).
  applyInitialTheme();
  const platform = createWebPlatform(createStubEngine());
  const workspace = createAppWorkspace();
  if (__GG_RENDER_PERF__) installRenderPerf(workspace.store);
  createRoot(root).render(
    <StrictMode>
      {perfRegion('App', <App platform={platform} workspace={workspace} />)}
      <aside className="stub-badge" aria-label="Preview build" data-testid="stub-badge">
        Preview: stub engine with fixed sample rows, not your file’s
      </aside>
    </StrictMode>,
  );
}
