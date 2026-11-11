import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './map-demo.css';
import { MapDemo } from './MapDemo';

/** `?map-demo`: the map test page (synthetic traffic). Loaded on demand; MapLibre comes later still, with the map chunk. */
export function mountMapDemo(root: HTMLElement): void {
  document.title = 'Glassgrid map test page';
  createRoot(root).render(
    <StrictMode>
      <MapDemo search={window.location.search} />
    </StrictMode>,
  );
}
