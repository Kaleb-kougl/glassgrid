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
import { flightsData, flightsWorkspace, FLIGHTS_SAVE_META, SAVE_META, taxiWorkspace } from '../src/workspace-file/test-support.js';
import { restoreWorkspace } from '../src/index.js';

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

  it('v1-full (what the taxi workspace saved in format 1) migrates to v2 with no map views, and re-saves as the taxi workspace does now', () => {
    const text = read('v1-full.glassgrid');
    const parsed = parseWorkspace(text);
    expect(parsed.migratedFrom).toBe(1);
    expect(parsed.warnings).toEqual([{ code: 'migrated', message: 'This workspace was saved by an older Glassgrid (format 1); saving it writes format 2' }]);
    expect(parsed.workspace.maps).toEqual([]);
    expect(parsed.workspace).toEqual(persistedWorkspace(taxiWorkspace()));
    // Only the version and the empty map list differ from what format 1 held.
    const v1 = JSON.parse(text) as { formatVersion: number; workspace: Record<string, unknown> };
    const v2 = JSON.parse(serializeWorkspace(taxiWorkspace(), SAVE_META)) as typeof v1;
    expect(v2.formatVersion).toBe(2);
    const { maps, ...rest } = v2.workspace;
    expect(maps).toEqual([]);
    expect({ ...v2, formatVersion: 1, workspace: rest }).toEqual(v1);
  });

  it('v2-flights holds exactly what the flights workspace (map views, charts, a brush) saves, byte for byte, and restores over its data', () => {
    const text = read('v2-flights.glassgrid');
    expect(serializeWorkspace(flightsWorkspace(), FLIGHTS_SAVE_META)).toBe(text);
    const parsed = parseWorkspace(text);
    expect(parsed.migratedFrom).toBeNull();
    expect(parsed.warnings).toEqual([]);
    expect(parsed.workspace).toEqual(persistedWorkspace(flightsWorkspace()));
    expect(parsed.workspace.maps.map((map) => map.id)).toEqual(['map_3', 'map_4']);
    expect(parsed.workspace.layout.cards.map((card) => card.chartId)).toEqual(['map_3', 'chart_1', 'chart_2', 'map_4']);

    const document = { id: null, fileName: 'flights.glassgrid', savedDigest: null };
    const restored = restoreWorkspace(parsed.workspace, flightsData(), document);
    expect(restored.warnings).toEqual([]);
    expect(restored.state.maps).toEqual(flightsWorkspace().maps);
    // Data without the columns a map reads: the map goes, with a warning; its card goes quietly.
    const noFlight = flightsData({ columns: flightsData().columns.filter((column) => column.name !== 'flight') });
    const dropped = restoreWorkspace(parsed.workspace, noFlight, document);
    expect(dropped.state.maps.map((map) => map.id)).toEqual(['map_4']);
    expect(dropped.state.layout.cards.map((card) => card.chartId)).toEqual(['chart_1', 'chart_2', 'map_4']);
    expect(dropped.warnings.map((warning) => warning.code)).toEqual(['column_missing', 'map_dropped']);
    expect(dropped.warnings[1]?.message).toBe('Removed map "map_3": it uses "flight", which the data no longer has');
  });

  it('v1-minimal (Windows paths, offset timestamp) opens', () => {
    const parsed = parseWorkspace(read('v1-minimal.glassgrid'));
    expect(parsed.data).toMatchObject({ absolutePath: 'C:\\Users\\Ada\\Documents\\sales.csv', relativePath: 'sales.csv' });
    expect(parsed.file.savedAt).toBe('2026-10-18T11:05:00+02:00');
    expect(parsed.workspace.charts).toEqual([]);
  });

  it('v0-basic migrates to v1 (absolute path only, filters become selections or user filters), then to v2', () => {
    const parsed = parseWorkspace(read('v0-basic.glassgrid'));
    expect(parsed.migratedFrom).toBe(0);
    expect(parsed.warnings).toEqual([{ code: 'migrated', message: 'This workspace was saved by an older Glassgrid (format 0); saving it writes format 2' }]);
    expect(parsed.workspace.maps).toEqual([]);
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
    const error = failure('future-v3.glassgrid');
    expect(error.code).toBe('newer_version');
    expect(error.message).toBe('This workspace was saved by a newer version of Glassgrid (format 3; this version reads up to 2). Update Glassgrid to open it.');
  });

  it('refuses truncated and invalid files', () => {
    expect(failure('invalid-truncated.glassgrid').code).toBe('invalid_json');
    const invalid = failure('invalid-v1-unknown-mark.glassgrid');
    expect(invalid.code).toBe('invalid_file');
    expect(invalid.issues[0]?.path).toBe('workspace.charts[1].spec.mark');
  });
});
