import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_FORMAT_VERSION,
  OLDEST_FORMAT_VERSION,
  MIGRATIONS,
  parseWorkspace,
  persistedWorkspace,
  serializeWorkspace,
  WorkspaceFileError,
} from '../src/index.js';
import { SAVE_META, taxiWorkspace } from '../src/workspace-file/test-support.js';

/*
 * Committed `.glassgrid` files, one or more per format version. They are
 * never regenerated: a file written by an older Glassgrid must keep opening
 * after every format change (through the migrations).
 */

const DIR = join(import.meta.dirname, 'fixtures', 'workspace');
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');
const fixtures = readdirSync(DIR).filter((name) => name.endsWith('.glassgrid'));

function failure(name: string): WorkspaceFileError {
  try {
    parseWorkspace(read(name));
  } catch (error) {
    if (error instanceof WorkspaceFileError) return error;
    throw error;
  }
  throw new Error(`${name} parsed`);
}

describe('workspace fixtures', () => {
  it('there is a fixture for every readable format version, and a migration for every old one', () => {
    for (let version = OLDEST_FORMAT_VERSION; version <= CURRENT_FORMAT_VERSION; version++) {
      expect(fixtures.some((name) => name.startsWith(`v${version}-`)), `fixture for v${version}`).toBe(true);
      if (version < CURRENT_FORMAT_VERSION) expect(MIGRATIONS[version], `migration from v${version}`).toBeTypeOf('function');
    }
  });

  it.each(fixtures.filter((name) => /^v\d+-/.test(name)))('%s opens and re-saves in the current format', (name) => {
    const parsed = parseWorkspace(read(name));
    expect(parsed.file.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    const again = parseWorkspace(serializeWorkspace({ dataSource: { handleId: 'fh_0123456789abcdef' as never, fileName: parsed.data.fileName, fingerprint: parsed.data.fingerprint }, workspace: parsed.workspace }, { app: parsed.file.app, savedAt: parsed.file.savedAt, absolutePath: parsed.data.absolutePath, relativePath: parsed.data.relativePath }));
    expect(again.workspace).toEqual(parsed.workspace);
    expect(again.data).toEqual(parsed.data);
  });

  it('v1-full holds exactly what the taxi workspace saves, byte for byte', () => {
    const text = read('v1-full.glassgrid');
    expect(serializeWorkspace(taxiWorkspace(), SAVE_META)).toBe(text);
    const parsed = parseWorkspace(text);
    expect(parsed.migratedFrom).toBeNull();
    expect(parsed.warnings).toEqual([]);
    expect(parsed.workspace).toEqual(persistedWorkspace(taxiWorkspace()));
  });

  it('v1-minimal (Windows paths, offset timestamp) opens', () => {
    const parsed = parseWorkspace(read('v1-minimal.glassgrid'));
    expect(parsed.data).toMatchObject({ absolutePath: 'C:\\Users\\Ada\\Documents\\sales.csv', relativePath: 'sales.csv' });
    expect(parsed.file.savedAt).toBe('2026-10-18T11:05:00+02:00');
    expect(parsed.workspace.charts).toEqual([]);
  });

  it('v0-basic migrates to v1: absolute path only, filters become selections or user filters', () => {
    const parsed = parseWorkspace(read('v0-basic.glassgrid'));
    expect(parsed.migratedFrom).toBe(0);
    expect(parsed.warnings).toEqual([{ code: 'migrated', message: 'This workspace was saved by an older Glassgrid (format 0); saving it writes format 1' }]);
    expect(parsed.file.app).toEqual({ name: 'Glassgrid', version: '0.0.0' });
    expect(parsed.data).toEqual({
      fileName: 'trips.csv',
      absolutePath: '/home/ada/data/trips.csv',
      relativePath: null,
      fingerprint: {
        sizeBytes: 52_428_800,
        mtimeMs: 1_759_000_000_000,
        headTailSha256: '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8',
        key: '6c3e2a1b0f9d8c7b6a5f4e3d2c1b0a99',
      },
    });
    expect(parsed.workspace.selections).toEqual({
      chart_1: {
        source: 'filter',
        clauses: [{ channel: 'x', filter: { kind: 'range', column: 'fare_amount', min: 5, max: 20, minInclusive: true, maxInclusive: false } }],
      },
    });
    expect(parsed.workspace.userFilters).toEqual([
      { id: 'filter_1', filter: { kind: 'in', column: 'vendor_id', values: ['1', '2'] } },
      { id: 'filter_2', filter: { kind: 'notNull', column: 'pickup_at' } },
      { id: 'filter_3', filter: { kind: 'isNull', column: 'fare_amount' } },
    ]);
    expect(parsed.workspace.grid).toEqual({ sort: [{ column: 'pickup_at', direction: 'desc' }], columnOrder: [], columnWidths: [] });
    expect(parsed.workspace.columns[2]).toEqual({ name: 'vendor_id', inferredType: 'integer', typeOverride: 'text' });
    expect(parsed.workspace.layout.cards).toHaveLength(2);
  });

  it('refuses a file from a newer Glassgrid with a clear message', () => {
    const error = failure('future-v2.glassgrid');
    expect(error.code).toBe('newer_version');
    expect(error.message).toBe('This workspace was saved by a newer version of Glassgrid (format 2; this version reads up to 1). Update Glassgrid to open it.');
  });

  it('refuses truncated and invalid files', () => {
    expect(failure('invalid-truncated.glassgrid').code).toBe('invalid_json');
    const invalid = failure('invalid-v1-unknown-mark.glassgrid');
    expect(invalid.code).toBe('invalid_file');
    expect(invalid.issues[0]?.path).toBe('workspace.charts[1].spec.mark');
  });
});
