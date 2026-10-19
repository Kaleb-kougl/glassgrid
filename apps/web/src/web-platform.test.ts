/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { toFileHandle, type OpenCsvResult } from '@glassgrid/core';
import type { EngineClientLike } from '@glassgrid/app';
import { isGalleryRoute } from './routes';
import { createWebPlatform, pickFile, WEB_MAX_FILE_BYTES, type WebEngine } from './web-platform';

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
    expect(setup().platform.files.prepare).toBeUndefined();
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
