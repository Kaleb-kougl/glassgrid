import { describe, expect, it } from 'vitest';
import { absoluteUrl, appPath, BASE_PATH, withBase } from './base';
import { isGalleryRoute } from './routes';
import { extensionRepository } from './web-engine';

/*
 * The base-path helpers: a default build is served at `/`, a portfolio
 * build at `/glassgrid/` (GLASSGRID_BASE). Every URL the app builds goes
 * through them.
 */

describe('base path', () => {
  it('is / in a default build (vitest runs without GLASSGRID_BASE)', () => {
    expect(BASE_PATH).toBe('/');
    expect(withBase('samples/')).toBe('/samples/');
  });

  it('puts paths under the base', () => {
    expect(withBase('samples/', '/glassgrid/')).toBe('/glassgrid/samples/');
    expect(withBase('/duckdb-extensions', '/glassgrid/')).toBe('/glassgrid/duckdb-extensions');
    expect(withBase('', '/a/b/')).toBe('/a/b/');
    expect(absoluteUrl('duckdb-extensions', 'https://kalebkougl-portfolio.vercel.app', '/glassgrid/')).toBe('https://kalebkougl-portfolio.vercel.app/glassgrid/duckdb-extensions');
    expect(absoluteUrl('duckdb-extensions', 'http://127.0.0.1:4173', '/')).toBe('http://127.0.0.1:4173/duckdb-extensions');
  });

  it('reads the app path from a page pathname, with or without the base\'s trailing slash', () => {
    expect(appPath('/gallery', '/')).toBe('/gallery');
    expect(appPath('/glassgrid', '/glassgrid/')).toBe('/');
    expect(appPath('/glassgrid/', '/glassgrid/')).toBe('/');
    expect(appPath('/glassgrid/gallery', '/glassgrid/')).toBe('/gallery');
    expect(appPath('/glassgridx/gallery', '/glassgrid/')).toBe('/glassgridx/gallery');
  });

  it('routes /gallery and ?gallery to the gallery at the root and under a base', () => {
    const at = (pathname: string, search = '') => ({ pathname, search });
    expect(isGalleryRoute(at('/gallery'))).toBe(true);
    expect(isGalleryRoute(at('/gallery/'))).toBe(true);
    expect(isGalleryRoute(at('/', '?gallery'))).toBe(true);
    expect(isGalleryRoute(at('/'))).toBe(false);
    expect(isGalleryRoute(at('/glassgrid/gallery'), '/glassgrid/')).toBe(true);
    expect(isGalleryRoute(at('/glassgrid/gallery/'), '/glassgrid/')).toBe(true);
    expect(isGalleryRoute(at('/glassgrid', '?gallery'), '/glassgrid/')).toBe(true);
    expect(isGalleryRoute(at('/glassgrid'), '/glassgrid/')).toBe(false);
    expect(isGalleryRoute(at('/glassgrid/', '?sample=taxi'), '/glassgrid/')).toBe(false);
  });

  it('serves the Parquet extension from under the base', () => {
    expect(extensionRepository('https://example.test')).toBe('https://example.test/duckdb-extensions');
    expect(extensionRepository('https://example.test', '/glassgrid/')).toBe('https://example.test/glassgrid/duckdb-extensions');
  });
});
