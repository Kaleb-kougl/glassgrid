import { appPath, BASE_PATH } from './base';

/** `/gallery` (under the base: `/glassgrid/gallery`) or `?gallery` shows the component gallery; everything else the app. */
export function isGalleryRoute(location: Pick<Location, 'pathname' | 'search'>, base: string = BASE_PATH): boolean {
  return /^\/gallery\/?$/.test(appPath(location.pathname, base)) || new URLSearchParams(location.search).has('gallery');
}
