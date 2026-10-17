import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@glassgrid/ui/styles.css';
import './app.css';
import { App } from './App';
import { EngineClient } from './engine-client';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

// One client for the page's lifetime; created outside React so StrictMode's
// double-mounting in development does not churn engine ports.
const engine = new EngineClient(window.glassgrid);

createRoot(root).render(
  <StrictMode>
    <App engine={engine} bridge={window.glassgrid} />
  </StrictMode>,
);
