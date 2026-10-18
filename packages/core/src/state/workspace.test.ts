import { describe, expect, it } from 'vitest';
import { createInitialWorkspaceState, WorkspaceStateSchema } from './workspace.js';

const fingerprint = { sizeBytes: 10, mtimeMs: 1, headTailSha256: 'a'.repeat(64), key: 'b'.repeat(32) };

function workspace(overrides: Record<string, unknown>) {
  return {
    ...createInitialWorkspaceState(),
    dataSource: { handleId: 'fh_0123456789abcdef', fileName: 'trips.csv', fingerprint },
    columns: [{ name: 'amount', inferredType: 'float', typeOverride: null }],
    ...overrides,
  };
}

describe('WorkspaceStateSchema', () => {
  it('accepts real chart specs and filters, applying their defaults', () => {
    const parsed = WorkspaceStateSchema.parse(
      workspace({
        charts: [{ id: 'chart_1', spec: { mark: 'histogram', x: { column: 'amount', bin: 'auto' } } }],
        selections: { chart_1: { source: 'brush', clauses: [{ channel: 'x', filter: { kind: 'range', column: 'amount', min: 0 } }] } },
        userFilters: [{ id: 'filter_1', filter: { kind: 'notIn', column: 'amount', values: [1] } }],
      }),
    );
    expect(parsed.charts[0]?.spec.filters).toEqual([]);
    expect(parsed.selections['chart_1']?.clauses[0]?.filter).toEqual({
      kind: 'range',
      column: 'amount',
      min: 0,
      minInclusive: true,
      maxInclusive: true,
    });
  });

  it('rejects specs and filters the compiler would not accept', () => {
    expect(WorkspaceStateSchema.safeParse(workspace({ charts: [{ id: 'c1', spec: { mark: 'pie', x: { column: 'a' } } }] })).success).toBe(false);
    const clause = (filter: unknown) => ({ grid: { source: 'filter', clauses: [{ channel: null, filter }] } });
    expect(WorkspaceStateSchema.safeParse(workspace({ selections: clause({ kind: 'range', column: 'a' }) })).success).toBe(false);
    expect(WorkspaceStateSchema.safeParse(workspace({ selections: { grid: { source: 'filter', clauses: [] } } })).success).toBe(false);
    expect(WorkspaceStateSchema.safeParse(workspace({ selections: { __proto__x: clause({ kind: 'isNull', column: 'a' }).grid } })).success).toBe(false);
    expect(WorkspaceStateSchema.safeParse(workspace({ userFilters: [{ id: 'f', filter: { kind: 'in', column: 'a', values: [] }, extra: 1 }] })).success).toBe(false);
  });

  it('keeps a column profile summary only in its strict shape', () => {
    const profile = { type: 'float', distinctCount: 3, nullFraction: 0.5, min: 0, max: 9.5 };
    const parsed = WorkspaceStateSchema.parse(workspace({ columns: [{ name: 'amount', inferredType: 'float', typeOverride: null, profile }] }));
    expect(parsed.columns[0]?.profile).toEqual(profile);
    expect(
      WorkspaceStateSchema.safeParse(workspace({ columns: [{ name: 'amount', inferredType: 'float', typeOverride: null, profile: { ...profile, distinctCount: -1 } }] })).success,
    ).toBe(false);
  });

  it('uses the engine fingerprint shape', () => {
    const legacy = { sizeBytes: 10, mtimeMs: 1, sampleHash: 'abc' };
    const bad = workspace({});
    bad.dataSource = { ...bad.dataSource, fingerprint: legacy as unknown as typeof fingerprint };
    expect(WorkspaceStateSchema.safeParse(bad).success).toBe(false);
  });
});
