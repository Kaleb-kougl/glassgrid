import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@glassgrid/ui/fonts.css';
import '@glassgrid/ui/tokens.css';
import '@glassgrid/ui/styles.css';
import './styles.css';
import { Gallery } from './Gallery';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

createRoot(root).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
