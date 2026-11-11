import { describe, expect, it } from 'vitest';
import { isGalleryRoute, isMapDemoRoute } from './routes';

describe('the map test page route', () => {
  it('is ?map-demo, with or without other parameters, and never the gallery', () => {
    expect(isMapDemoRoute({ search: '?map-demo' })).toBe(true);
    expect(isMapDemoRoute({ search: '?theme=dark&map-demo&n=50' })).toBe(true);
    expect(isMapDemoRoute({ search: '' })).toBe(false);
    expect(isMapDemoRoute({ search: '?sample=taxi' })).toBe(false);
    expect(isGalleryRoute({ pathname: '/', search: '?map-demo' })).toBe(false);
  });
});
