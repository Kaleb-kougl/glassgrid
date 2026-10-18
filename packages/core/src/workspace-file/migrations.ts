import { z } from 'zod';
import { FingerprintSchema } from '../protocol/engine.js';
import { ChartSpecSchema } from '../spec/chart.js';
import { ColumnTypeSchema } from '../spec/column.js';
import { FilterSchema, type Filter } from '../spec/filter.js';
import { SortKeySchema } from '../spec/rows.js';
import { ChartIdSchema, ColumnNameSchema, LayoutStateSchema, ViewIdSchema } from '../state/workspace.js';
import { fileIssues, WorkspaceFileError } from './errors.js';

/*
 * Format versions and migrations.
 *
 * Policy (docs/m4-persistence.md): any change to what a `.glassgrid` file
 * holds bumps `CURRENT_FORMAT_VERSION`, adds `MIGRATIONS[old]` turning a
 * version-`old` document into a version-`old + 1` one, keeps the old
 * version's schema here so the migration validates its input, and commits a
 * fixture per version under `packages/core/test/fixtures/workspace/`. On
 * open, migrations run in order from the file's version up to the current
 * one; the result is validated with the current schema. Files are only
 * written in the current version. A file from a newer Glassgrid is refused
 * with `newer_version`, never guessed at.
 */

export const CURRENT_FORMAT_VERSION = 1;
/** The oldest version this build can read. */
export const OLDEST_FORMAT_VERSION = 0;

/** Turns a document of version n (already known to claim version n) into version n + 1. */
export type Migration = (document: unknown) => unknown;

// --- Version 0 ----------------------------------------------------------------
// The pre-release shape from M1: the data referenced by absolute path only,
// filters stored per view instead of selections, no user filters, and a
// grid that only knew its sort. Kept to prove (and test) the migration path.

export const WorkspaceFileV0Schema = z.strictObject({
  formatVersion: z.literal(0),
  savedAt: z.iso.datetime({ offset: true }),
  data: z.strictObject({
    fileName: z.string().min(1).max(1024),
    path: z.string().min(1).max(32_768),
    fingerprint: FingerprintSchema,
  }),
  workspace: z.strictObject({
    columns: z.array(z.strictObject({ name: ColumnNameSchema, inferredType: ColumnTypeSchema, typeOverride: ColumnTypeSchema.nullable() })),
    charts: z.array(z.strictObject({ id: ChartIdSchema, spec: ChartSpecSchema })),
    filters: z.record(ViewIdSchema, z.array(FilterSchema)),
    grid: z.strictObject({ sort: z.array(SortKeySchema) }),
    layout: LayoutStateSchema,
  }),
});
export type WorkspaceFileV0 = z.infer<typeof WorkspaceFileV0Schema>;

function parseVersion<T>(schema: z.ZodType<T>, document: unknown, version: number): T {
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    throw new WorkspaceFileError(
      'invalid_file',
      `This workspace file (format ${version}) is damaged and cannot be opened`,
      fileIssues(parsed.error),
    );
  }
  return parsed.data;
}

/**
 * v0 → v1: `data.path` becomes `absolutePath` (no relative path was
 * recorded), the app block is filled in, and each view's filters become its
 * selection when they fit one (one or two clauses on different axes);
 * anything else becomes user filters, so no filter is lost.
 */
function migrateV0ToV1(document: unknown): unknown {
  const v0 = parseVersion(WorkspaceFileV0Schema, document, 0);
  const selections: Record<string, { source: 'filter'; clauses: { channel: 'x' | 'y' | null; filter: Filter }[] }> = {};
  const userFilters: { id: string; filter: Filter }[] = [];
  for (const [view, filters] of Object.entries(v0.workspace.filters)) {
    if (filters.length === 0) continue;
    const spec = v0.workspace.charts.find((chart) => chart.id === view)?.spec;
    const channelOf = (filter: Filter): 'x' | 'y' | null =>
      spec?.x.column === filter.column ? 'x' : spec?.y?.column === filter.column ? 'y' : null;
    const clauses = filters.map((filter) => ({ channel: channelOf(filter), filter }));
    const channels = clauses.map((clause) => clause.channel);
    if (clauses.length <= 2 && new Set(channels).size === channels.length) {
      selections[view] = { source: 'filter', clauses };
    } else {
      for (const filter of filters) userFilters.push({ id: `filter_${userFilters.length + 1}`, filter });
    }
  }
  return {
    formatVersion: 1,
    app: { name: 'Glassgrid', version: '0.0.0' },
    savedAt: v0.savedAt,
    data: { fileName: v0.data.fileName, absolutePath: v0.data.path, relativePath: null, fingerprint: v0.data.fingerprint },
    workspace: {
      columns: v0.workspace.columns,
      charts: v0.workspace.charts,
      selections,
      userFilters,
      grid: { sort: v0.workspace.grid.sort, columnOrder: [], columnWidths: [] },
      layout: v0.workspace.layout,
    },
  };
}

/** `MIGRATIONS[n]` migrates a version-n document to version n + 1. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = Object.freeze({
  0: migrateV0ToV1,
});

/**
 * Brings a parsed JSON document up to the current format version. Returns it
 * unchanged (and `from: null`) when it already is current. Throws
 * `WorkspaceFileError` for documents that are not workspaces, come from a
 * newer app, or fail an old version's schema.
 */
export function migrateWorkspaceFile(
  document: unknown,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
  current: number = CURRENT_FORMAT_VERSION,
): { document: unknown; from: number | null } {
  if (typeof document !== 'object' || document === null || Array.isArray(document) || !('formatVersion' in document)) {
    throw new WorkspaceFileError('not_a_workspace', 'This is not a Glassgrid workspace: it has no format version');
  }
  const version = document.formatVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new WorkspaceFileError('not_a_workspace', 'This is not a Glassgrid workspace: its format version is not a whole number');
  }
  if (version > current) {
    throw new WorkspaceFileError(
      'newer_version',
      `This workspace was saved by a newer version of Glassgrid (format ${version}; this version reads up to ${current}). Update Glassgrid to open it.`,
    );
  }
  let migrated: unknown = document;
  for (let from = version; from < current; from++) {
    const migration = migrations[from];
    if (migration === undefined) {
      throw new WorkspaceFileError('unsupported_version', `Workspace format ${version} is no longer supported`);
    }
    migrated = migration(migrated);
  }
  return { document: migrated, from: version === current ? null : version };
}
