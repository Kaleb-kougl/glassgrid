import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  isWorkspaceFileError,
  serializeWorkspace,
  WORKSPACE_FILE_EXTENSION,
  type AppInfo,
  type DataFoundBy,
  type ExternalOpenRequest,
  type FileHandle,
  type Fingerprint,
  type OpenWorkspaceRequest,
  type OpenWorkspaceResult,
  type ParsedWorkspace,
  type RecentWorkspace,
  type RecoverySnapshotInfo,
  type RecoveryUpdate,
  type SaveWorkspaceRequest,
  type SaveWorkspaceResult,
  type WorkspaceFileInfo,
  type WorkspaceSnapshot,
} from '@glassgrid/core';
import type { AppStateStore } from './app-state';
import { removeStaleTempFiles, writeFileAtomic } from './atomic-write';
import { Autosaver, newRecoveryId, type RecoveryStore } from './recovery';
import {
  compareFingerprints,
  dataReferencePaths,
  defaultWorkspaceName,
  describeIoError,
  findDataFile,
  isRegularFile,
  readWorkspaceFile,
  WorkspaceIoError,
  withWorkspaceExtension,
  workspaceFileInfo,
} from './workspace-io';

/*
 * Main's side of workspace files, free of Electron so it can be unit-tested
 * with temp folders and fake dialogs. The IPC layer (./ipc.ts) checks the
 * sender and parses every request before calling in here.
 *
 * Paths stay in main. The renderer names a workspace file by a document id
 * (`doc_…`), recent entries by `rw_…`, pending opens by `ot_…` and recovery
 * snapshots by `rs_…`; data files only ever reach it as engine handles.
 */

/** A window as the service sees it: a key (its webContents id) and the owner for native dialogs. */
export interface WindowRef<Owner = unknown> {
  readonly key: number;
  readonly owner: Owner;
}

export interface FileFilter {
  readonly name: string;
  readonly extensions: string[];
}

/** The subset of Electron's `dialog` the service uses (owner may be null). */
export interface Dialogs<Owner> {
  showSaveDialog(
    owner: Owner,
    options: { title: string; defaultPath: string; filters: FileFilter[]; properties: ('createDirectory' | 'showOverwriteConfirmation')[] },
  ): Promise<{ canceled: boolean; filePath?: string | undefined }>;
  showOpenDialog(
    owner: Owner,
    options: { title: string; defaultPath?: string; filters: FileFilter[]; properties: 'openFile'[] },
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface WorkspaceServiceDeps<Owner> {
  readonly app: AppInfo;
  readonly dialogs: Dialogs<Owner>;
  /** Registers a data file with the engine, exactly like opening a CSV. */
  readonly registerFile: (path: string) => Promise<{ handle: FileHandle; sizeBytes: number }>;
  /** The path behind a handle main registered. */
  readonly pathOfHandle: (handle: FileHandle) => string | undefined;
  /** The engine's fingerprint function (size, mtime, SHA-256 of the first and last 1 MB). */
  readonly fingerprint: (path: string) => Promise<Fingerprint>;
  readonly appState: AppStateStore;
  readonly recovery: RecoveryStore;
  readonly now?: () => Date;
  readonly autosaveIntervalMs?: number;
  /** OS-level recent documents (macOS Dock, Windows jump list). */
  readonly addRecentDocument?: (path: string) => void;
  /** The recent list changed (an open or save added a file, or a missing one was dropped): rebuild File → Open Recent. */
  readonly onRecentChanged?: () => void;
  /** Test-only: options passed to every atomic write of a workspace file. */
  readonly writeOptions?: Parameters<typeof writeFileAtomic>[2];
}

const WORKSPACE_FILTERS: FileFilter[] = [
  { name: 'Glassgrid workspace', extensions: [WORKSPACE_FILE_EXTENSION] },
  { name: 'All files', extensions: ['*'] },
];
const DATA_FILTERS: FileFilter[] = [
  { name: 'Delimited text', extensions: ['csv', 'tsv', 'txt', 'gz'] },
  { name: 'All files', extensions: ['*'] },
];

/** Everything needed to finish an open once its data file is known. */
interface OpenContext {
  /** The file relative paths are resolved against (the workspace file, or for recovery the one it belongs to). */
  readonly workspacePath: string | null;
  readonly parsed: ParsedWorkspace;
  readonly documentId: string | null;
  readonly workspaceFile: WorkspaceFileInfo | null;
  readonly recovered: { id: string; savedAt: string } | null;
  /** Workspace file to put on the recent list once it opened (not for recovery). */
  readonly recent: string | null;
}

type PendingOpen = { readonly kind: 'external'; readonly path: string } | { readonly kind: 'locate'; readonly context: OpenContext };

export class WorkspaceService<Owner = unknown> {
  private readonly documents = new Map<string, string>();
  private readonly documentByPath = new Map<string, string>();
  private readonly pending = new Map<string, PendingOpen>();
  /** Window key -> its recovery snapshot id. */
  private readonly windows = new Map<number, string>();
  readonly autosaver: Autosaver;
  private readonly now: () => Date;

  constructor(private readonly deps: WorkspaceServiceDeps<Owner>) {
    this.now = deps.now ?? (() => new Date());
    this.autosaver = new Autosaver({
      ...(deps.autosaveIntervalMs === undefined ? {} : { intervalMs: deps.autosaveIntervalMs }),
      write: (id, update) => this.writeRecovery(id, update),
      remove: (id) => deps.recovery.remove(id),
    });
  }

  // --- Documents --------------------------------------------------------------

  /** The document id for a workspace path (one id per path for the life of the app). */
  documentIdFor(path: string): string {
    let id = this.documentByPath.get(path);
    if (id === undefined) {
      id = `doc_${randomUUID()}`;
      this.documentByPath.set(path, id);
      this.documents.set(id, path);
    }
    return id;
  }

  documentPath(documentId: string | null): string | undefined {
    return documentId === null ? undefined : this.documents.get(documentId);
  }

  // --- Saving -------------------------------------------------------------------

  /** Saves to the document's file; a request without a known document behaves like Save As. */
  async save(win: WindowRef<Owner>, request: SaveWorkspaceRequest): Promise<SaveWorkspaceResult> {
    const path = this.documentPath(request.documentId);
    if (path === undefined) return this.saveAs(win, request);
    return this.writeWorkspace(win, path, request.snapshot);
  }

  async saveAs(win: WindowRef<Owner>, request: SaveWorkspaceRequest): Promise<SaveWorkspaceResult> {
    const dataPath = this.deps.pathOfHandle(request.snapshot.dataSource.handleId);
    if (dataPath === undefined) return { status: 'failed', message: 'The data file is no longer open; open it again, then save' };
    const current = this.documentPath(request.documentId);
    const defaultPath = current ?? join(dirname(dataPath), defaultWorkspaceName(dataPath));
    const picked = await this.deps.dialogs.showSaveDialog(win.owner, {
      title: 'Save Workspace',
      defaultPath,
      filters: WORKSPACE_FILTERS.slice(0, 1),
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (picked.canceled || picked.filePath === undefined || picked.filePath === '') return { status: 'cancelled' };
    return this.writeWorkspace(win, withWorkspaceExtension(resolve(picked.filePath)), request.snapshot);
  }

  private async writeWorkspace(win: WindowRef<Owner>, path: string, snapshot: WorkspaceSnapshot): Promise<SaveWorkspaceResult> {
    const dataPath = this.deps.pathOfHandle(snapshot.dataSource.handleId);
    if (dataPath === undefined) return { status: 'failed', message: 'The data file is no longer open; open it again, then save' };
    let text: string;
    try {
      text = serializeWorkspace(snapshot, { app: this.deps.app, savedAt: this.now().toISOString(), ...dataReferencePaths(path, dataPath) });
    } catch (error) {
      return { status: 'failed', message: isWorkspaceFileError(error) ? error.message : String(error) };
    }
    try {
      await removeStaleTempFiles(dirname(path), { forName: basename(path) });
      await writeFileAtomic(path, text, this.deps.writeOptions);
    } catch (error) {
      return { status: 'failed', message: `Could not save ${basename(path)}: ${describeIoError(error)}` };
    }
    const documentId = this.documentIdFor(path);
    await this.rememberRecent(path);
    const recoveryId = this.windows.get(win.key);
    if (recoveryId !== undefined) await this.autosaver.saved(recoveryId, { documentId, snapshot });
    return { status: 'saved', documentId, workspaceFile: workspaceFileInfo(path) };
  }

  // --- Opening ------------------------------------------------------------------

  async open(win: WindowRef<Owner>, request: OpenWorkspaceRequest): Promise<OpenWorkspaceResult> {
    switch (request.source) {
      case 'dialog': {
        const picked = await this.deps.dialogs.showOpenDialog(win.owner, { title: 'Open Workspace', filters: WORKSPACE_FILTERS, properties: ['openFile'] });
        const path = picked.canceled ? undefined : picked.filePaths[0];
        return path === undefined ? { status: 'cancelled' } : this.openPath(path);
      }
      case 'recent': {
        const path = await this.deps.appState.recentWorkspacePath(request.id);
        if (path === undefined) return { status: 'failed', code: 'not_found', message: 'That workspace is no longer in the recent list' };
        const result = await this.openPath(path);
        if (result.status === 'failed' && result.code === 'io' && !(await isRegularFile(path))) {
          await this.deps.appState.removeRecentWorkspace(path);
          this.deps.onRecentChanged?.();
        }
        return result;
      }
      case 'external': {
        const pending = this.pending.get(request.token);
        if (pending?.kind !== 'external') return { status: 'failed', code: 'not_found', message: 'That file is no longer waiting to be opened' };
        this.pending.delete(request.token);
        return this.openPath(pending.path);
      }
    }
  }

  /** Opens a workspace file by path (dialog, recent list, drag-drop, the OS). */
  async openPath(rawPath: string): Promise<OpenWorkspaceResult> {
    const path = resolve(rawPath);
    let parsed: ParsedWorkspace;
    try {
      parsed = await readWorkspaceFile(path);
    } catch (error) {
      if (isWorkspaceFileError(error)) return { status: 'failed', code: error.code, message: error.message };
      return { status: 'failed', code: 'io', message: error instanceof WorkspaceIoError ? error.message : `Could not read ${basename(path)}` };
    }
    return this.relink({
      workspacePath: path,
      parsed,
      documentId: this.documentIdFor(path),
      workspaceFile: workspaceFileInfo(path),
      recovered: null,
      recent: path,
    });
  }

  /** Relative path, then absolute path; otherwise the renderer gets a token to ask the person. */
  private async relink(context: OpenContext): Promise<OpenWorkspaceResult> {
    const found = await findDataFile(context.workspacePath, context.parsed.data);
    if (found === null) {
      const token = `ot_${randomUUID()}`;
      this.pending.set(token, { kind: 'locate', context });
      return { status: 'needsData', token, workspaceFile: context.workspaceFile, dataFileName: context.parsed.data.fileName, warnings: context.parsed.warnings };
    }
    return this.registerData(context, found.path, found.via);
  }

  private async registerData(context: OpenContext, dataPath: string, via: DataFoundBy): Promise<OpenWorkspaceResult> {
    let fingerprint: Fingerprint;
    let registered: { handle: FileHandle; sizeBytes: number };
    try {
      fingerprint = await this.deps.fingerprint(dataPath);
      registered = await this.deps.registerFile(dataPath);
    } catch (error) {
      return { status: 'failed', code: 'data_unreadable', message: `Could not open ${basename(dataPath)}: ${describeIoError(error)}` };
    }
    if (context.recent !== null) await this.rememberRecent(context.recent);
    const fingerprintMismatch = compareFingerprints(context.parsed.data.fingerprint, fingerprint);
    // The data differs from what the workspace was saved with: the person may still point it at the right file.
    let relinkToken: string | undefined;
    if (fingerprintMismatch !== null) {
      relinkToken = `ot_${randomUUID()}`;
      this.pending.set(relinkToken, { kind: 'locate', context });
    }
    return {
      status: 'opened',
      documentId: context.documentId,
      workspaceFile: context.workspaceFile,
      file: { handle: registered.handle, displayName: basename(dataPath), sizeBytes: registered.sizeBytes },
      dataFoundBy: via,
      fingerprintMismatch,
      workspace: context.parsed.workspace,
      warnings: context.parsed.warnings,
      migratedFrom: context.parsed.migratedFrom,
      recovered: context.recovered,
      ...(relinkToken === undefined ? {} : { relinkToken }),
    };
  }

  /** After `needsData`: the person picks the data file. Cancelling keeps the token for another try. */
  async locateData(win: WindowRef<Owner>, token: string): Promise<OpenWorkspaceResult> {
    const pending = this.pending.get(token);
    if (pending?.kind !== 'locate') return { status: 'failed', code: 'not_found', message: 'That workspace is no longer waiting for its data' };
    const { context } = pending;
    const near = context.workspacePath === null ? dirname(context.parsed.data.absolutePath) : dirname(context.workspacePath);
    const picked = await this.deps.dialogs.showOpenDialog(win.owner, {
      title: `Locate ${context.parsed.data.fileName}`,
      ...(isAbsolute(near) ? { defaultPath: near } : {}),
      filters: DATA_FILTERS,
      properties: ['openFile'],
    });
    const path = picked.canceled ? undefined : picked.filePaths[0];
    if (path === undefined) return { status: 'cancelled' };
    if (!(await isRegularFile(path))) return { status: 'failed', code: 'data_unreadable', message: `${basename(path)} is not a file` };
    const result = await this.registerData(context, resolve(path), 'located');
    if (result.status === 'opened') {
      this.pending.delete(token);
      if (context.recovered !== null) this.adoptRecovery(win, context.recovered.id);
    }
    return result;
  }

  cancelOpen(token: string): void {
    this.pending.delete(token);
  }

  /** A workspace file handed over by the OS; the renderer opens it with `{ source: 'external', token }`. */
  externalOpen(path: string): ExternalOpenRequest {
    const token = `ot_${randomUUID()}`;
    this.pending.set(token, { kind: 'external', path: resolve(path) });
    return { token, fileName: basename(path) };
  }

  // --- Recent list --------------------------------------------------------------

  listRecent(): Promise<RecentWorkspace[]> {
    return this.deps.appState.listRecentWorkspaces();
  }

  private async rememberRecent(path: string): Promise<void> {
    try {
      await this.deps.appState.recordRecentWorkspace(path);
    } catch {
      // Logged by the store; the recent list is a convenience.
    }
    this.deps.addRecentDocument?.(path);
    this.deps.onRecentChanged?.();
  }

  // --- Crash recovery -------------------------------------------------------------

  /** The window's recovery id, created on first use. */
  recoveryIdOf(win: Pick<WindowRef, 'key'>): string {
    let id = this.windows.get(win.key);
    if (id === undefined) {
      id = newRecoveryId();
      this.windows.set(win.key, id);
    }
    return id;
  }

  /** The renderer's latest unsaved work (null once clean); the autosaver writes it within a few seconds. */
  updateRecovery(win: Pick<WindowRef, 'key'>, update: RecoveryUpdate | null): void {
    this.autosaver.update(this.recoveryIdOf(win), update);
  }

  private async writeRecovery(recoveryId: string, update: RecoveryUpdate): Promise<void> {
    const dataPath = this.deps.pathOfHandle(update.snapshot.dataSource.handleId);
    if (dataPath === undefined) return; // A handle this process never issued: nothing to point the snapshot at.
    const workspacePath = this.documentPath(update.documentId) ?? null;
    const text = serializeWorkspace(update.snapshot, {
      app: this.deps.app,
      savedAt: this.now().toISOString(),
      ...dataReferencePaths(workspacePath, dataPath),
      recoveryOf: { workspacePath },
    });
    await this.deps.recovery.write(recoveryId, text);
  }

  /** Snapshots from earlier sessions (crashes) newer than their workspace file, newest first. */
  async listRecovery(): Promise<RecoverySnapshotInfo[]> {
    const live = new Set(this.windows.values());
    return (await this.deps.recovery.list(live)).map((entry) => ({
      id: entry.id,
      workspaceFile: entry.workspacePath === null ? null : workspaceFileInfo(entry.workspacePath),
      dataFileName: entry.parsed.data.fileName,
      savedAt: entry.parsed.file.savedAt,
    }));
  }

  /** Opens a recovery snapshot into `win`, which then owns it (it is deleted on that window's next clean save). */
  async restoreRecovery(win: WindowRef<Owner>, id: string): Promise<OpenWorkspaceResult> {
    const entry = await this.deps.recovery.read(id);
    if (entry?.parsed.file.recoveryOf === undefined) return { status: 'failed', code: 'not_found', message: 'That unsaved work is no longer available' };
    const { workspacePath } = entry;
    const result = await this.relink({
      workspacePath,
      parsed: entry.parsed,
      documentId: workspacePath === null ? null : this.documentIdFor(workspacePath),
      workspaceFile: workspacePath === null ? null : workspaceFileInfo(workspacePath),
      recovered: { id, savedAt: entry.parsed.file.savedAt },
      recent: null,
    });
    if (result.status === 'opened') this.adoptRecovery(win, id);
    return result;
  }

  async discardRecovery(id: string): Promise<void> {
    for (const [key, owned] of this.windows) {
      if (owned === id) {
        await this.autosaver.discard(id);
        this.windows.delete(key);
        return;
      }
    }
    await this.deps.recovery.remove(id);
  }

  /**
   * The window now owns snapshot `id`. Its previous snapshot, if it wrote
   * one, is left on disk: it is unsaved work the next launch can offer.
   */
  private adoptRecovery(win: Pick<WindowRef, 'key'>, id: string): void {
    const previous = this.windows.get(win.key);
    if (previous !== undefined && previous !== id) this.autosaver.forget(previous);
    this.windows.set(win.key, id);
    this.autosaver.adopt(id);
  }

  /**
   * The window is closing. `clean`: the person saved or chose Don't Save (or
   * there was nothing unsaved), so its snapshot goes. Otherwise (the
   * renderer did not answer) its latest work is flushed and kept.
   */
  async windowClosed(win: Pick<WindowRef, 'key'>, clean: boolean): Promise<void> {
    const id = this.windows.get(win.key);
    if (id === undefined) return;
    if (clean) await this.autosaver.discard(id);
    else await this.autosaver.flush(id);
    this.autosaver.forget(id);
    this.windows.delete(win.key);
  }
}
