// First: in render-perf builds this installs the commit inspector before react-dom loads (empty otherwise).
import '@glassgrid/app/render-perf-core';
import '@glassgrid/ui/fonts.css';
import '@glassgrid/ui/tokens.css';
import '@glassgrid/ui/styles.css';
import { isGalleryRoute } from './routes';

/*
 * The web shell. Two routes, each its own chunk, so `/` loads only the app
 * and the gallery only the gallery:
 * - `/`: the shared app (app-route.tsx);
 * - `/gallery` or `?gallery`: the component gallery.
 * Hosting must serve index.html for /gallery (vite dev and preview do; the
 * Vercel rewrite is in docs/m4-app-package.md).
 */

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

if (isGalleryRoute(window.location)) {
  void import('./gallery/route').then(({ mountGallery }) => mountGallery(root));
} else {
  void import('./app-route').then(({ mountApp }) => mountApp(root));
}
