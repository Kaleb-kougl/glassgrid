import { describe, expect, it } from 'vitest';
import { toFileHandle } from '../ids.js';
import {
  EngineRequestSchema,
  EngineResponseSchema,
  TableHandleSchema,
  isViewScopedRequest,
  tableIdForFile,
  type EngineRequest,
} from './engine.js';

const handle = toFileHandle('0b6c8f0e-6d0a-4f43-9d3e-2f1f1a0d9c11');
const table = tableIdForFile(handle);
const fingerprint = { sizeBytes: 10, mtimeMs: 1, headTailSha256: 'a'.repeat(64), key: 'b'.repeat(32) };

describe('table ids', () => {
  it('derive deterministically from file handles', () => {
    expect(table).toBe('tb_0b6c8f0e-6d0a-4f43-9d3e-2f1f1a0d9c11');
    expect(tableIdForFile(handle)).toBe(table);
  });
});

describe('EngineRequestSchema', () => {
  it('accepts open, rows, count, profile, aggregate, cancel and cache requests', () => {
    const requests: EngineRequest[] = [
      { kind: 'open', requestId: 'r1', file: handle },
      { kind: 'open', requestId: 'r1', file: handle, parquet: 'always' },
      {
        kind: 'rows',
        requestId: 'r2',
        viewId: 'grid',
        seq: 3,
        table,
        query: { offset: 0, limit: 1000, sort: [{ column: 'a b', direction: 'desc' }] },
      },
      { kind: 'count', requestId: 'r3', viewId: 'grid', seq: 4, table },
      {
        kind: 'count',
        requestId: 'r3b',
        viewId: 'status',
        seq: 5,
        table,
        filters: [{ kind: 'range', column: 'amount', min: 1, minInclusive: true, maxInclusive: false }],
      },
      { kind: 'profile', requestId: 'r4', viewId: 'profile', seq: 0, table },
      {
        kind: 'aggregate',
        requestId: 'r5',
        viewId: 'chart:1',
        seq: 1,
        table,
        spec: { mark: 'bar', x: { column: 'category' }, filters: [], pixelWidth: 640 },
      },
      { kind: 'cancel', requestId: 'r6', target: 'r2' },
      { kind: 'ensureParquetCache', requestId: 'r7', table },
      { kind: 'clearCache', requestId: 'r8', scope: 'parquet' },
      { kind: 'cacheStats', requestId: 'r9' },
    ];
    for (const request of requests) expect(EngineRequestSchema.parse(request)).toEqual(request);
  });

  it('marks only query requests as view scoped', () => {
    expect(isViewScopedRequest({ kind: 'count', requestId: 'r', viewId: 'v', seq: 1, table })).toBe(true);
    expect(isViewScopedRequest({ kind: 'open', requestId: 'r', file: handle })).toBe(false);
    expect(isViewScopedRequest({ kind: 'cancel', requestId: 'r', target: 'x' })).toBe(false);
  });

  it('rejects a raw filesystem path in place of a handle or table id', () => {
    expect(EngineRequestSchema.safeParse({ kind: 'open', requestId: 'r1', file: '/etc/passwd' }).success).toBe(false);
    expect(
      EngineRequestSchema.safeParse({ kind: 'count', requestId: 'r1', viewId: 'v', seq: 1, table: '/etc/passwd' }).success,
    ).toBe(false);
  });

  it('caps pages at 1,000 rows and rejects negative offsets', () => {
    const base = { kind: 'rows', requestId: 'r1', viewId: 'grid', seq: 1, table };
    expect(EngineRequestSchema.safeParse({ ...base, query: { offset: 0, limit: 1001 } }).success).toBe(false);
    expect(EngineRequestSchema.safeParse({ ...base, query: { offset: -1, limit: 10 } }).success).toBe(false);
    expect(EngineRequestSchema.safeParse({ ...base, query: { offset: 0, limit: 0 } }).success).toBe(false);
  });

  it('requires view id and sequence on query requests', () => {
    expect(EngineRequestSchema.safeParse({ kind: 'count', requestId: 'r1', table }).success).toBe(false);
    expect(EngineRequestSchema.safeParse({ kind: 'count', requestId: 'r1', viewId: 'v', seq: 1.5, table }).success).toBe(
      false,
    );
  });

  it('carries no SQL: unknown fields such as `where` are stripped', () => {
    const parsed = EngineRequestSchema.parse({
      kind: 'count',
      requestId: 'r1',
      viewId: 'v',
      seq: 1,
      table,
      where: { sql: '1=1; DROP TABLE x', params: [] },
    });
    expect('where' in parsed).toBe(false);
  });

  it('validates filters on rows and count requests', () => {
    const base = { kind: 'rows', requestId: 'r1', viewId: 'grid', seq: 1, table, query: { offset: 0, limit: 10 } };
    const parsed = EngineRequestSchema.parse({ ...base, filters: [{ kind: 'in', column: 'c', values: ['a', null] }] });
    expect(parsed.kind === 'rows' && parsed.filters).toEqual([{ kind: 'in', column: 'c', values: ['a', null] }]);
    expect(EngineRequestSchema.safeParse({ ...base, filters: [{ kind: 'range', column: 'c' }] }).success).toBe(false);
    expect(EngineRequestSchema.safeParse({ ...base, filters: [{ kind: 'sql', text: '1=1' }] }).success).toBe(false);
  });

  it('requires a real chart spec on aggregate requests', () => {
    const base = { kind: 'aggregate', requestId: 'r1', viewId: 'chart:1', seq: 1, table };
    const parsed = EngineRequestSchema.parse({ ...base, spec: { mark: 'histogram', x: { column: 'amount' } } });
    expect(parsed.kind === 'aggregate' && parsed.spec).toEqual({ mark: 'histogram', x: { column: 'amount' }, filters: [] });
    expect(EngineRequestSchema.safeParse({ ...base, spec: { mark: 'bar' } }).success).toBe(false);
    expect(EngineRequestSchema.safeParse({ ...base, spec: { mark: 'pie', x: { column: 'a' } } }).success).toBe(false);
    expect(
      EngineRequestSchema.safeParse({ ...base, spec: { mark: 'line', x: { column: 'a' }, pixelWidth: 0 } }).success,
    ).toBe(false);
    expect(EngineRequestSchema.safeParse({ ...base, spec: { mark: 'bar', x: { column: 'a' }, sql: 'x' } }).success).toBe(false);
  });

  it('accepts concurrent grid pages and type override requests', () => {
    const page = { kind: 'rows', requestId: 'p', viewId: 'grid', seq: 0, table, query: { offset: 0, limit: 1000 }, concurrent: true };
    expect(EngineRequestSchema.parse(page)).toEqual(page);
    expect(isViewScopedRequest(EngineRequestSchema.parse(page))).toBe(true);

    const types = { kind: 'setColumnTypes', requestId: 't', table, overrides: [{ column: 'a b', type: 'integer' }] };
    expect(EngineRequestSchema.parse(types)).toEqual(types);
    expect(isViewScopedRequest(EngineRequestSchema.parse(types))).toBe(false);
    expect(EngineRequestSchema.parse({ ...types, overrides: [] }).kind).toBe('setColumnTypes');
  });

  it('rejects malformed type overrides', () => {
    const base = { kind: 'setColumnTypes', requestId: 't', table };
    const dup = [
      { column: 'a', type: 'integer' },
      { column: 'a', type: 'text' },
    ];
    expect(EngineRequestSchema.safeParse({ ...base, overrides: dup }).success).toBe(false);
    expect(EngineRequestSchema.safeParse({ ...base, overrides: [{ column: 'a', type: 'time' }] }).success).toBe(false);
    expect(EngineRequestSchema.safeParse({ ...base, overrides: [{ column: '', type: 'text' }] }).success).toBe(false);
    expect(EngineRequestSchema.safeParse({ ...base, overrides: [{ column: 'a', type: 'text', sql: 'x' }] }).data).toEqual({
      ...base,
      overrides: [{ column: 'a', type: 'text' }],
    });
  });

  it('rejects unknown request kinds and empty request ids', () => {
    expect(EngineRequestSchema.safeParse({ kind: 'dropTable', requestId: 'r1', table }).success).toBe(false);
    expect(EngineRequestSchema.safeParse({ kind: 'cacheStats', requestId: '' }).success).toBe(false);
  });
});

describe('EngineResponseSchema', () => {
  it('accepts an Arrow result carrying IPC bytes', () => {
    const ipc = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const parsed = EngineResponseSchema.parse({ kind: 'arrow', requestId: 'r1', ipc, engineMs: 12.5, cached: false });
    expect(parsed.kind).toBe('arrow');
    if (parsed.kind === 'arrow') expect(parsed.ipc).toBe(ipc);
  });

  it('rejects an Arrow result whose payload is not bytes, or negative timings', () => {
    const base = { kind: 'arrow', requestId: 'r1', cached: false };
    expect(EngineResponseSchema.safeParse({ ...base, ipc: [1, 2, 3], engineMs: 1 }).success).toBe(false);
    expect(EngineResponseSchema.safeParse({ ...base, ipc: new Uint8Array(), engineMs: -1 }).success).toBe(false);
  });

  it('accepts table handles, profiles, counts and events', () => {
    const tableHandle = TableHandleSchema.parse({
      id: table,
      file: handle,
      fileName: 'data.csv',
      fingerprint,
      usingParquetCache: false,
      columns: [{ name: 'id', type: 'integer', duckdbType: 'BIGINT' }],
    });
    expect(EngineResponseSchema.parse({ kind: 'opened', requestId: 'r', table: tableHandle, engineMs: 1 }).kind).toBe(
      'opened',
    );
    expect(
      EngineResponseSchema.parse({
        kind: 'profile',
        requestId: 'r',
        rowCount: 2,
        engineMs: 1,
        cached: true,
        columns: [
          { name: 'id', type: 'integer', duckdbType: 'BIGINT', nullFraction: 0.5, distinctCount: 1, min: 1, max: 1 },
        ],
      }).kind,
    ).toBe('profile');
    expect(EngineResponseSchema.parse({ kind: 'count', requestId: 'r', rowCount: 5, engineMs: 0, cached: false }).kind).toBe(
      'count',
    );
    expect(
      EngineResponseSchema.parse({ kind: 'event', event: { type: 'parquetProgress', table, fraction: 0.5 } }).kind,
    ).toBe('event');
    expect(
      EngineResponseSchema.safeParse({ kind: 'event', event: { type: 'parquetProgress', table, fraction: 2 } }).success,
    ).toBe(false);
  });

  it('accepts columnTypes results and handles with type overrides', () => {
    const tableHandle = {
      id: table,
      file: handle,
      fileName: 'data.csv',
      fingerprint,
      usingParquetCache: true,
      columns: [{ name: 'code', type: 'integer', duckdbType: 'BIGINT' }],
      typeOverrides: [{ column: 'code', type: 'integer' }],
    };
    const reply = {
      kind: 'columnTypes',
      requestId: 't',
      table: tableHandle,
      columns: [{ column: 'code', type: 'integer', duckdbType: 'BIGINT', failedCasts: 3 }],
      engineMs: 5,
    };
    expect(EngineResponseSchema.parse(reply)).toEqual(reply);
    expect(
      EngineResponseSchema.safeParse({ ...reply, columns: [{ column: 'code', type: 'integer', duckdbType: 'BIGINT', failedCasts: -1 }] })
        .success,
    ).toBe(false);
  });

  it('accepts aggregate results with the effective mark and fallback flag', () => {
    const ipc = new Uint8Array([1]);
    const reply = { kind: 'aggregate', requestId: 'r', ipc, mark: 'heatmap', fellBackToHeatmap: true, engineMs: 1, cached: false };
    expect(EngineResponseSchema.parse(reply)).toEqual(reply);
    expect(EngineResponseSchema.safeParse({ ...reply, mark: 'pie' }).success).toBe(false);
  });

  it('carries the compiler path on bad_request errors', () => {
    const error = { kind: 'error', requestId: 'r', code: 'bad_request', message: 'y.aggregate ...', path: 'y.aggregate' };
    expect(EngineResponseSchema.parse(error)).toEqual(error);
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
