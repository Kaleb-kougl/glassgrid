import type { CommandRegistry } from '../commands/registry.js';
import type { WorkspaceStore } from '../commands/store.js';
import { CommandError } from '../commands/errors.js';
import type { FileHandle } from '../ids.js';
import type { Fingerprint } from '../protocol/engine.js';
import type { WorkspaceBridge } from '../protocol/ipc.js';
import {
  OpenWorkspaceResultSchema,
  SaveWorkspaceResultSchema,
  type DataFoundBy,
  type FingerprintMismatch,
  type OpenWorkspaceFailureCode,
  type RecoveryUpdate,
  type CloseAnswer,
  type WorkspaceFileInfo,
} from '../protocol/workspace.js';
import type { ColumnType } from '../spec/column.js';
import type { WorkspaceState } from '../state/workspace.js';
import {
  digestPersisted,
  isWorkspaceDirty,
  restoreWorkspace,
  snapshotWorkspace,
  type OpenedData,
  type WorkspaceWarning,
} from './persisted.js';

/*
 * The renderer's half of workspace files, written against the bridge
 * interface so any host (the desktop renderer, tests, later the web build)
 * wires it the same way. It implements the effect commands
 * (`saveWorkspace`, `saveWorkspaceAs`, `openWorkspace`,
 * `listRecentWorkspaces`), finishes opens that began elsewhere (drag-drop,
 * recovery, a located data file), reports unsaved work for crash recovery
 * and answers main's close prompt. No DOM, no timers.
 */

/** Opens a data handle in the engine; the desktop passes `(h) => engine.open(h).then((r) => r.table)`. */
export type OpenTable = (handle: FileHandle) => Promise<{
  readonly fingerprint: Fingerprint;
  readonly columns: readonly { readonly name: string; readonly type: ColumnType }[];
}>;

export interface WorkspacePersistenceDeps {
  readonly registry: Pick<CommandRegistry, 'dispatch' | 'provide'>;
  readonly bridge: Pick<WorkspaceBridge, 'save' | 'saveAs' | 'open' | 'listRecent'>;
  readonly openTable: OpenTable;
}

export type SaveWorkspaceOutcome =
  | { readonly status: 'saved'; readonly workspaceFile: WorkspaceFileInfo }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly message: string };

export type OpenWorkspaceOutcome =
  | {
      readonly status: 'opened';
      /** The `loadWorkspace` undo entry. */
      readonly entryId: string | null;
      readonly workspaceFile: WorkspaceFileInfo | null;
      readonly dataFileName: string;
      readonly dataFoundBy: DataFoundBy;
      /** Show a warning when set: the data differs from what the workspace was saved with. */
      readonly fingerprintMismatch: FingerprintMismatch | null;
      /** From reading the file (migration) and restoring it over the data (dropped charts, …). */
      readonly warnings: readonly WorkspaceWarning[];
      readonly recovered: boolean;
    }
  | {
      /** The data file was not found: ask the person, then `locateWorkspaceData(token)` (or `bridge.cancelOpen`). */
      readonly status: 'needsData';
      readonly token: string;
      readonly workspaceFile: WorkspaceFileInfo | null;
      readonly dataFileName: string;
      readonly warnings: readonly WorkspaceWarning[];
    }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly code: OpenWorkspaceFailureCode; readonly message: string };

/**
 * Saves `state` through the bridge and, once main reports it written,
 * records the save (`markWorkspaceSaved`) with the digest of exactly what
 * was written, so edits made while saving still count as unsaved.
 */
export async function saveWorkspaceWith(
  deps: Pick<WorkspacePersistenceDeps, 'registry' | 'bridge'>,
  state: WorkspaceState,
  mode: 'save' | 'saveAs',
): Promise<SaveWorkspaceOutcome> {
  let snapshot;
  try {
    snapshot = snapshotWorkspace(state);
  } catch {
    throw new CommandError('precondition_failed', 'No file is open, so there is no workspace to save', {
      command: mode === 'save' ? 'saveWorkspace' : 'saveWorkspaceAs',
    });
  }
  const savedDigest = digestPersisted(snapshot.workspace);
  const request = { documentId: state.document?.id ?? null, snapshot };
  const result = SaveWorkspaceResultSchema.parse(await (mode === 'save' ? deps.bridge.save(request) : deps.bridge.saveAs(request)));
  if (result.status !== 'saved') return result;
  await deps.registry.dispatch(
    'markWorkspaceSaved',
    { documentId: result.documentId, fileName: result.workspaceFile.fileName, savedDigest },
    { caller: 'user' },
  );
  return { status: 'saved', workspaceFile: result.workspaceFile };
}

/**
 * Finishes any open that main answered (`bridge.open`, `openDropped`,
 * `locateData`, `restoreRecovery`): opens the data handle in the engine and
 * replaces the workspace with `loadWorkspace`. The person's app performs
 * the load, so the entry is recorded as caller `user` (see the notes on AI
 * attribution in docs/m4-persistence.md).
 */
export async function completeWorkspaceOpen(
  deps: Pick<WorkspacePersistenceDeps, 'registry' | 'openTable'>,
  raw: unknown,
): Promise<OpenWorkspaceOutcome> {
  const result = OpenWorkspaceResultSchema.parse(raw);
  if (result.status !== 'opened') return result;

  let data: OpenedData;
  try {
    const table = await deps.openTable(result.file.handle);
    data = {
      handleId: result.file.handle,
      fileName: result.file.displayName,
      fingerprint: table.fingerprint,
      columns: table.columns.map((column) => ({ name: column.name, type: column.type })),
    };
  } catch (error) {
    return { status: 'failed', code: 'data_unreadable', message: `Could not open ${result.file.displayName}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const document = { id: result.documentId, fileName: result.workspaceFile?.fileName ?? null };
  const restored = restoreWorkspace(result.workspace, data, { ...document, savedDigest: null });
  const { entryId } = await deps.registry.dispatch(
    'loadWorkspace',
    { data, workspace: result.workspace, document, recovered: result.recovered !== null },
    { caller: 'user' },
  );
  return {
    status: 'opened',
    entryId,
    workspaceFile: result.workspaceFile,
    dataFileName: result.file.displayName,
    dataFoundBy: result.dataFoundBy,
    fingerprintMismatch: result.fingerprintMismatch,
    warnings: [...result.warnings, ...restored.warnings],
    recovered: result.recovered !== null,
  };
}

/** After `needsData`: the person locates the data file in a native dialog, then the open completes. */
export async function locateWorkspaceData(
  deps: Pick<WorkspacePersistenceDeps, 'registry' | 'openTable'> & { readonly bridge: Pick<WorkspaceBridge, 'locateData'> },
  token: string,
): Promise<OpenWorkspaceOutcome> {
  return completeWorkspaceOpen(deps, await deps.bridge.locateData(token));
}

/**
 * Implements the workspace effect commands on `registry`. Returns a function
 * that removes the handlers.
 */
export function provideWorkspacePersistence(deps: WorkspacePersistenceDeps): () => void {
  const removers = [
    deps.registry.provide('saveWorkspace', (_input, { state }) => saveWorkspaceWith(deps, state, 'save')),
    deps.registry.provide('saveWorkspaceAs', (_input, { state }) => saveWorkspaceWith(deps, state, 'saveAs')),
    deps.registry.provide('openWorkspace', async (input) =>
      // The input was validated by the registry (OpenWorkspaceInputSchema) and its caller rule checked.
      completeWorkspaceOpen(deps, await deps.bridge.open(input as Parameters<WorkspaceBridge['open']>[0])),
    ),
    deps.registry.provide('listRecentWorkspaces', async () =>
      (await deps.bridge.listRecent()).map(({ id, fileName, lastOpenedAt }) => ({ id, fileName, lastOpenedAt })),
    ),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}

/** The answer to main's close prompt: whether there is unsaved work, and the snapshot to save if the person says Save. */
export function closeAnswer(state: WorkspaceState): CloseAnswer {
  if (!isWorkspaceDirty(state)) return { dirty: false };
  return { dirty: true, documentId: state.document?.id ?? null, snapshot: snapshotWorkspace(state) };
}

/**
 * Keeps main's crash-recovery copy current: reports the unsaved work after
 * every change that alters it (deduplicated by digest), and `null` once the
 * workspace is clean. Main writes at most every few seconds, so reporting
 * on each change is cheap. Returns the unsubscribe function.
 */
export function reportUnsavedWork(
  store: Pick<WorkspaceStore, 'getState' | 'subscribe'>,
  report: (update: RecoveryUpdate | null) => void,
): () => void {
  let last: string | null = null;
  const check = (): void => {
    const state = store.getState();
    if (!isWorkspaceDirty(state)) {
      if (last !== null) report(null);
      last = null;
      return;
    }
    const snapshot = snapshotWorkspace(state);
    const documentId = state.document?.id ?? null;
    const key = `${documentId ?? ''}|${snapshot.dataSource.handleId}|${digestPersisted(snapshot.workspace)}`;
    if (key === last) return;
    last = key;
    report({ documentId, snapshot });
  };
  check();
  return store.subscribe(check);
}
