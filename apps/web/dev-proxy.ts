import type { ProxyOptions } from 'vite';

/*
 * The dev server's proxy for the live-flights relay (docs/live-flights-l4.md,
 * "Live data locally"). The app polls `/api/flights` on its own origin
 * (core's `LIVE_FLIGHTS_PATH`, outside the `/glassgrid/` base): in
 * production that is the portfolio's Next.js route; under `vite` (dev)
 * nothing serves it, so the dev server forwards it to the portfolio's own
 * dev server, which does:
 *
 *   # in the portfolio:  GLASSGRID_SKIP=1 npm run dev        (Next on :3000)
 *   # here:              pnpm dev:web, then open /?live=1
 *
 * `GLASSGRID_FLIGHTS_PROXY` points it elsewhere (another port, a deployed
 * site). Dev server only: `vite preview` and the build get no proxy
 * (vite.config.ts sets `preview.proxy` to `{}`, since Vite's preview
 * otherwise inherits `server.proxy`), and nothing here touches the
 * production headers or CSP (hosting.ts, csp.ts). The browser still sees a
 * same-origin request, so `connect-src 'self'` holds in dev too.
 */

/** Where `/api/flights` goes by default: the portfolio's Next.js dev server. */
export const DEFAULT_FLIGHTS_PROXY_TARGET = 'http://localhost:3000';

/** The relay's path on the site's origin; equal to core's LIVE_FLIGHTS_PATH (dev-proxy.test.ts checks). */
export const FLIGHTS_PROXY_PATH = '/api/flights';

/**
 * The proxy key: exactly `/api/flights`, with or without a query string
 * (Vite treats a key starting with `^` as a regular expression; a plain
 * string would also match `/api/flightsfoo`).
 */
export const FLIGHTS_PROXY_KEY = '^/api/flights(?:\\?.*)?$';

/** The proxy target from the environment: an http(s) origin, else the default. Throws on anything else. */
export function flightsProxyTarget(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env['GLASSGRID_FLIGHTS_PROXY']?.trim();
  if (raw === undefined || raw === '') return DEFAULT_FLIGHTS_PROXY_TARGET;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`GLASSGRID_FLIGHTS_PROXY must be an http(s) URL such as http://localhost:3000; got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`GLASSGRID_FLIGHTS_PROXY must be an http(s) URL; got ${JSON.stringify(raw)}`);
  }
  return url.origin;
}

/** `server.proxy` for `vite` (dev): `/api/flights` → the target's `/api/flights`. */
export function devFlightsProxy(env: Readonly<Record<string, string | undefined>>): Record<string, ProxyOptions> {
  return {
    [FLIGHTS_PROXY_KEY]: {
      target: flightsProxyTarget(env),
      // The upstream sees its own host (Next.js dev checks nothing, a deployed site's CDN routes by it).
      changeOrigin: true,
    },
  };
}
