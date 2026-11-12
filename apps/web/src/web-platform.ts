import type { OpenCsvResult } from '@glassgrid/core';
import type { EngineClientLike, LiveFallbackChoice, Platform, PlatformLive, PlatformMap, SampleDataset } from '@glassgrid/app';
import { withBase } from './base';

/*
 * The web Platform: browser APIs for files, clipboard and theme, and an
 * engine client that can read browser `File`s: the DuckDB-WASM worker
 * client (web-engine.ts), whose `registerFile` hands a picked or dropped
 * `File` to the worker, which reads it in place.
 */

/**
 * Largest file the web demo opens: the engine worker's own cap (`maxSourceBytes`, 1 GiB by
 * default, from the design doc's risk table; DuckDB-WASM has a 4 GB address space and no spilling).
 */
export const WEB_MAX_FILE_BYTES = 1024 ** 3;

/** What the web platform needs from its engine besides the client itself. */
export interface WebEngine {
  readonly engine: EngineClientLike;
  /** Make a picked or dropped `File` known to the engine; resolves with its opaque handle. */
  registerFile(file: File): Promise<OpenCsvResult>;
  readonly samples?: readonly SampleDataset[];
  openSample?(id: string): Promise<OpenCsvResult>;
  /** Start the engine ahead of a likely open (it starts lazily). */
  prepare?(): void;
}

/** Files the picker offers: CSV and its usual MIME types, and Parquet (the engine opens it in place). */
const ACCEPT = '.csv,.tsv,.txt,.parquet,text/csv,text/tab-separated-values,text/plain';

/** How long after the page regains focus a picker without `change` counts as cancelled (browsers without `cancel`). */
const FOCUS_CANCEL_MS = 1_000;

/**
 * A hidden `<input type=file>`: resolves with the chosen file, or null when
 * the person closes the picker (`cancel`: Chrome 113+, Firefox 91+, Safari
 * 16.4+; elsewhere, the page regaining focus without a `change`).
 */
export function pickFile(doc: Document = document, accept = ACCEPT): Promise<File | null> {
  return new Promise((resolve) => {
    const view = doc.defaultView;
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const done = (file: File | null) => {
      if (settled) return;
      settled = true;
      view?.removeEventListener('focus', onFocus);
      input.remove();
      resolve(file);
    };
    const onFocus = () => view?.setTimeout(() => done(input.files?.[0] ?? null), FOCUS_CANCEL_MS);
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    doc.body.append(input);
    input.click();
    // Registered after click(): the picker takes focus from the page, which gets it back when it closes.
    view?.setTimeout(() => {
      if (!settled) view.addEventListener('focus', onFocus);
    }, 0);
  });
}

function isMac(nav: Navigator): boolean {
  const data = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac|iphone|ipad/i.test(data?.platform ?? nav.platform);
}

export interface WebPlatformOptions {
  readonly maxFileBytes?: number | null;
  /** Replaces the hidden-input picker (tests). */
  readonly pick?: () => Promise<File | null>;
  readonly target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly nav?: Navigator;
  /** Where `visibilitychange` fires and `visibilityState` is read (tests). */
  readonly doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  /** The basemap for map views; default: the assets under `<base>map/` and their credit. */
  readonly map?: PlatformMap;
  /** Live flights' offline fallback (L5); default none. */
  readonly live?: PlatformLive;
}

/** The map view's basemap on this site: style, tiles, glyphs and sprites under `<base>map/` (docs/live-flights-l3-data.md). */
export function webMap(base?: string): PlatformMap {
  // No extra credits: MapView adds the basemap's own (Natural Earth, OurAirports)
  // from apps/web/public/map/basemap.json after the data's line.
  return { assetsBase: base === undefined ? withBase('map/') : withBase('map/', base), attribution: [] };
}

/** sessionStorage key of the person's choice of recorded traffic over an unavailable live feed (L5): per tab, prefixed (the portfolio shares the origin). */
export const LIVE_CHOICE_STORAGE_KEY = 'glassgrid.flights.choice';

/** How long a probe of the live relay may take (as long as the live source's own poll, DEFAULT_LIVE_TIMEOUT_MS). */
const PROBE_TIMEOUT_MS = 20_000;

export interface WebLiveOptions {
  /** The page was opened with `?live=1`. */
  readonly requested: boolean;
  /** The relay (default: `/api/flights` on this origin, as the engine polls it). */
  readonly url: string;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  readonly nav?: Pick<Navigator, 'onLine'>;
  readonly target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** The session storage, or null where it cannot be used (blocked site data, some private windows). */
function sessionStore(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Live flights' offline fallback on the web (L5): `navigator.onLine` and its events, one GET of the relay as a probe
 * (same origin, `connect-src 'self'`; it counts as one more request to the CDN, once a minute at most while the
 * recorded traffic shows), and the choice in sessionStorage (a tab's session; every access guarded).
 */
export function webLive(options: WebLiveOptions): PlatformLive {
  const storage = options.storage === undefined ? sessionStore() : options.storage;
  const nav = options.nav ?? navigator;
  const target = options.target ?? window;
  const fetchImpl = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  return {
    requested: options.requested,
    onOnlineChange: (listener) => {
      const report = () => listener(nav.onLine);
      target.addEventListener('online', report);
      target.addEventListener('offline', report);
      report();
      return () => {
        target.removeEventListener('online', report);
        target.removeEventListener('offline', report);
      };
    },
    probe: async (signal) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      // The caller's abort (the page hidden, the card gone) cancels the request too.
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await fetchImpl(options.url, { cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return false;
        }
        const body = (await response.json()) as { stale?: unknown; ac?: unknown } | null;
        return body !== null && typeof body === 'object' && body.stale === false && Array.isArray(body.ac);
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
    choice: {
      get: (): LiveFallbackChoice | null => {
        try {
          return storage?.getItem(LIVE_CHOICE_STORAGE_KEY) === 'recorded' ? 'recorded' : null;
        } catch {
          return null;
        }
      },
      set: (choice) => {
        try {
          if (choice === null) storage?.removeItem(LIVE_CHOICE_STORAGE_KEY);
          else storage?.setItem(LIVE_CHOICE_STORAGE_KEY, choice);
        } catch {
          // Storage blocked: the choice lasts as long as the page.
        }
      },
    },
  };
}

export function createWebPlatform(web: WebEngine, options: WebPlatformOptions = {}): Platform {
  const nav = options.nav ?? navigator;
  const target = options.target ?? window;
  const doc = options.doc ?? document;
  const pick = options.pick ?? (() => pickFile());
  return {
    name: 'web',
    engine: web.engine,
    files: {
      pickCsv: async () => {
        // DuckDB-WASM downloads while the person picks a file.
        web.prepare?.();
        const file = await pick();
        return file ? web.registerFile(file) : { status: 'cancelled' };
      },
      fileFromDrop: (data) => data.files[0] ?? null,
      openDropped: (file) =>
        file instanceof File ? web.registerFile(file) : Promise.resolve({ status: 'failed', message: `${file.name} is not a file` }),
      privacyNote: 'The file is read in this browser and never uploaded.',
      ...(web.samples && web.samples.length > 0 && web.openSample
        ? { samples: web.samples, openSample: (id: string) => web.openSample?.(id) ?? Promise.resolve({ status: 'cancelled' as const }) }
        : {}),
      ...(web.prepare ? { prepare: () => web.prepare?.() } : {}),
    },
    clipboard: {
      writeText: (text) => {
        if (!(nav.clipboard as Clipboard | undefined)) return Promise.reject(new Error('The clipboard is not available on this page'));
        return nav.clipboard.writeText(text);
      },
    },
    window: {
      titleBarInset: false,
      shortcuts: isMac(nav) ? 'mac' : 'pc',
      // Theme follows prefers-color-scheme (and the stored override); no native chrome to tell.
      onBeforeClose: (listener) => {
        target.addEventListener('pagehide', listener);
        return () => target.removeEventListener('pagehide', listener);
      },
      // The engine worker cannot see document.visibilityState; the live-flights feed pauses on it.
      onVisibilityChange: (listener) => {
        const report = () => listener(doc.visibilityState !== 'hidden');
        doc.addEventListener('visibilitychange', report);
        report();
        return () => doc.removeEventListener('visibilitychange', report);
      },
    },
    capabilities: { canSaveWorkspace: false, canOpenFromPath: false, maxFileBytes: options.maxFileBytes === undefined ? WEB_MAX_FILE_BYTES : options.maxFileBytes },
    map: options.map ?? webMap(),
    ...(options.live ? { live: options.live } : {}),
  };
}
