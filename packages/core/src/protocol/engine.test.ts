import { describe, expect, it } from 'vitest';
import { toFileHandle } from '../ids.js';
import { EngineRequestSchema, EngineResponseSchema } from './engine.js';

const handle = toFileHandle('0b6c8f0e-6d0a-4f43-9d3e-2f1f1a0d9c11');

describe('EngineRequestSchema', () => {
  it('accepts a well-formed countRows request', () => {
    const parsed = EngineRequestSchema.parse({ kind: 'countRows', requestId: 'r1', handle });
    expect(parsed).toEqual({ kind: 'countRows', requestId: 'r1', handle });
  });

  it('rejects a raw filesystem path in place of a handle', () => {
    const result = EngineRequestSchema.safeParse({
      kind: 'countRows',
      requestId: 'r1',
      handle: '/etc/passwd',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown request kinds', () => {
    const result = EngineRequestSchema.safeParse({ kind: 'dropTable', requestId: 'r1', handle });
    expect(result.success).toBe(false);
  });

  it('rejects an empty request id', () => {
    const result = EngineRequestSchema.safeParse({ kind: 'countRows', requestId: '', handle });
    expect(result.success).toBe(false);
  });
});

describe('EngineResponseSchema', () => {
  it('accepts an Arrow result carrying IPC bytes', () => {
    const ipc = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const parsed = EngineResponseSchema.parse({ kind: 'arrow', requestId: 'r1', ipc, engineMs: 12.5 });
    expect(parsed.kind).toBe('arrow');
    if (parsed.kind === 'arrow') expect(parsed.ipc).toBe(ipc);
  });

  it('rejects an Arrow result whose payload is not bytes', () => {
    const result = EngineResponseSchema.safeParse({
      kind: 'arrow',
      requestId: 'r1',
      ipc: [1, 2, 3],
      engineMs: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative timings', () => {
    const result = EngineResponseSchema.safeParse({
      kind: 'arrow',
      requestId: 'r1',
      ipc: new Uint8Array(),
      engineMs: -1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an error without a request id (e.g. unparseable request)', () => {
    const parsed = EngineResponseSchema.parse({
      kind: 'error',
      requestId: null,
      code: 'bad_request',
      message: 'nope',
    });
    expect(parsed.kind).toBe('error');
  });
});
