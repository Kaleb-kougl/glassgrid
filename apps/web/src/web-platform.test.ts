/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { toFileHandle, type OpenCsvResult } from '@glassgrid/core';
import type { EngineClientLike } from '@glassgrid/app';
import { isGalleryRoute } from './routes';
import { createWebPlatform, LIVE_CHOICE_STORAGE_KEY, pickFile, WEB_MAX_FILE_BYTES, webLive, type WebEngine } from './web-platform';

const opened: OpenCsvResult = { status: 'opened', file: { handle: toFileHandle('0b6c8f0e-6d0a-4f43-9d3e-2f1f1a0d9c11'), displayName: 'trips.csv', sizeBytes: 3 } };

function setup(options: { nav?: Partial<Navigator>; pick?: () => Promise<File | null>; web?: Partial<WebEngine> } = {}) {
  const web = { engine: {} as EngineClientLike, registerFile: vi.fn((_file: File) => Promise.resolve(opened)), ...options.web };
  const target = new EventTarget();
  const writeText = vi.fn((_text: string) => Promise.resolve());
  const nav = { platform: 'Linux x86_64', clipboard: { writeText }, ...options.nav } as unknown as Navigator;
  const platform = createWebPlatform(web, { nav, target, ...(options.pick ? { pick: options.pick } : {}) });
  return { platform, web, target, writeText };
}

describe('web platform', () => {
  it('is a browser: no title-bar inset, no native menus or theme sync, the WASM size limit, no workspace files yet', () => {
    const { platform } = setup();
    expect(platform.name).toBe('web');
    expect(platform.window.titleBarInset).toBe(false);
    expect('syncTheme' in platform.window).toBe(false);
    expect('onMenuCommand' in platform.window).toBe(false);
    expect(platform.capabilities).toEqual({ canSaveWorkspace: false, canOpenFromPath: false, maxFileBytes: WEB_MAX_FILE_BYTES });
    expect(platform.workspaceFiles).toBeUndefined();
    // Map views draw on the basemap under the base (docs/live-flights-l3-data.md).
    expect(platform.map).toEqual({ assetsBase: '/map/', attribution: [] });
    expect(platform.files.privacyNote).toBe('The file is read in this browser and never uploaded.');
  });

  it('writes shortcuts the Mac way in browsers on a Mac', () => {
    expect(setup().platform.window.shortcuts).toBe('pc');
    expect(setup({ nav: { platform: 'MacIntel' } }).platform.window.shortcuts).toBe('mac');
    expect(setup({ nav: { platform: '', userAgentData: { platform: 'macOS' } } as Partial<Navigator> }).platform.window.shortcuts).toBe('mac');
  });

  it('registers picked and dropped Files with the engine; a cancelled picker opens nothing', async () => {
    const file = new File(['a\n1\n'], 'trips.csv');
    const picker = vi.fn<() => Promise<File | null>>().mockResolvedValueOnce(file).mockResolvedValueOnce(null);
    const { platform, web } = setup({ pick: picker });
    expect(await platform.files.pickCsv()).toBe(opened);
    expect(web.registerFile).toHaveBeenCalledWith(file);
    expect(await platform.files.pickCsv()).toEqual({ status: 'cancelled' });
    expect(web.registerFile).toHaveBeenCalledOnce();

    const dropped = platform.files.fileFromDrop({ files: [file] } as unknown as DataTransfer);
    expect(dropped).toBe(file);
    await platform.files.openDropped(file);
    expect(web.registerFile).toHaveBeenLastCalledWith(file);
    expect(await platform.files.openDropped({ name: 'not-a-file' })).toEqual({ status: 'failed', message: 'not-a-file is not a file' });
  });

  it('passes prepare through and starts the engine when the picker opens, before a file is chosen', async () => {
    const order: string[] = [];
    const prepare = vi.fn(() => order.push('prepare'));
    const { platform } = setup({ web: { prepare }, pick: () => (order.push('pick'), Promise.resolve(null)) });
    platform.files.prepare?.();
    expect(prepare).toHaveBeenCalledTimes(1);
    await platform.files.pickCsv();
    expect(order).toEqual(['prepare', 'prepare', 'pick']);
    expect('prepare' in setup().platform.files).toBe(false);
  });

  it('offers the engine’s samples when it has them', async () => {
    expect(setup().platform.files.samples).toBeUndefined();
    const openSample = vi.fn((_id: string) => Promise.resolve(opened));
    const { platform } = setup({ web: { samples: [{ id: 'taxi', label: 'Taxi' }], openSample } });
    expect(platform.files.samples).toEqual([{ id: 'taxi', label: 'Taxi' }]);
    await platform.files.openSample?.('taxi');
    expect(openSample).toHaveBeenCalledWith('taxi');
  });

  it('copies through navigator.clipboard and says so when there is none', async () => {
    const { platform, writeText } = setup();
    await platform.clipboard.writeText('a\tb');
    expect(writeText).toHaveBeenCalledWith('a\tb');
    const none = setup({ nav: { clipboard: undefined } }).platform;
    await expect(none.clipboard.writeText('x')).rejects.toThrow('The clipboard is not available on this page');
  });

  it('runs the before-close hook on pagehide', () => {
    const { platform, target } = setup();
    const listener = vi.fn();
    const off = platform.window.onBeforeClose(listener);
    target.dispatchEvent(new Event('pagehide'));
    off();
    target.dispatchEvent(new Event('pagehide'));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('picks with a hidden file input that resolves on change or cancel', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    const chosen = pickFile(document, '.csv');
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input?.accept).toBe('.csv');
    expect(click).toHaveBeenCalledOnce();
    input?.dispatchEvent(new Event('cancel'));
    expect(await chosen).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    click.mockRestore();
  });

  it('counts the page regaining focus without a file as a cancel (browsers without the cancel event)', async () => {
    vi.useFakeTimers();
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    const chosen = pickFile(document);
    vi.advanceTimersByTime(0);
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(1_000);
    expect(await chosen).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    click.mockRestore();
    vi.useRealTimers();
  });
});

describe('routes', () => {
  it('shows the gallery at /gallery or ?gallery, the app everywhere else', () => {
    expect(isGalleryRoute({ pathname: '/gallery', search: '' })).toBe(true);
    expect(isGalleryRoute({ pathname: '/gallery/', search: '' })).toBe(true);
    expect(isGalleryRoute({ pathname: '/', search: '?gallery' })).toBe(true);
    expect(isGalleryRoute({ pathname: '/', search: '' })).toBe(false);
    expect(isGalleryRoute({ pathname: '/galleryx', search: '?theme=dark' })).toBe(false);
  });
});

describe('page visibility (the live-flights feed pauses on it)', () => {
  it('reports the current visibility at once, then every change', () => {
    const state: { visibilityState: DocumentVisibilityState } = { visibilityState: 'visible' };
    const doc = Object.assign(new EventTarget(), state);
    const web = { engine: {} as EngineClientLike, registerFile: vi.fn(() => Promise.resolve(opened)) };
    const platform = createWebPlatform(web, { nav: { platform: 'Linux', clipboard: {} } as unknown as Navigator, target: new EventTarget(), doc });
    const seen: boolean[] = [];
    const stop = platform.window.onVisibilityChange?.((visible) => seen.push(visible));
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    stop?.();
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toEqual([true, false, true]);
  });
});

describe('live flights’ offline fallback (L5)', () => {
  const URL = 'https://site.example/api/flights';
  const body = (stale: boolean) => new Response(JSON.stringify({ now: 1, fetchedAt: 1, stale, source: 'adsb.lol', attribution: 'a', license: 'l', ac: [] }), { status: 200 });

  it('reports navigator.onLine at once and on online / offline events', () => {
    const nav = { onLine: true };
    const target = new EventTarget();
    const live = webLive({ requested: true, url: URL, nav, target, storage: null });
    const seen: boolean[] = [];
    const stop = live.onOnlineChange?.((online) => seen.push(online));
    nav.onLine = false;
    target.dispatchEvent(new Event('offline'));
    nav.onLine = true;
    target.dispatchEvent(new Event('online'));
    stop?.();
    target.dispatchEvent(new Event('offline'));
    expect(seen).toEqual([true, false, true]);
    expect(live.requested).toBe(true);
  });

  it('probes the relay once, without the browser cache: fresh data is true; stale data, a 503 or a network error false', async () => {
    const answers: Array<() => Promise<Response>> = [
      () => Promise.resolve(body(false)),
      () => Promise.resolve(body(true)),
      () => Promise.resolve(new Response('{}', { status: 503, headers: { 'retry-after': '10' } })),
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(new Response('<html>', { status: 200 })),
    ];
    const fetch = vi.fn((_url: string, _init: RequestInit) => (answers.shift() ?? (() => Promise.resolve(body(false))))());
    const live = webLive({ requested: true, url: URL, fetch, storage: null, nav: { onLine: true }, target: new EventTarget() });
    expect(await live.probe?.()).toBe(true);
    expect(fetch).toHaveBeenCalledWith(URL, expect.objectContaining({ cache: 'no-store' }));
    expect(await live.probe?.()).toBe(false);
    expect(await live.probe?.()).toBe(false);
    expect(await live.probe?.()).toBe(false);
    expect(await live.probe?.()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('aborts a probe in flight when its caller does', async () => {
    let seen: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      seen = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    const live = webLive({ requested: true, url: URL, fetch, storage: null, nav: { onLine: true }, target: new EventTarget() });
    const caller = new AbortController();
    const probing = live.probe?.(caller.signal);
    caller.abort();
    expect(await probing).toBe(false);
    expect(seen?.aborted).toBe(true);
  });

  it('keeps the choice in session storage, and survives storage that throws', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    const live = webLive({ requested: true, url: URL, storage, nav: { onLine: true }, target: new EventTarget() });
    expect(live.choice.get()).toBeNull();
    live.choice.set('recorded');
    expect(map.get(LIVE_CHOICE_STORAGE_KEY)).toBe('recorded');
    expect(live.choice.get()).toBe('recorded');
    live.choice.set(null);
    expect(map.has(LIVE_CHOICE_STORAGE_KEY)).toBe(false);
    const blocked = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); }, removeItem: () => { throw new Error('SecurityError'); } };
    const guarded = webLive({ requested: false, url: URL, storage: blocked, nav: { onLine: true }, target: new EventTarget() });
    expect(guarded.choice.get()).toBeNull();
    expect(() => guarded.choice.set('recorded')).not.toThrow();
  });
});
