// First: no Zod code generation under the CSP (see zod-jitless.ts).
import './zod-jitless';
// Then: in render-perf builds this installs the commit inspector before react-dom loads (empty otherwise).
import '@glassgrid/app/render-perf-core';
import '@glassgrid/ui/fonts.css';
import '@glassgrid/ui/tokens.css';
import '@glassgrid/ui/styles.css';
import { isGalleryRoute, isMapDemoRoute } from './routes';

/*
 * The web shell. Three routes, each its own chunk, so `/` loads only the app
 * and the gallery only the gallery:
 * - `/`: the shared app (app-route.tsx);
 * - `/gallery` or `?gallery`: the component gallery;
 * - `?map-demo`: the live-flights map on synthetic traffic (map-demo/, for its E2E and benchmark).
 * They are relative to the base (`/glassgrid/gallery` in a subfolder build,
 * see base.ts). Hosting must serve index.html for the gallery route (vite
 * dev and preview do; the rewrites for Vercel and Next.js are in hosting.ts).
 */

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

if (isGalleryRoute(window.location)) {
  void import('./gallery/route').then(({ mountGallery }) => mountGallery(root));
} else if (isMapDemoRoute(window.location)) {
  void import('./map-demo/route').then(({ mountMapDemo }) => mountMapDemo(root));
} else {
  void import('./app-route').then(({ mountApp }) => mountApp(root));
}
