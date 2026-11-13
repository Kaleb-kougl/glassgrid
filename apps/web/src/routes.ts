import { appPath, BASE_PATH } from './base';

/** `/gallery` (under the base: `/glassgrid/gallery`) or `?gallery` shows the component gallery; everything else the app. */
export function isGalleryRoute(location: Pick<Location, 'pathname' | 'search'>, base: string = BASE_PATH): boolean {
  return /^\/gallery\/?$/.test(appPath(location.pathname, base)) || new URLSearchParams(location.search).has('gallery');
}

/** `?map-demo`: the live-flights map on synthetic traffic (the map's E2E and benchmark page; not linked from the app). */
export function isMapDemoRoute(location: Pick<Location, 'search'>): boolean {
  return new URLSearchParams(location.search).has('map-demo');
}
