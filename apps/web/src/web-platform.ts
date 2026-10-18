import type { OpenCsvResult } from '@glassgrid/core';
import type { EngineClientLike, Platform, SampleDataset } from '@glassgrid/app';

/*
 * The web Platform: browser APIs for files, clipboard and theme, and an
 * engine client that can read browser `File`s. Today the engine is the
 * temporary stub (stub-engine/); M4 integration swaps in the DuckDB-WASM
 * worker client, whose `registerFile` (File System Access / drag-drop
 * `File` → `db.registerFileHandle`) takes the stub's place here.
 */

/** Practical ceiling for the WASM engine (4 GB address space; see docs/technical-design.md, "Web demo target"). */
export const WEB_MAX_FILE_BYTES = 2 * 1024 ** 3;

/** What the web platform needs from its engine besides the client itself. */
export interface WebEngine {
  readonly engine: EngineClientLike;
  /** Make a picked or dropped `File` known to the engine; resolves with its opaque handle. */
  registerFile(file: File): Promise<OpenCsvResult>;
  readonly samples?: readonly SampleDataset[];
  openSample?(id: string): Promise<OpenCsvResult>;
}

/** Files the picker offers (CSV and its usual MIME types; Parquet once the WASM engine lands). */
const ACCEPT = '.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain';

/**
 * A hidden `<input type=file>`: resolves with the chosen file, or null when
 * the person closes the picker (`cancel`, Chrome 113+, Firefox 91+, Safari 16.4+).
 */
export function pickFile(doc: Document = document, accept = ACCEPT): Promise<File | null> {
  return new Promise((resolve) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    doc.body.append(input);
    input.click();
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
}

export function createWebPlatform(web: WebEngine, options: WebPlatformOptions = {}): Platform {
  const nav = options.nav ?? navigator;
  const target = options.target ?? window;
  const pick = options.pick ?? (() => pickFile());
  return {
    name: 'web',
    engine: web.engine,
    files: {
      pickCsv: async () => {
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
    },
    capabilities: { canSaveWorkspace: false, canOpenFromPath: false, maxFileBytes: options.maxFileBytes === undefined ? WEB_MAX_FILE_BYTES : options.maxFileBytes },
  };
}
