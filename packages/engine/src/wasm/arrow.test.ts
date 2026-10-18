import { Binary, Dictionary, Int32, Table, Utf8, tableFromIPC, tableToIPC, vectorFromArray } from 'apache-arrow';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeIpc, textVector } from './arrow';

/*
 * The web demo sends a Content-Security-Policy header without
 * 'unsafe-eval', and a dedicated worker runs under the policy of its own
 * script, so the engine worker may not generate code. Arrow's builders do
 * (`new Function` for their null check, whenever `nullValues` is set, as in
 * `vectorFromArray`). These tests run normalizeIpc with `Function` replaced
 * by one that throws, as a browser does under that policy.
 */

const RealFunction = globalThis.Function;

function forbidCodegen(): void {
  const refuse = () => {
    throw new EvalError("Refused to evaluate a string as JavaScript: 'unsafe-eval' is not allowed");
  };
  globalThis.Function = new Proxy(RealFunction, { construct: refuse, apply: refuse });
}

afterEach(() => {
  globalThis.Function = RealFunction;
});

describe('Arrow normalization without code generation (header CSP in the worker)', () => {
  it('the guard catches what the browser refuses: vectorFromArray with nulls', () => {
    forbidCodegen();
    expect(() => vectorFromArray(['a', null], new Utf8())).toThrow(EvalError);
  });

  it('textVector builds a Utf8 vector with nulls and no codegen', () => {
    forbidCodegen();
    const vector = textVector(['a', null, '', 'ü']);
    globalThis.Function = RealFunction;
    expect(vector.type).toBeInstanceOf(Utf8);
    expect([...vector]).toEqual(['a', null, '', 'ü']);
    expect(vector.nullCount).toBe(1);
  });

  it('normalizeIpc re-encodes non-canonical columns (dictionary, binary) as text with no codegen', () => {
    const ipc = tableToIPC(
      new Table({
        mood: vectorFromArray(['calm', null, 'busy'], new Dictionary(new Utf8(), new Int32())),
        payload: vectorFromArray([new Uint8Array([0x61, 0x62]), null, new Uint8Array([0x00])], new Binary()),
      }),
      'stream',
    );
    forbidCodegen();
    const normalized = normalizeIpc(ipc);
    globalThis.Function = RealFunction;
    const table = tableFromIPC(normalized);
    expect(table.schema.fields.map((field) => String(field.type))).toEqual(['Utf8', 'Utf8']);
    expect([...(table.getChild('mood') ?? [])]).toEqual(['calm', null, 'busy']);
    expect([...(table.getChild('payload') ?? [])]).toEqual(['ab', null, '\\x00']);
  });
});
