/**
 * Builds tar archives byte by byte for the tar reader and globe-history
 * tests (GNU or POSIX headers, GNU long names), so the tests need no tar
 * binary and no fixtures on disk.
 */

const enc = new TextEncoder();

/** `bytes` as an async stream of `size`-byte chunks, one microtask apart (as network reads arrive). */
export async function* chunksOf(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) {
    await Promise.resolve();
    yield bytes.subarray(i, i + size);
  }
}

export interface FileSpec {
  path: string;
  body: Uint8Array;
  typeflag?: string;
}

export function header(path: string, size: number, typeflag: string, gnu: boolean): Uint8Array {
  const h = new Uint8Array(512);
  const put = (text: string, at: number) => h.set(enc.encode(text), at);
  const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, '0');
  put(path.slice(0, 100), 0);
  put('0000644\0', 100);
  put('0000000\0', 108);
  put('0000000\0', 116);
  put(`${octal(size, 12)}\0`, 124);
  put(`${octal(1762646400, 12)}\0`, 136);
  put('        ', 148);
  put(typeflag, 156);
  put(gnu ? 'ustar  \0' : 'ustar\u000000', 257);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${octal(sum, 7)}\0 `, 148);
  return h;
}

function padded(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(body.length / 512) * 512);
  out.set(body);
  return out;
}

/** A GNU-style tar of `files` (long names through `././@LongLink` entries), with the end-of-archive marker. */
export function makeTar(files: readonly FileSpec[], { gnu = true, endBlocks = 2 } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const file of files) {
    if (file.path.length > 100) {
      const name = enc.encode(`${file.path}\0`);
      parts.push(header('././@LongLink', name.length, 'L', gnu), padded(name));
    }
    parts.push(header(file.path, file.body.length, file.typeflag ?? '0', gnu), padded(file.body));
  }
  parts.push(new Uint8Array(512 * endBlocks));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

