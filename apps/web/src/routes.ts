/** `/gallery` or `?gallery` shows the component gallery; everything else the app. */
export function isGalleryRoute(location: Pick<Location, 'pathname' | 'search'>): boolean {
  return /^\/gallery\/?$/.test(location.pathname) || new URLSearchParams(location.search).has('gallery');
}
