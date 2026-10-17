import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@glassgrid/ui/styles.css';
import './app.css';
import { App } from './App';
import { EngineClient } from './engine-client';
import { createAppWorkspace } from './workspace';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

// One engine client and one workspace for the window's lifetime; created
// outside React so StrictMode's double-mounting in development does not churn
// engine ports or reset the undo history.
const engine = new EngineClient(window.glassgrid);
const workspace = createAppWorkspace();

createRoot(root).render(
  <StrictMode>
    <App engine={engine} bridge={window.glassgrid} workspace={workspace} />
  </StrictMode>,
);
