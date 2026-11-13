import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readNumber, readTar, TarParser } from './tar.ts';
import { chunksOf, header, makeTar } from './test-support.ts';

/*
 * The streaming tar reader against archives built here byte by byte (GNU and
 * POSIX headers, long names, pax), split into arbitrary chunks: the entries
 * must not depend on where the chunk boundaries fall.
 */

const enc = new TextEncoder();

function chunked(bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
  const out: Uint8Array[] = [];
  let prev = 0;
  for (const p of [...points, bytes.length]) {
    out.push(bytes.subarray(prev, p));
    prev = p;
  }
  return out;
}

function parseAll(chunks: readonly Uint8Array[], wantBody?: (h: { path: string }) => boolean) {
  const parser = new TarParser(wantBody ? { wantBody } : {});
  const entries = chunks.flatMap((c) => parser.push(c));
  parser.finish();
  return entries;
}

describe('TarParser', () => {
  it('reads files and directories, strips ./ and skips unwanted bodies', () => {
    const tar = makeTar([
      { path: './', body: new Uint8Array(), typeflag: '5' },
      { path: './heatmap/13.bin.ttf', body: new Uint8Array(1000).fill(7) },
      { path: './traces/c0/trace_full_a1b2c0.json', body: enc.encode('{"icao":"a1b2c0"}') },
    ]);
    const entries = parseAll([tar], (h) => h.path.startsWith('traces/'));
    expect(entries.map((e) => [e.path, e.typeflag, e.size, e.body === null])).toEqual([
      ['', '5', 0, true],
      ['heatmap/13.bin.ttf', '0', 1000, true],
      ['traces/c0/trace_full_a1b2c0.json', '0', 17, false],
    ]);
    expect(new TextDecoder().decode(entries[2]?.body ?? new Uint8Array())).toBe('{"icao":"a1b2c0"}');
    expect(entries[1]?.mtime).toBe(1762646400);
  });

  it('takes long names from GNU L entries and paths and sizes from pax headers', () => {
    const long = `traces/${'x'.repeat(150)}.json`;
    const pax = enc.encode('32 path=traces/pax/renamed.json\n'); // 32 = the record's own length, digits included
    const tar = makeTar([
      { path: long, body: enc.encode('long') },
      { path: 'PaxHeaders/1', body: pax, typeflag: 'x' },
      { path: 'short-name', body: enc.encode('pax!') },
    ]);
    const entries = parseAll([tar]);
    expect(entries.map((e) => e.path)).toEqual([long, 'traces/pax/renamed.json']);
  });

  it('joins the POSIX ustar prefix field', () => {
    const h = header('name.json', 0, '0', false);
    h.set(enc.encode('deep/dir'), 345);
    // Fix the checksum after editing the header.
    h.set(enc.encode('        '), 148);
    let sum = 0;
    for (const b of h) sum += b;
    h.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
    const tar = new Uint8Array(512 * 3);
    tar.set(h);
    expect(parseAll([tar]).map((e) => e.path)).toEqual(['deep/dir/name.json']);
  });

  it('fails on a truncated archive, a missing end marker or a corrupt header', () => {
    const tar = makeTar([{ path: 'a', body: new Uint8Array(700) }]);
    expect(() => parseAll([tar.subarray(0, 900)])).toThrow(/inside an entry/);
    expect(() => parseAll([makeTar([{ path: 'a', body: new Uint8Array(3) }], { endBlocks: 0 })])).toThrow(/end-of-archive/);
    const corrupt = tar.slice();
    corrupt[10] = 0x41;
    expect(() => parseAll([corrupt])).toThrow(/checksum/);
  });

  it('reads GNU base-256 sizes', () => {
    const field = new Uint8Array(12);
    field[0] = 0x80;
    field[8] = 0x01; // 2^24
    expect(readNumber(field, 0, 12)).toBe(2 ** 24);
  });

  it('gives the same entries however the stream is chunked (property)', () => {
    const fileArb = fc.record({
      path: fc.stringMatching(/^[a-z0-9_/.]{1,140}$/),
      body: fc.uint8Array({ maxLength: 1500 }),
    });
    fc.assert(
      fc.property(fc.array(fileArb, { maxLength: 6 }), fc.array(fc.nat(), { maxLength: 20 }), fc.boolean(), (files, cuts, gnu) => {
        const tar = makeTar(files, { gnu });
        const whole = parseAll([tar]);
        const pieces = parseAll(chunked(tar, cuts));
        expect(pieces).toEqual(whole);
        expect(whole.map((e) => [e.path, Array.from(e.body ?? [])])).toEqual(
          files.map((f) => [f.path.replace(/^(\.\/)+/, ''), Array.from(f.body)]),
        );
      }),
      { seed: 20261110, numRuns: 300 },
    );
  });

  it('readTar reads the zero padding after the end marker to the end, and rejects anything else there', async () => {
    const tar = makeTar([{ path: 'a.json', body: enc.encode('{}') }]);
    let drained = false;
    async function* source(trailing: Uint8Array) {
      yield* chunksOf(tar, 700);
      yield trailing; // record padding after the marker
      drained = true;
    }
    const paths: string[] = [];
    for await (const entry of readTar(source(new Uint8Array(10240)))) paths.push(entry.path);
    expect(paths).toEqual(['a.json']);
    expect(drained).toBe(true);

    const extra = makeTar([{ path: 'b.json', body: enc.encode('{}') }]);
    const drain = async () => {
      for await (const entry of readTar(source(extra))) paths.push(entry.path);
    };
    await expect(drain()).rejects.toThrow(/after the end-of-archive marker/);
  });
});
