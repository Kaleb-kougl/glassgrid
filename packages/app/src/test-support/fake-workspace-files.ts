import { vi } from 'vitest';
import {
  toFileHandle,
  type DroppedFile,
  type ExternalOpenRequest,
  type OpenWorkspaceRequest,
  type OpenWorkspaceResult,
  type PersistedWorkspace,
  type RecentWorkspace,
  type RecoverySnapshotInfo,
  type RecoveryUpdate,
  type SaveWorkspaceRequest,
  type SaveWorkspaceResult,
} from '@glassgrid/core';
import type { WorkspaceFilesApi } from '../platform';

/*
 * A WorkspaceFilesApi double (core's WorkspaceBridge without the window
 * events): every method a vi.fn with a realistic default, results shaped
 * like main's. `openRequest()` delivers an OS hand-off.
 */

export const DOC_ID = 'doc_aaaaaaaa-1111';
/** The data handle saved workspaces open with (another file than the fake engine's CSV). */
export const workspaceHandle = toFileHandle('1c6c8f0e-6d0a-4f43-9d3e-2f1f1a0d9c22');

/** A saved workspace over the fake engine's columns: a bar chart of category, amount read as text, sorted by id. */
export const savedWorkspace: PersistedWorkspace = {
  columns: [
    { name: 'id', inferredType: 'integer', typeOverride: null },
    { name: 'category', inferredType: 'text', typeOverride: null },
    { name: 'amount', inferredType: 'float', typeOverride: 'text' },
  ],
  charts: [{ id: 'chart_9', spec: { mark: 'bar', x: { column: 'category' }, filters: [] }, title: 'Trips by category' }],
  selections: {},
  userFilters: [],
  grid: { sort: [{ column: 'id', direction: 'desc' }], columnOrder: [], columnWidths: [] },
  layout: { cards: [{ chartId: 'chart_9', x: 0, y: 0, w: 1, h: 1 }] },
};

export function openedResult(overrides: Partial<Extract<OpenWorkspaceResult, { status: 'opened' }>> = {}): Extract<OpenWorkspaceResult, { status: 'opened' }> {
  return {
    status: 'opened',
    documentId: DOC_ID,
    workspaceFile: { fileName: 'trips.glassgrid', directory: '/work' },
    file: { handle: workspaceHandle, displayName: 'trips.csv', sizeBytes: 2048 },
    dataFoundBy: 'relative',
    fingerprintMismatch: null,
    workspace: savedWorkspace,
    warnings: [],
    migratedFrom: null,
    recovered: null,
    ...overrides,
  };
}

export const recentEntry: RecentWorkspace = { id: `rw_${'a'.repeat(24)}`, fileName: 'q3.glassgrid', directory: '/work/reports', lastOpenedAt: '2026-10-18T09:00:00.000Z' };
export const recoveryEntry: RecoverySnapshotInfo = {
  id: 'rs_recover-1234',
  workspaceFile: { fileName: 'trips.glassgrid', directory: '/work' },
  dataFileName: 'trips.csv',
  savedAt: '2026-10-18T09:30:00.000Z',
};

export function fakeWorkspaceFiles(options: { recent?: RecentWorkspace[]; recovery?: RecoverySnapshotInfo[] } = {}) {
  const openListeners = new Set<(request: ExternalOpenRequest) => void>();
  const saved: SaveWorkspaceResult = { status: 'saved', documentId: DOC_ID, workspaceFile: { fileName: 'trips.glassgrid', directory: '/work' } };
  const api = {
    save: vi.fn((_request: SaveWorkspaceRequest): Promise<SaveWorkspaceResult> => Promise.resolve(saved)),
    saveAs: vi.fn((_request: SaveWorkspaceRequest): Promise<SaveWorkspaceResult> => Promise.resolve({ ...saved, workspaceFile: { fileName: 'copy.glassgrid', directory: '/work' } })),
    open: vi.fn((_request: OpenWorkspaceRequest): Promise<OpenWorkspaceResult> => Promise.resolve(openedResult())),
    openDropped: vi.fn((_file: DroppedFile): Promise<OpenWorkspaceResult> => Promise.resolve(openedResult())),
    locateData: vi.fn((_token: string): Promise<OpenWorkspaceResult> => Promise.resolve(openedResult({ dataFoundBy: 'located' }))),
    cancelOpen: vi.fn((_token: string) => Promise.resolve()),
    listRecent: vi.fn((): Promise<RecentWorkspace[]> => Promise.resolve(options.recent ?? [])),
    listRecovery: vi.fn((): Promise<RecoverySnapshotInfo[]> => Promise.resolve(options.recovery ?? [])),
    restoreRecovery: vi.fn((_id: string): Promise<OpenWorkspaceResult> => Promise.resolve(openedResult({ recovered: { id: 'rs_recover-1234', savedAt: '2026-10-18T09:30:00.000Z' } }))),
    discardRecovery: vi.fn((_id: string) => Promise.resolve()),
    updateRecovery: vi.fn((_update: RecoveryUpdate | null) => undefined),
    onOpenRequest: vi.fn((listener: (request: ExternalOpenRequest) => void) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    }),
  } satisfies WorkspaceFilesApi;
  return {
    api,
    /** The OS hands the app a workspace file. */
    openRequest: (request: ExternalOpenRequest) => openListeners.forEach((listener) => listener(request)),
  };
}
