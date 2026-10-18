import type { DriverFiles, FileInfo } from '../driver';
import { DataProtocol, type WasmBindings } from '../wasm/bindings';
import type { Source } from './protocol';

/*
 * The engine's files in the browser (the WASM driver's `DriverFiles`).
 * There is no file system, so paths are names in three virtual folders:
 *
 * - `/gg/src/<handle>/<file name>`: the sources. A picked `File` is
 *   registered with DuckDB-WASM as BROWSER_FILEREADER (read in place with
 *   FileReaderSync, never copied); a sample dataset URL as HTTP (range
 *   requests through synchronous XHR). Sizes and mtimes for fingerprints
 *   come from `File.size`/`lastModified` or Content-Length/Last-Modified.
 * - `opfs://glassgrid-cache/...`: the Parquet cache in the Origin Private File System,
 *   folder `glassgrid/parquet`, so CSV-to-Parquet copies survive reloads.
 *   DuckDB reads and writes those files through FileSystemSyncAccessHandles
 *   that this class opens before a statement names them (`prepare`) and
 *   closes before they are renamed or removed. OPFS cannot set mtimes, so
 *   `touch` is a no-op and the cache's LRU degrades to oldest-written first.
 * - `/gg/tmp/...`: nothing (DuckDB-WASM does not spill).
 */

export const SOURCE_ROOT = '/gg/src';
/**
 * DuckDB-WASM routes writes to OPFS sync access handles only for `opfs://`
 * names; other registered names are written to its in-memory file system.
 */
export const CACHE_ROOT = 'opfs://glassgrid-cache';
export const TEMP_ROOT = '/gg/tmp';
const OPFS_FOLDER = ['glassgrid', 'parquet'];

type Registered =
  | { kind: 'file'; file: File }
  | { kind: 'url'; url: string; sizeBytes: number; mtimeMs: number };

/** The parts of the OPFS API used here (typed loosely: lib.dom and lib.webworker disagree). */
interface SyncHandle {
  getSize(): number;
  read(buffer: Uint8Array, options?: { at?: number }): number;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

function sanitizeName(name: string): string {
  // Path separators, quotes and control characters become `_`.
  let cleaned = '';
  for (let i = 0; i < name.length && cleaned.length < 200; i += 1) {
    const ch = name.charAt(i);
    cleaned += ch === '/' || ch === '\\' || ch === "'" || ch === '"' || name.charCodeAt(i) < 0x20 ? '_' : ch;
  }
  return cleaned.length > 0 ? cleaned : 'data';
}

export class BrowserFiles implements DriverFiles {
  private readonly sources = new Map<string, Registered>();
  /** OPFS files DuckDB currently has open, by virtual path. */
  private readonly handles = new Map<string, { handle: SyncHandle; mtimeMs: number }>();

  constructor(
    private readonly bindings: WasmBindings,
    /** OPFS root, or null when OPFS is unavailable (the cache is then disabled). */
    private readonly opfs: FileSystemDirectoryHandle | null,
  ) {}

  get hasCache(): boolean {
    return this.opfs !== null;
  }

  // --- sources -----------------------------------------------------------------

  /** Register a source with DuckDB-WASM and return its path. */
  async registerSource(handle: string, source: Source): Promise<{ path: string; fileName: string; sizeBytes: number }> {
    if (source.kind === 'file') {
      const fileName = source.file.name;
      const path = `${SOURCE_ROOT}/${handle}/${sanitizeName(fileName)}`;
      this.bindings.registerFileHandle(path, source.file, DataProtocol.BROWSER_FILEREADER, true);
      this.sources.set(path, { kind: 'file', file: source.file });
      return { path, fileName, sizeBytes: source.file.size };
    }
    const url = new URL(source.url);
    const fileName = source.name ?? (decodeURIComponent(url.pathname.split('/').pop() ?? '') || 'data');
    const response = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
    if (!response.ok) throw new Error(`${url.href} answered ${response.status}`);
    const sizeBytes = Number(response.headers.get('content-length') ?? NaN);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error(`${url.href} sent no Content-Length`);
    const modified = Date.parse(response.headers.get('last-modified') ?? '');
    const path = `${SOURCE_ROOT}/${handle}/${sanitizeName(fileName)}`;
    this.bindings.registerFileURL(path, url.href, DataProtocol.HTTP, false);
    this.sources.set(path, { kind: 'url', url: url.href, sizeBytes, mtimeMs: Number.isFinite(modified) ? modified : 0 });
    return { path, fileName, sizeBytes };
  }

  // --- DriverFiles -------------------------------------------------------------

  join(...parts: string[]): string {
    return parts
      .map((part, index) => (index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, '')))
      .filter((part, index) => index === 0 || part.length > 0)
      .join('/');
  }

  basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
  }

  dirname(path: string): string {
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
  }

  async stat(path: string): Promise<FileInfo> {
    const source = this.sources.get(path);
    if (source?.kind === 'file') return { sizeBytes: source.file.size, mtimeMs: Math.trunc(source.file.lastModified), isFile: true };
    if (source?.kind === 'url') return { sizeBytes: source.sizeBytes, mtimeMs: Math.trunc(source.mtimeMs), isFile: true };
    const open = this.handles.get(path);
    if (open) return { sizeBytes: open.handle.getSize(), mtimeMs: open.mtimeMs, isFile: true };
    const located = await this.locate(path, false);
    if (located?.kind === 'directory') return { sizeBytes: 0, mtimeMs: 0, isFile: false };
    if (located?.kind === 'file') {
      const file = await located.handle.getFile();
      return { sizeBytes: file.size, mtimeMs: Math.trunc(file.lastModified), isFile: true };
    }
    throw notFound(path);
  }

  async readRange(path: string, position: number, length: number): Promise<Uint8Array> {
    const source = this.sources.get(path);
    if (length <= 0) return new Uint8Array(0);
    if (source?.kind === 'file') return new Uint8Array(await source.file.slice(position, position + length).arrayBuffer());
    if (source?.kind === 'url') {
      const response = await fetch(source.url, { headers: { Range: `bytes=${position}-${position + length - 1}` } });
      if (!response.ok) throw new Error(`${source.url} answered ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      // 200 instead of 206: the server ignored the range and sent everything.
      return response.status === 206 ? bytes : bytes.subarray(position, position + length);
    }
    const open = this.handles.get(path);
    if (open) {
      const buffer = new Uint8Array(Math.max(0, Math.min(length, open.handle.getSize() - position)));
      open.handle.read(buffer, { at: position });
      return buffer;
    }
    const located = await this.locate(path, false);
    if (located?.kind !== 'file') throw notFound(path);
    return new Uint8Array(await (await located.handle.getFile()).slice(position, position + length).arrayBuffer());
  }

  async mkdir(path: string): Promise<void> {
    if (!path.startsWith(CACHE_ROOT)) return;
    await this.directory(this.segments(path), true);
  }

  async readdir(path: string): Promise<string[]> {
    if (!path.startsWith(CACHE_ROOT)) return [];
    const directory = await this.directory(this.segments(path), false).catch(() => null);
    if (!directory) return [];
    const names: string[] = [];
    for await (const name of (directory as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names;
  }

  async rename(from: string, to: string): Promise<void> {
    this.release(from);
    this.release(to);
    const source = await this.locate(from, false);
    if (source?.kind !== 'file') throw notFound(from);
    const target = await this.directory(this.segments(this.dirname(to)), true);
    const movable = source.handle as unknown as { move?: (directory: FileSystemDirectoryHandle, name: string) => Promise<void> };
    if (typeof movable.move === 'function') {
      await movable.move(target, this.basename(to));
      return;
    }
    // No FileSystemHandle.move (older Safari): copy, then remove.
    const data = new Uint8Array(await (await source.handle.getFile()).arrayBuffer());
    const copy = await target.getFileHandle(this.basename(to), { create: true });
    const access = (await (copy as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle());
    try {
      access.truncate(0);
      access.write(data, { at: 0 });
      access.flush();
    } finally {
      access.close();
    }
    await this.remove(from);
  }

  async remove(path: string): Promise<void> {
    // A folder: close DuckDB's handles on everything inside it first (OPFS refuses to remove locked files).
    for (const open of [...this.handles.keys()]) if (open === path || open.startsWith(`${path}/`)) this.release(open);
    if (!path.startsWith(CACHE_ROOT)) return;
    const parent = await this.directory(this.segments(this.dirname(path)), false).catch(() => null);
    await parent?.removeEntry(this.basename(path), { recursive: true }).catch(() => undefined);
  }

  touch(): Promise<void> {
    return Promise.resolve();
  }

  async sha256(chunks: readonly Uint8Array[]): Promise<string> {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  // --- statement hooks (WasmDriver beforeStatement / afterStatement) --------------

  /** Open the OPFS cache files a statement names, creating COPY targets. */
  readonly prepare = async (sql: string): Promise<void> => {
    const writes = /^\s*COPY\b/i.test(sql);
    for (const path of cachePaths(sql)) {
      if (this.handles.has(path)) continue;
      const located = await this.locate(path, writes && path.endsWith('.partial'));
      if (located?.kind !== 'file') continue; // DuckDB reports the missing file itself
      const file = await located.handle.getFile();
      const handle = await (located.handle as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
      this.bindings.registerFileHandle(path, handle, DataProtocol.BROWSER_FSACCESS, true);
      this.handles.set(path, { handle, mtimeMs: Math.trunc(file.lastModified) });
    }
  };

  /** After a COPY, flush what it wrote so a rename sees the whole file. */
  readonly finish = (sql: string): Promise<void> => {
    if (/^\s*COPY\b/i.test(sql)) {
      for (const path of cachePaths(sql)) this.handles.get(path)?.handle.flush();
    }
    return Promise.resolve();
  };

  /** Close DuckDB's handle on a cache file (before it is renamed or removed). */
  private release(path: string): void {
    const open = this.handles.get(path);
    if (!open) return;
    this.handles.delete(path);
    try {
      this.bindings.dropFile(path);
    } catch {
      // Not registered any more.
    }
    try {
      open.handle.flush();
      open.handle.close();
    } catch {
      // Already closed.
    }
  }

  private segments(path: string): string[] {
    if (!path.startsWith(CACHE_ROOT)) throw new Error(`Not a cache path: ${path}`);
    return [...OPFS_FOLDER, ...path.slice(CACHE_ROOT.length).split('/').filter((part) => part.length > 0)];
  }

  private async directory(segments: readonly string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    if (!this.opfs) throw new Error('The Origin Private File System is not available');
    let directory = this.opfs;
    for (const segment of segments) directory = await directory.getDirectoryHandle(segment, { create });
    return directory;
  }

  private async locate(
    path: string,
    createFile: boolean,
  ): Promise<{ kind: 'file'; handle: FileSystemFileHandle } | { kind: 'directory'; handle: FileSystemDirectoryHandle } | null> {
    if (!path.startsWith(CACHE_ROOT) || !this.opfs) return null;
    const segments = this.segments(path);
    const name = segments.pop();
    try {
      const parent = await this.directory(segments, createFile);
      if (name === undefined) return { kind: 'directory', handle: parent };
      try {
        return { kind: 'file', handle: await parent.getFileHandle(name, { create: createFile }) };
      } catch {
        return { kind: 'directory', handle: await parent.getDirectoryHandle(name) };
      }
    } catch {
      return null;
    }
  }
}

/** The cache paths (`opfs://glassgrid-cache/...`) quoted in a statement. */
function cachePaths(sql: string): string[] {
  const paths: string[] = [];
  for (const match of sql.matchAll(/'(opfs:\/\/glassgrid-cache\/(?:[^']|'')*)'/g)) {
    const path = match[1];
    if (path !== undefined) paths.push(path.replaceAll("''", "'"));
  }
  return paths;
}

function notFound(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file: ${path}`), { code: 'ENOENT' });
}
