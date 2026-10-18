import { describe, expect, it } from 'vitest';
import { createInitialWorkspaceState, type WorkspaceState } from '../state/workspace.js';
import { canonicalJson, digestString } from './digest.js';
import { isWorkspaceFileError, type WorkspaceFileError } from './errors.js';
import { parseWorkspace, serializeWorkspace, toWorkspaceFile, WorkspaceFileSchema } from './format.js';
import { CURRENT_FORMAT_VERSION, migrateWorkspaceFile, type Migration } from './migrations.js';
import {
  isWorkspaceDirty,
  persistedDigest,
  persistedWorkspace,
  restoreWorkspace,
  snapshotWorkspace,
  type PersistedWorkspace,
} from './persisted.js';
import { must, SAVE_META, taxiData, taxiWorkspace } from './test-support.js';

function expectFileError(run: () => unknown, code: WorkspaceFileError['code']): WorkspaceFileError {
  try {
    run();
  } catch (error) {
    expect(isWorkspaceFileError(error)).toBe(true);
    expect((error as WorkspaceFileError).code).toBe(code);
    return error as WorkspaceFileError;
  }
  throw new Error(`expected a WorkspaceFileError (${code})`);
}

const DOC = { id: 'doc_0123456789', fileName: 'trips.glassgrid', savedDigest: null };

describe('digest', () => {
  it('canonical JSON ignores key order and undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: undefined }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"z":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('digests are 16 hex digits and change with the text', () => {
    expect(digestString('')).toMatch(/^[0-9a-f]{16}$/);
    expect(digestString('a')).not.toBe(digestString('b'));
    expect(digestString('ab')).not.toBe(digestString('ba'));
    expect(digestString('hello')).toBe(digestString('hello'));
  });
});

describe('persisted subset', () => {
  it('keeps the work and drops profiles, the grid selection, the handle and the document', () => {
    const state = { ...taxiWorkspace(), document: { ...DOC, savedDigest: '0123456789abcdef' } };
    const persisted = persistedWorkspace(state);
    expect(Object.keys(persisted)).toEqual(['columns', 'charts', 'selections', 'userFilters', 'grid', 'layout']);
    expect(persisted.columns.every((column) => !('profile' in column))).toBe(true);
    expect(persisted.columns.find((column) => column.name === 'vendor_id')).toEqual({ name: 'vendor_id', inferredType: 'integer', typeOverride: 'text' });
    expect(persisted.grid).toEqual({ sort: state.grid.sort, columnOrder: state.grid.columnOrder, columnWidths: state.grid.columnWidths });
    expect(persisted.selections).toEqual(state.selections);
    expect(persisted.userFilters).toEqual(state.userFilters);
    expect(persisted.charts).toEqual(state.charts);
    expect(JSON.stringify(persisted)).not.toContain('fh_');
  });

  it('does not alias the (frozen) state', () => {
    const state = taxiWorkspace();
    const persisted = persistedWorkspace(state);
    must(persisted.charts[0]).spec.x.column = 'changed';
    expect(must(state.charts[0]).spec.x.column).toBe('pickup_at');
  });

  it('snapshots need an open file', () => {
    expect(() => snapshotWorkspace(createInitialWorkspaceState())).toThrow(/No file is open/);
    expect(snapshotWorkspace(taxiWorkspace()).dataSource.handleId).toBe('fh_0123456789abcdef');
  });
});

describe('dirty', () => {
  const base = taxiWorkspace();
  const saved: WorkspaceState = { ...base, document: { ...DOC, savedDigest: persistedDigest(base) } };

  it('an empty workspace is never dirty; open data without a saved digest always is', () => {
    expect(isWorkspaceDirty(createInitialWorkspaceState())).toBe(false);
    expect(isWorkspaceDirty(base)).toBe(true);
    expect(isWorkspaceDirty({ ...base, document: DOC })).toBe(true);
  });

  it('only changes to the persisted subset count', () => {
    expect(isWorkspaceDirty(saved)).toBe(false);
    expect(isWorkspaceDirty({ ...saved, grid: { ...saved.grid, selection: null } })).toBe(false);
    expect(isWorkspaceDirty({ ...saved, columns: saved.columns.map(({ profile: _profile, ...column }) => column) })).toBe(false);
    expect(isWorkspaceDirty({ ...saved, dataSource: { ...must(saved.dataSource), handleId: 'fh_aaaaaaaaaaaaaaaa' as never } })).toBe(false);
    expect(isWorkspaceDirty({ ...saved, grid: { ...saved.grid, sort: [] } })).toBe(true);
    expect(isWorkspaceDirty({ ...saved, selections: {} })).toBe(true);
    expect(isWorkspaceDirty({ ...saved, charts: saved.charts.map((chart, i) => (i === 0 ? { ...chart, title: 'Renamed' } : chart)) })).toBe(true);
  });
});

describe('serializeWorkspace / parseWorkspace', () => {
  it('round-trips the persisted subset with the data reference', () => {
    const state = taxiWorkspace();
    const text = serializeWorkspace(state, SAVE_META);
    expect(text.endsWith('}\n')).toBe(true);
    const parsed = parseWorkspace(text);
    expect(parsed.migratedFrom).toBeNull();
    expect(parsed.warnings).toEqual([]);
    expect(parsed.workspace).toEqual(persistedWorkspace(state));
    expect(parsed.data).toEqual({
      fileName: 'trips 2026.csv',
      absolutePath: SAVE_META.absolutePath,
      relativePath: SAVE_META.relativePath,
      fingerprint: must(state.dataSource).fingerprint,
    });
    expect(parsed.file).toMatchObject({ formatVersion: 1, app: SAVE_META.app, savedAt: SAVE_META.savedAt });
    expect(parsed.file.recoveryOf).toBeUndefined();
  });

  it('writes keys in a fixed order, so saving twice gives the same bytes', () => {
    const text = serializeWorkspace(taxiWorkspace(), SAVE_META);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['formatVersion', 'app', 'savedAt', 'data', 'workspace']);
    expect(serializeWorkspace(snapshotWorkspace(taxiWorkspace()), SAVE_META)).toBe(text);
    expect(serializeWorkspace({ dataSource: must(taxiWorkspace().dataSource), workspace: parseWorkspace(text).workspace }, SAVE_META)).toBe(text);
  });

  it('never writes data rows, profiles, the grid selection or the handle', () => {
    const text = serializeWorkspace(taxiWorkspace(), SAVE_META);
    expect(text).not.toContain('profile');
    expect(text).not.toContain('"selection"');
    expect(text).not.toContain('anchor');
    expect(text).not.toContain('handleId');
    expect(text).not.toContain('fh_');
  });

  it('records recovery metadata only when asked', () => {
    const text = serializeWorkspace(taxiWorkspace(), { ...SAVE_META, relativePath: null, recoveryOf: { workspacePath: null } });
    expect(parseWorkspace(text).file.recoveryOf).toEqual({ workspacePath: null });
    expect(parseWorkspace(text).data.relativePath).toBeNull();
  });

  it('refuses to write a workspace that would not load', () => {
    const snapshot = snapshotWorkspace(taxiWorkspace());
    const broken = { ...snapshot, workspace: { ...snapshot.workspace, charts: [...snapshot.workspace.charts, must(snapshot.workspace.charts[0])] } };
    const error = expectFileError(() => toWorkspaceFile(broken, SAVE_META), 'invalid_file');
    expect(error.issues[0]?.message).toMatch(/appears twice/);
    expectFileError(() => toWorkspaceFile(taxiWorkspace(), { ...SAVE_META, savedAt: 'yesterday' }), 'invalid_file');
  });

  it('gives clear errors for files it cannot read', () => {
    expectFileError(() => parseWorkspace('{"formatVersion": 1,'), 'invalid_json');
    expectFileError(() => parseWorkspace('[1, 2]'), 'not_a_workspace');
    expectFileError(() => parseWorkspace('{"workspace": {}}'), 'not_a_workspace');
    expectFileError(() => parseWorkspace('{"formatVersion": "1"}'), 'not_a_workspace');
    expectFileError(() => parseWorkspace('{"formatVersion": 1.5}'), 'not_a_workspace');
    const newer = expectFileError(() => parseWorkspace('{"formatVersion": 2, "anything": true}'), 'newer_version');
    expect(newer.message).toMatch(/newer version of Glassgrid \(format 2; this version reads up to 1\)/);
    const invalid = expectFileError(() => parseWorkspace('{"formatVersion": 1}'), 'invalid_file');
    expect(invalid.issues.map((issue) => issue.path)).toContain('app');
  });

  it('names the failing path in invalid files', () => {
    const file = JSON.parse(serializeWorkspace(taxiWorkspace(), SAVE_META)) as { workspace: { charts: { spec: { mark: string } }[] } };
    must(file.workspace.charts[1]).spec.mark = 'pie';
    const error = expectFileError(() => parseWorkspace(JSON.stringify(file)), 'invalid_file');
    expect(error.issues[0]?.path).toBe('workspace.charts[1].spec.mark');
  });

  it('rejects unknown keys and never lets a view id become a prototype key', () => {
    const file = JSON.parse(serializeWorkspace(taxiWorkspace(), SAVE_META)) as Record<string, unknown>;
    expectFileError(() => parseWorkspace({ ...file, rows: [[1, 2]] }), 'invalid_file');
    const text = serializeWorkspace(taxiWorkspace(), SAVE_META).replace('"chart_2": {', '"__proto__": {');
    // Zod skips a "__proto__" record key; the selection is dropped, nothing is polluted.
    const { workspace } = parseWorkspace(text);
    expect(Object.keys(workspace.selections).sort()).toEqual(['chart_3', 'grid']);
    expect(Object.getPrototypeOf(workspace.selections)).toBe(Object.prototype);
  });

  it('accepts a byte order mark', () => {
    expect(parseWorkspace(String.fromCharCode(0xfeff) + serializeWorkspace(taxiWorkspace(), SAVE_META)).workspace.charts).toHaveLength(4);
  });

  it('the current schema is v1', () => {
    expect(CURRENT_FORMAT_VERSION).toBe(1);
    expect(WorkspaceFileSchema.shape.formatVersion.value).toBe(1);
  });
});

describe('migration framework', () => {
  // A made-up history: v0 -> v1 -> v2 -> v3, to prove the runner, not real formats.
  const migrations: Record<number, Migration> = {
    0: (doc) => ({ ...(doc as object), formatVersion: 1, steps: ['0→1'] }),
    1: (doc) => ({ ...(doc as object), formatVersion: 2, steps: [...(doc as { steps?: string[] }).steps ?? [], '1→2'] }),
    2: (doc) => ({ ...(doc as object), formatVersion: 3, steps: [...(doc as { steps?: string[] }).steps ?? [], '2→3'] }),
  };

  it('runs every migration from the file version to the current one, in order', () => {
    expect(migrateWorkspaceFile({ formatVersion: 0 }, migrations, 3)).toEqual({ document: { formatVersion: 3, steps: ['0→1', '1→2', '2→3'] }, from: 0 });
    expect(migrateWorkspaceFile({ formatVersion: 2, steps: [] }, migrations, 3)).toEqual({ document: { formatVersion: 3, steps: ['2→3'] }, from: 2 });
    const current = { formatVersion: 3 };
    expect(migrateWorkspaceFile(current, migrations, 3)).toEqual({ document: current, from: null });
  });

  it('refuses newer files and gaps in the chain', () => {
    expectFileError(() => migrateWorkspaceFile({ formatVersion: 4 }, migrations, 3), 'newer_version');
    expectFileError(() => migrateWorkspaceFile({ formatVersion: 0 }, { 1: must(migrations[1]), 2: must(migrations[2]) }, 3), 'unsupported_version');
    expectFileError(() => migrateWorkspaceFile({ formatVersion: -1 }, migrations, 3), 'not_a_workspace');
    expectFileError(() => migrateWorkspaceFile(null, migrations, 3), 'not_a_workspace');
  });

  it('the real v0 → v1 migration validates its input', () => {
    const error = expectFileError(() => parseWorkspace({ formatVersion: 0, savedAt: '2026-01-01T00:00:00Z' }), 'invalid_file');
    expect(error.message).toMatch(/format 0/);
  });
});

describe('restoreWorkspace', () => {
  const saved = persistedWorkspace(taxiWorkspace());

  it('restores everything over identical data, with no warnings, clean profiles and no grid selection', () => {
    const data = taxiData();
    const { state, warnings } = restoreWorkspace(saved, data, DOC);
    expect(warnings).toEqual([]);
    expect(persistedWorkspace(state)).toEqual(saved);
    expect(state.dataSource).toEqual({ handleId: data.handleId, fileName: data.fileName, fingerprint: data.fingerprint });
    expect(state.grid.selection).toBeNull();
    expect(state.columns.some((column) => column.profile !== undefined)).toBe(false);
    expect(state.document).toEqual(DOC);
  });

  it('drops what uses a missing column and says so', () => {
    const data = taxiData();
    const { state, warnings } = restoreWorkspace(saved, { ...data, columns: data.columns.filter((column) => column.name !== 'fare_amount') }, DOC);
    expect(state.charts.map((chart) => chart.id)).toEqual(['chart_3']);
    expect(Object.keys(state.selections).sort()).toEqual(['chart_3', 'grid']);
    expect(state.grid.sort).toEqual([{ column: 'pickup_at', direction: 'asc' }]);
    expect(state.grid.columnOrder).toEqual(['pickup_at']);
    expect(state.grid.columnWidths).toEqual([{ column: 'zone "east"', width: 240 }]);
    expect(state.layout.cards.map((card) => card.chartId)).toEqual(['chart_3']);
    expect(warnings.map((warning) => warning.code)).toEqual(['column_missing', 'chart_dropped', 'chart_dropped', 'chart_dropped', 'grid_trimmed']);
    expect(warnings[1]?.message).toBe('Removed chart "Fares per day": it uses "fare_amount", which the data no longer has');
  });

  it('keeps overrides, reports type changes and new columns, and drops overrides equal to the new inferred type', () => {
    const data = taxiData();
    const columns = data.columns.map((column) =>
      column.name === 'vendor_id' ? { ...column, type: 'text' as const } : column.name === 'passenger_count' ? { ...column, type: 'float' as const } : column,
    );
    const { state, warnings } = restoreWorkspace(saved, { ...data, columns: [...columns, { name: 'tip', type: 'float' }] }, DOC);
    expect(state.columns.find((column) => column.name === 'vendor_id')).toEqual({ name: 'vendor_id', inferredType: 'text', typeOverride: null });
    expect(state.columns.at(-1)).toEqual({ name: 'tip', inferredType: 'float', typeOverride: null });
    expect(warnings.map((warning) => warning.code)).toEqual(['column_added', 'column_type_changed']);
    expect(warnings[1]?.message).toContain('"passenger_count"');
  });

  it('repairs selections and layout that do not match the charts', () => {
    const odd: PersistedWorkspace = {
      ...saved,
      selections: { ...saved.selections, chart_9: must(saved.selections['chart_2']) },
      userFilters: [...saved.userFilters, { id: 'filter_2', filter: { kind: 'isNull', column: 'gone' } }],
      layout: { cards: [must(saved.layout.cards[0]), must(saved.layout.cards[0]), { chartId: 'chart_9', x: 0, y: 5, w: 1, h: 1 }] },
    };
    const { state, warnings } = restoreWorkspace(odd, taxiData(), DOC);
    expect(state.selections['chart_9']).toBeUndefined();
    expect(state.userFilters).toEqual(saved.userFilters);
    expect(state.layout.cards.map((card) => card.chartId)).toEqual(['chart_1', 'chart_2', 'chart_3', 'chart_4']);
    expect(state.layout.cards[1]).toEqual({ chartId: 'chart_2', x: 0, y: 1, w: 1, h: 1 });
    expect(warnings.map((warning) => warning.code)).toEqual(['selection_dropped', 'filter_dropped', 'layout_repaired']);
  });
});
