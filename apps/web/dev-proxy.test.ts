import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, resolveConfig, type ViteDevServer } from 'vite';
import { LIVE_FLIGHTS_PATH } from '@glassgrid/core';
import { DEFAULT_FLIGHTS_PROXY_TARGET, devFlightsProxy, FLIGHTS_PROXY_KEY, FLIGHTS_PROXY_PATH, flightsProxyTarget } from './dev-proxy';

/*
 * The dev server's `/api/flights` proxy (dev-proxy.ts): the config itself,
 * then the real `vite` dev server from vite.config.ts in front of a mock
 * upstream standing in for the portfolio's Next.js dev server.
 */

const CONFIG_FILE = join(import.meta.dirname, 'vite.config.ts');

describe('the /api/flights dev proxy config', () => {
  it('targets the portfolio dev server unless GLASSGRID_FLIGHTS_PROXY says otherwise', () => {
    expect(flightsProxyTarget({})).toBe(DEFAULT_FLIGHTS_PROXY_TARGET);
    expect(DEFAULT_FLIGHTS_PROXY_TARGET).toBe('http://localhost:3000');
    expect(flightsProxyTarget({ GLASSGRID_FLIGHTS_PROXY: '' })).toBe(DEFAULT_FLIGHTS_PROXY_TARGET);
    expect(flightsProxyTarget({ GLASSGRID_FLIGHTS_PROXY: 'http://127.0.0.1:3100' })).toBe('http://127.0.0.1:3100');
    // Only the origin: a path would be dropped by the proxy anyway, so say what is used.
    expect(flightsProxyTarget({ GLASSGRID_FLIGHTS_PROXY: 'https://example.test/ignored/' })).toBe('https://example.test');
    expect(() => flightsProxyTarget({ GLASSGRID_FLIGHTS_PROXY: 'localhost:3000' })).toThrow(/http\(s\) URL/);
    expect(() => flightsProxyTarget({ GLASSGRID_FLIGHTS_PROXY: 'file:///etc/passwd' })).toThrow(/http\(s\) URL/);
  });

  it('proxies exactly the relay path the app polls', () => {
    expect(FLIGHTS_PROXY_PATH).toBe(LIVE_FLIGHTS_PATH);
    const key = new RegExp(FLIGHTS_PROXY_KEY);
    expect(key.test('/api/flights')).toBe(true);
    expect(key.test('/api/flights?t=1')).toBe(true);
    expect(key.test('/api/flightsx')).toBe(false);
    expect(key.test('/api/flights/../secrets')).toBe(false);
    expect(key.test('/glassgrid/api/flights')).toBe(false);
    expect(devFlightsProxy({})).toEqual({ [FLIGHTS_PROXY_KEY]: { target: DEFAULT_FLIGHTS_PROXY_TARGET, changeOrigin: true } });
  });

  it('is set for the dev server only: vite preview and the build have none', async () => {
    const serve = await resolveConfig({ configFile: CONFIG_FILE, logLevel: 'silent' }, 'serve', 'development');
    expect(Object.keys(serve.server.proxy ?? {})).toEqual([FLIGHTS_PROXY_KEY]);
    expect(serve.preview.proxy).toEqual({});
    const build = await resolveConfig({ configFile: CONFIG_FILE, logLevel: 'silent' }, 'build', 'production');
    expect(build.preview.proxy).toEqual({});
    expect(build.server.proxy ?? {}).toEqual({});
  });

  it('a malformed GLASSGRID_FLIGHTS_PROXY stops only the dev server: the build and vite preview never read it', async () => {
    const previous = process.env['GLASSGRID_FLIGHTS_PROXY'];
    process.env['GLASSGRID_FLIGHTS_PROXY'] = 'localhost:3000';
    try {
      const build = await resolveConfig({ configFile: CONFIG_FILE, logLevel: 'silent' }, 'build', 'production');
      expect(build.server.proxy ?? {}).toEqual({});
      const preview = await resolveConfig({ configFile: CONFIG_FILE, logLevel: 'silent' }, 'serve', 'production', 'production', true);
      expect(preview.preview.proxy).toEqual({});
      await expect(resolveConfig({ configFile: CONFIG_FILE, logLevel: 'silent' }, 'serve', 'development')).rejects.toThrow(/GLASSGRID_FLIGHTS_PROXY.*http\(s\) URL|http\(s\) URL/);
    } finally {
      if (previous === undefined) delete process.env['GLASSGRID_FLIGHTS_PROXY'];
      else process.env['GLASSGRID_FLIGHTS_PROXY'] = previous;
    }
  });
});

describe('pnpm dev:web with a mock upstream', () => {
  let upstream: Server;
  let vite: ViteDevServer;
  let viteUrl: string;
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const previous = process.env['GLASSGRID_FLIGHTS_PROXY'];

  beforeAll(async () => {
    upstream = createHttpServer((request, response) => {
      seen.push({ url: request.url ?? '', headers: request.headers });
      if (request.url?.startsWith('/api/flights') === true) {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, s-maxage=10' });
        response.end(JSON.stringify({ now: 1_762_732_800_000, fetchedAt: 1_762_732_800_100, stale: false, source: 'adsb.lol', attribution: 'mock', license: 'ODbL-1.0', ac: [] }));
      } else {
        response.writeHead(404).end('not the relay');
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    process.env['GLASSGRID_FLIGHTS_PROXY'] = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    vite = await createServer({ configFile: CONFIG_FILE, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: false } });
    await vite.listen();
    viteUrl = `http://127.0.0.1:${(vite.httpServer?.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    if (previous === undefined) delete process.env['GLASSGRID_FLIGHTS_PROXY'];
    else process.env['GLASSGRID_FLIGHTS_PROXY'] = previous;
    await vite.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('forwards /api/flights to the upstream and its answer back', async () => {
    const response = await fetch(`${viteUrl}/api/flights`, { headers: { accept: 'application/json' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, s-maxage=10');
    const body = (await response.json()) as { source: string; ac: unknown[] };
    expect(body).toMatchObject({ source: 'adsb.lol', ac: [] });
    const request = seen.at(-1);
    expect(request?.url).toBe('/api/flights');
    // changeOrigin: the upstream sees its own host, not the dev server's.
    expect(request?.headers.host).toBe(new URL(process.env['GLASSGRID_FLIGHTS_PROXY'] ?? '').host);
  });

  it('keeps the query string and forwards nothing else', async () => {
    const before = seen.length;
    const response = await fetch(`${viteUrl}/api/flights?probe=1`);
    expect(response.status).toBe(200);
    expect(seen.at(-1)?.url).toBe('/api/flights?probe=1');
    // Other paths are the dev server's own (the app, or its 404): never the upstream's.
    await fetch(`${viteUrl}/api/flightsx`).then((r) => r.arrayBuffer());
    await fetch(`${viteUrl}/api/other`).then((r) => r.arrayBuffer());
    expect(seen.length).toBe(before + 1);
  });
});
