/*
 * Where the demo is served: `/` (a domain of its own) or a subfolder such as
 * `/glassgrid/` (the portfolio). It is Vite's `base`, set at build time from
 * GLASSGRID_BASE (vite.config.ts), and always starts and ends with `/`.
 * Every URL the page or the engine worker builds goes through here, so a
 * subfolder build never asks for anything outside its folder.
 */

export const BASE_PATH: string = import.meta.env.BASE_URL;

/** `path` (relative, no leading slash: `samples/`, `duckdb-extensions`) under the base: `/glassgrid/samples/`. */
export function withBase(path: string, base: string = BASE_PATH): string {
  return `${base}${path.replace(/^\/+/, '')}`;
}

/**
 * The app's own path for a page URL's pathname: `/glassgrid/gallery` →
 * `/gallery`, `/glassgrid` or `/glassgrid/` → `/`. A pathname outside the
 * base is returned as is.
 */
export function appPath(pathname: string, base: string = BASE_PATH): string {
  if (base === '/') return pathname;
  if (pathname === base.slice(0, -1)) return '/';
  return pathname.startsWith(base) ? `/${pathname.slice(base.length)}` : pathname;
}

/** An absolute URL for `path` under the base on `origin` (the worker needs absolute URLs). */
export function absoluteUrl(path: string, origin: string, base: string = BASE_PATH): string {
  return new URL(withBase(path, base), origin).href;
}
