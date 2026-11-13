/**
 * A minimal streaming tar reader: enough of POSIX ustar, GNU tar and pax to
 * walk adsb.lol's `globe_history` archives (GNU tar, `./`-prefixed paths)
 * without writing them to disk or adding a dependency.
 *
 * Push-style: feed chunks of any size to `TarParser.push`, which returns the
 * entries completed by that chunk; `finish()` throws if the archive was cut
 * off. `readTar` wraps it for async iterables (an HTTP body). Entry bodies
 * are buffered only when `wantBody(header)` says so; others are skipped
 * without copying, so multi-megabyte entries cost nothing when unwanted.
 *
 * Supported: regular files (`0`, NUL, `7`), directories and other types (as
 * headers), GNU long names (`L`), pax extended headers (`x`: `path` and
 * `size`; `g` is ignored), base-256 sizes, and the ustar `prefix` field.
 * Every header's checksum is verified, so a corrupt or misaligned stream
 * (for example parts concatenated in the wrong order) fails loudly.
 */

const BLOCK = 512;

export interface TarHeader {
  /** Path with any leading `./` removed. */
  path: string;
  /** Typeflag character: `0` file, `5` directory, ... (NUL is reported as `0`). */
  typeflag: string;
  size: number;
  /** Modification time, epoch seconds. */
  mtime: number;
}

export interface TarEntry extends TarHeader {
  /** The entry's bytes, or null when `wantBody` declined it. */
  body: Uint8Array | null;
}

export interface TarParserOptions {
  /** Whether to buffer this entry's body. Default: regular files only. */
  wantBody?: (header: TarHeader) => boolean;
}

type State = 'header' | 'body' | 'padding' | 'done';

const decoder = new TextDecoder('utf-8');

function cString(bytes: Uint8Array, start: number, length: number): string {
  let end = start;
  while (end < start + length && bytes[end] !== 0) end += 1;
  return decoder.decode(bytes.subarray(start, end));
}

/** Octal numeric field, or GNU base-256 when the high bit of the first byte is set. */
export function readNumber(bytes: Uint8Array, start: number, length: number): number {
  const first = bytes[start] ?? 0;
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f;
    for (let i = start + 1; i < start + length; i += 1) value = value * 256 + (bytes[i] ?? 0);
    if (!Number.isSafeInteger(value)) throw new Error('tar: base-256 number too large');
    return value;
  }
  const text = cString(bytes, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`tar: bad octal field "${text}"`);
  return parseInt(text, 8);
}

function checksumOk(header: Uint8Array): boolean {
  const stored = readNumber(header, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const b = i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return stored === unsigned || stored === signed;
}

/** pax records: "<len> <key>=<value>\n" repeated. */
export function parsePax(body: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    let space = i;
    while (space < body.length && body[space] !== 0x20) space += 1;
    const len = Number(decoder.decode(body.subarray(i, space)));
    if (!Number.isInteger(len) || len <= 0 || i + len > body.length) break;
    const record = decoder.decode(body.subarray(space + 1, i + len - 1));
    const eq = record.indexOf('=');
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    i += len;
  }
  return out;
}

function normalizePath(path: string): string {
  let p = path;
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

export class TarParser {
  private state: State = 'header';
  private readonly headerBuf = new Uint8Array(BLOCK);
  private headerFill = 0;
  private zeroBlocks = 0;
  private current: TarHeader | null = null;
  /** typeflag of the entry whose body is being read (meta entries are consumed, not emitted). */
  private currentMeta: 'L' | 'x' | 'g' | null = null;
  private body: Uint8Array | null = null;
  private bodyFill = 0;
  private remaining = 0;
  private padding = 0;
  private longName: string | null = null;
  private pax: Map<string, string> | null = null;
  private readonly wantBody: (header: TarHeader) => boolean;
  /** Bytes pushed so far (for error messages). */
  offset = 0;
  /** Bytes parsed so far: equal to `offset` until the end-of-archive marker, then where the marker ends. */
  consumed = 0;

  constructor(options: TarParserOptions = {}) {
    this.wantBody = options.wantBody ?? ((header) => header.typeflag === '0');
  }

  /** True once the end-of-archive marker (two zero blocks) has been read. */
  isDone(): boolean {
    return this.state === 'done';
  }

  push(chunk: Uint8Array): TarEntry[] {
    const out: TarEntry[] = [];
    let i = 0;
    while (i < chunk.length && this.state !== 'done') {
      if (this.state === 'header') {
        const take = Math.min(BLOCK - this.headerFill, chunk.length - i);
        this.headerBuf.set(chunk.subarray(i, i + take), this.headerFill);
        this.headerFill += take;
        i += take;
        if (this.headerFill === BLOCK) {
          this.headerFill = 0;
          const entry = this.onHeader(this.offset + i - BLOCK);
          if (entry) out.push(entry);
        }
      } else if (this.state === 'body') {
        const take = Math.min(this.remaining, chunk.length - i);
        if (this.body) this.body.set(chunk.subarray(i, i + take), this.bodyFill);
        this.bodyFill += take;
        this.remaining -= take;
        i += take;
        if (this.remaining === 0) {
          const entry = this.onBodyEnd();
          if (entry) out.push(entry);
        }
      } else {
        const take = Math.min(this.padding, chunk.length - i);
        this.padding -= take;
        i += take;
        if (this.padding === 0) this.state = 'header';
      }
    }
    this.consumed += i;
    this.offset += chunk.length;
    return out;
  }

  /** Throws unless the archive ended cleanly with its end-of-archive marker. */
  finish(): void {
    if (this.state !== 'done') {
      const where = this.state === 'header' && this.headerFill === 0 ? 'before its end-of-archive marker' : `inside an entry (${this.state})`;
      throw new Error(`tar: stream ended ${where} after ${this.offset} bytes`);
    }
  }

  private onHeader(at: number): TarEntry | null {
    const h = this.headerBuf;
    if (h.every((b) => b === 0)) {
      this.zeroBlocks += 1;
      if (this.zeroBlocks === 2) this.state = 'done';
      return null;
    }
    if (this.zeroBlocks > 0) throw new Error(`tar: data after a zero block at byte ${at}`);
    if (!checksumOk(h)) throw new Error(`tar: bad header checksum at byte ${at}`);
    const rawFlag = String.fromCharCode(h[156] ?? 0);
    const typeflag = rawFlag === '\0' ? '0' : rawFlag;
    let size = readNumber(h, 124, 12);
    const magic = decoder.decode(h.subarray(257, 263));
    let path = cString(h, 0, 100);
    // POSIX ustar has a prefix field; GNU tar ("ustar  \0") uses those bytes for other things.
    if (magic === 'ustar\0') {
      const prefix = cString(h, 345, 155);
      if (prefix) path = `${prefix}/${path}`;
    }
    if (typeflag === 'L' || typeflag === 'x' || typeflag === 'g') {
      this.currentMeta = typeflag;
      this.current = { path, typeflag, size, mtime: 0 };
      this.body = new Uint8Array(size);
      return this.startBody(size);
    }
    if (this.longName !== null) path = this.longName;
    const paxPath = this.pax?.get('path');
    if (paxPath !== undefined) path = paxPath;
    const paxSize = this.pax?.get('size');
    if (paxSize !== undefined && /^\d+$/.test(paxSize)) size = Number(paxSize);
    this.longName = null;
    this.pax = null;
    this.currentMeta = null;
    // Hard links, symlinks and directories carry no data.
    if (typeflag === '1' || typeflag === '2' || typeflag === '5') size = 0;
    this.current = { path: normalizePath(path), typeflag, size, mtime: readNumber(h, 136, 12) };
    this.body = this.wantBody(this.current) ? new Uint8Array(size) : null;
    return this.startBody(size);
  }

  private startBody(size: number): TarEntry | null {
    this.bodyFill = 0;
    this.remaining = size;
    this.padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (size === 0) return this.onBodyEnd();
    this.state = 'body';
    return null;
  }

  private onBodyEnd(): TarEntry | null {
    this.state = this.padding > 0 ? 'padding' : 'header';
    const header = this.current;
    const body = this.body;
    this.current = null;
    this.body = null;
    if (!header) return null;
    if (this.currentMeta === 'L') {
      this.longName = body ? cString(body, 0, body.length) : '';
      this.currentMeta = null;
      return null;
    }
    if (this.currentMeta === 'x') {
      this.pax = body ? parsePax(body) : null;
      this.currentMeta = null;
      return null;
    }
    if (this.currentMeta === 'g') {
      this.currentMeta = null;
      return null;
    }
    return { ...header, body };
  }
}

/**
 * Entries of a tar stream, in order. Throws if the stream ends without the
 * end-of-archive marker. After the marker it still reads `source` to its
 * end (so a producer that hashes what it streams sees every byte) and
 * requires the rest to be zeros: tar pads its last record with zeros, and
 * anything else would be entries this reader skipped.
 */
export async function* readTar(source: AsyncIterable<Uint8Array>, options: TarParserOptions = {}): AsyncGenerator<TarEntry> {
  const parser = new TarParser(options);
  for await (const chunk of source) {
    if (parser.isDone()) {
      if (!chunk.every((b) => b === 0)) throw new Error(`tar: non-zero data after the end-of-archive marker (byte ${parser.offset})`);
      parser.offset += chunk.length;
      continue;
    }
    const before = parser.offset;
    for (const entry of parser.push(chunk)) yield entry;
    if (parser.isDone()) {
      // push() stops at the marker; the rest of this chunk is trailing padding.
      const used = parser.consumed - before;
      if (!chunk.subarray(used).every((b) => b === 0)) throw new Error(`tar: non-zero data after the end-of-archive marker (byte ${parser.consumed})`);
    }
  }
  parser.finish();
}
