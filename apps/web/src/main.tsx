import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { APP_NAME, Sql } from '@glassgrid/core';
import { Stat } from '@glassgrid/ui';
import '@glassgrid/ui/styles.css';
import './styles.css';

function App() {
  return (
    <main className="web">
      <h1>{APP_NAME} for the web</h1>
      <p>
        This build will run the same engine protocol on DuckDB-WASM. Until then it is a placeholder that
        proves the shared packages compile for the browser.
      </p>
      <dl>
        <Stat label="Shared row-count query" value={<code>{Sql.countRows}</code>} />
      </dl>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
