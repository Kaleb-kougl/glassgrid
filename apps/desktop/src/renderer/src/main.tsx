// First: in render-perf builds this installs the commit inspector before react-dom loads (empty otherwise).
import './render-perf-core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@glassgrid/ui/fonts.css';
import '@glassgrid/ui/tokens.css';
import '@glassgrid/ui/styles.css';
import './app.css';
import { App } from './App';
import { EngineClient } from './engine-client';
import { installRenderPerf, perfRegion } from './render-perf';
import { readThemePreference, resolveTheme } from './theme';
import { createAppWorkspace } from './workspace';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

// Theme before the first paint, so the window never flashes the other theme.
let storage: Storage | undefined;
try {
  storage = window.localStorage;
} catch {
  storage = undefined;
}
document.documentElement.dataset['ggTheme'] = resolveTheme(
  readThemePreference(storage),
  window.matchMedia('(prefers-color-scheme: dark)').matches,
);

// One engine client and one workspace for the window's lifetime; created
// outside React so StrictMode's double-mounting in development does not churn
// engine ports or reset the undo history.
const engine = new EngineClient(window.glassgrid);
const workspace = createAppWorkspace();
if (__GG_RENDER_PERF__) installRenderPerf(workspace.store);

createRoot(root).render(
  <StrictMode>
    {perfRegion('App', <App engine={engine} bridge={window.glassgrid} workspace={workspace} />)}
  </StrictMode>,
);
