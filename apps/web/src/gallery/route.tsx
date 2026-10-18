import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './gallery.css';
import { Gallery } from './Gallery';

/** `/gallery` (or `?gallery`): the component gallery, both themes side by side. Loaded on demand. */
export function mountGallery(root: HTMLElement): void {
  document.title = 'Glassgrid component gallery';
  createRoot(root).render(
    <StrictMode>
      <Gallery />
    </StrictMode>,
  );
}
