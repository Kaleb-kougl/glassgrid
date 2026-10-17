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
        filters: { chart_1: { kind: 'range', column: 'amount', min: 0 } },
      }),
    );
    expect(parsed.charts[0]?.spec.filters).toEqual([]);
    expect(parsed.filters['chart_1']).toEqual({
      kind: 'range',
      column: 'amount',
      min: 0,
      minInclusive: true,
      maxInclusive: true,
    });
  });

  it('rejects specs and filters the compiler would not accept', () => {
    expect(WorkspaceStateSchema.safeParse(workspace({ charts: [{ id: 'c1', spec: { mark: 'pie', x: { column: 'a' } } }] })).success).toBe(false);
    expect(WorkspaceStateSchema.safeParse(workspace({ filters: { grid: { kind: 'range', column: 'a' } } })).success).toBe(false);
  });

  it('uses the engine fingerprint shape', () => {
    const legacy = { sizeBytes: 10, mtimeMs: 1, sampleHash: 'abc' };
    const bad = workspace({});
    bad.dataSource = { ...bad.dataSource, fingerprint: legacy as unknown as typeof fingerprint };
    expect(WorkspaceStateSchema.safeParse(bad).success).toBe(false);
  });
});
