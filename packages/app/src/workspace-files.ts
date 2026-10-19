import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  closeAnswer,
  completeWorkspaceOpen,
  formatBytes,
  isWorkspaceDirty,
  locateWorkspaceData,
  provideWorkspacePersistence,
  reportUnsavedWork,
  WORKSPACE_FILE_EXTENSION,
  type FingerprintMismatch,
  type OpenWorkspaceOutcome,
  type OpenWorkspaceRequest,
  type RecentWorkspace,
  type RecoverySnapshotInfo,
  type SaveWorkspaceOutcome,
  type WorkspaceMenuCommand,
  type WorkspaceState,
} from '@glassgrid/core';
import type { EngineClientLike } from './engine';
import type { DroppedFileRef, PlatformWindow, WorkspaceFilesApi } from './platform';
import type { AppWorkspace } from './workspace';

/*
 * The app's half of `.glassgrid` workspace files, over a platform's
 * `WorkspaceFilesApi` (core's WorkspaceBridge). One source of truth for
 * unsaved changes: core's digest-based `isWorkspaceDirty`, which survives
 * undoing back to the saved state. One autosave path: `reportUnsavedWork`
 * feeds the host's recovery autosaver. Every save and open the person starts
 * (buttons, shortcuts, menus, the recent list, OS hand-offs) dispatches the
 * workspace commands, so the UI and agents take the same path; the
 * continuations of an open (a dropped file, a located data file, a
 * recovery snapshot) finish through core's `completeWorkspaceOpen`, whose
 * state change is the `loadWorkspace` command.
 */

export interface WorkspaceToast {
  readonly tone: 'info' | 'error';
  readonly message: string;
}

/** The data file a workspace refers to was not found: the locate prompt. */
export interface LocatePrompt {
  readonly token: string;
  readonly dataFileName: string;
  /** The workspace file's name, or null for restored untitled work. */
  readonly workspaceName: string | null;
  /** The last attempt failed (a file that is not readable, …). */
  readonly error: string | null;
}

/** The data differs from what the workspace was saved with (non-blocking banner). */
export interface MismatchNotice {
  /** The data source the notice is about; it goes away when another one is shown. */
  readonly handleId: string;
  readonly dataFileName: string;
  readonly message: string;
  /** Finish with `locate` (another file) or forget with `dismissMismatch`; null when the host offers no relink. */
  readonly relinkToken: string | null;
}

export interface WorkspaceFilesUi {
  /** The platform saves and opens workspaces. */
  readonly enabled: boolean;
  /** Unsaved changes (`isWorkspaceDirty`). */
  readonly edited: boolean;
  /** A save or open is running. */
  readonly busy: boolean;
  readonly recent: readonly RecentWorkspace[];
  readonly recovery: readonly RecoverySnapshotInfo[];
  readonly locate: LocatePrompt | null;
  readonly mismatch: MismatchNotice | null;
  readonly save: (saveAs: boolean) => void;
  readonly open: (request: OpenWorkspaceRequest) => void;
  /** File-menu workspace items. */
  readonly runMenuCommand: (command: WorkspaceMenuCommand) => void;
  /** A dropped `.glassgrid` file. */
  readonly openDropped: (file: DroppedFileRef) => void;
  /** The locate prompt's "Locate…" (native picker) and Cancel. */
  readonly locateData: () => void;
  readonly cancelLocate: () => void;
  /** The mismatch banner's "Locate…" and "Continue". */
  readonly relinkData: () => void;
  readonly dismissMismatch: () => void;
  readonly restoreRecovery: (id: string) => void;
  readonly discardRecovery: (id: string) => void;
}

export interface WorkspaceFilesOptions {
  readonly api: WorkspaceFilesApi | null;
  readonly workspace: AppWorkspace;
  readonly engine: Pick<EngineClientLike, 'open'>;
  readonly shell: Pick<PlatformWindow, 'onCloseRequest' | 'setDocumentChrome'>;
  readonly state: WorkspaceState;
  readonly toast: (toast: WorkspaceToast) => void;
}

/** `.glassgrid` by extension (dropped files are routed by name). */
export function isWorkspaceFileName(name: string): boolean {
  return name.toLowerCase().endsWith(`.${WORKSPACE_FILE_EXTENSION}`);
}

const dateTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/** "trips.csv has changed since this workspace was saved (1.20 MB → 1.31 MB, contents differ). Charts may differ from when it was saved." */
export function describeMismatch(dataFileName: string, mismatch: FingerprintMismatch): string {
  const details: string[] = [];
  if (mismatch.sizeBytes) details.push(`${formatBytes(mismatch.sizeBytes.expected)} → ${formatBytes(mismatch.sizeBytes.actual)}`);
  if (mismatch.contentChanged) details.push('contents differ');
  else if (mismatch.mtimeMs && !mismatch.sizeBytes) details.push(`modified ${dateTime.format(mismatch.mtimeMs.actual)}`);
  const detail = details.length > 0 ? ` (${details.join(', ')})` : '';
  return `${dataFileName} has changed since this workspace was saved${detail}. Charts and counts may differ from when it was saved.`;
}

/** What the window title shows: the workspace file, else the data file. */
export function documentTitle(state: Pick<WorkspaceState, 'document' | 'dataSource'>): string | null {
  return state.document?.fileName ?? state.dataSource?.fileName ?? null;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useWorkspaceFiles({ api, workspace, engine, shell, state, toast }: WorkspaceFilesOptions): WorkspaceFilesUi {
  const { registry, store } = workspace;
  const enabled = api !== null;
  const edited = enabled && isWorkspaceDirty(state);
  const [running, setRunning] = useState(0);
  const [recent, setRecent] = useState<readonly RecentWorkspace[]>([]);
  const [recovery, setRecovery] = useState<readonly RecoverySnapshotInfo[]>([]);
  const [locate, setLocate] = useState<LocatePrompt | null>(null);
  const [mismatch, setMismatch] = useState<MismatchNotice | null>(null);
  const mismatchRef = useRef<MismatchNotice | null>(null);
  const showMismatch = useCallback((next: MismatchNotice | null) => {
    mismatchRef.current = next;
    setMismatch(next);
  }, []);
  const [recentVersion, setRecentVersion] = useState(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const deps = useMemo(
    () => (api === null ? null : { registry, bridge: api, openTable: async (handle: Parameters<EngineClientLike['open']>[0]) => (await engine.open(handle)).table }),
    [api, registry, engine],
  );

  // The workspace commands (saveWorkspace, saveWorkspaceAs, openWorkspace, listRecentWorkspaces) on this window's registry.
  useEffect(() => (deps === null ? undefined : provideWorkspacePersistence(deps)), [deps]);

  // The one autosave path: unsaved work goes to the host's crash-recovery autosaver as it changes.
  useEffect(() => (api === null ? undefined : reportUnsavedWork(store, (update) => api.updateRecovery(update))), [api, store]);

  // "Save changes before closing?": the shell asks, the answer says whether there is unsaved work and what to save.
  useEffect(() => (api === null ? undefined : shell.onCloseRequest?.(() => closeAnswer(store.getState()))), [api, shell, store]);

  // Native chrome: title, macOS represented file and edited dot.
  const title = documentTitle(state);
  const documentId = state.document?.id ?? null;
  useEffect(() => {
    shell.setDocumentChrome?.({ title, edited, documentId });
  }, [shell, title, edited, documentId]);

  /** Runs an operation with the busy flag; errors become an error toast. */
  const run = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
      setRunning((count) => count + 1);
      try {
        return await operation();
      } catch (cause) {
        if (live.current) toast({ tone: 'error', message: messageOf(cause) });
        return undefined;
      } finally {
        if (live.current) setRunning((count) => count - 1);
      }
    },
    [toast],
  );

  const forgetToken = useCallback(
    (token: string | null) => {
      if (token !== null) void api?.cancelOpen(token).catch(() => undefined);
    },
    [api],
  );

  /** Reports what an open came to: the locate prompt, the mismatch banner, a toast. */
  const settle = useCallback(
    (outcome: OpenWorkspaceOutcome | undefined, prompt: LocatePrompt | null = null) => {
      if (!live.current || outcome === undefined) return;
      switch (outcome.status) {
        case 'cancelled':
          return;
        case 'failed':
          if (prompt !== null && outcome.code !== 'not_found') {
            setLocate({ ...prompt, error: outcome.message });
            return;
          }
          setLocate(null);
          toast({ tone: 'error', message: outcome.message });
          return;
        case 'needsData':
          setLocate({ token: outcome.token, dataFileName: outcome.dataFileName, workspaceName: outcome.workspaceFile?.fileName ?? null, error: null });
          return;
        case 'opened': {
          setLocate(null);
          setRecentVersion((version) => version + 1);
          const handleId = store.getState().dataSource?.handleId ?? '';
          const previous = mismatchRef.current;
          if (previous !== null && previous.relinkToken !== outcome.relinkToken) forgetToken(previous.relinkToken);
          showMismatch(
            outcome.fingerprintMismatch === null
              ? null
              : { handleId, dataFileName: outcome.dataFileName, message: describeMismatch(outcome.dataFileName, outcome.fingerprintMismatch), relinkToken: outcome.relinkToken },
          );
          const name = outcome.workspaceFile?.fileName ?? outcome.dataFileName;
          const first = outcome.warnings.find((warning) => warning.code !== 'migrated') ?? outcome.warnings[0];
          const more = outcome.warnings.length > 1 ? ` (${outcome.warnings.length - 1} more ${outcome.warnings.length === 2 ? 'change' : 'changes'})` : '';
          toast({
            tone: 'info',
            message: `${outcome.recovered ? 'Restored unsaved changes to' : 'Opened'} ${name}${first ? `. ${first.message}${more}` : ''}`,
          });
          return;
        }
      }
    },
    [store, toast, forgetToken, showMismatch],
  );

  const open = useCallback(
    (request: OpenWorkspaceRequest) => {
      void run(async () => (await registry.dispatch('openWorkspace', request, { caller: 'user' })).value as OpenWorkspaceOutcome).then((outcome) => settle(outcome));
    },
    [registry, run, settle],
  );

  const save = useCallback(
    (saveAs: boolean) => {
      if (!enabled) return;
      void run(async () => (await registry.dispatch(saveAs ? 'saveWorkspaceAs' : 'saveWorkspace', {}, { caller: 'user' })).value as SaveWorkspaceOutcome).then(
        (outcome) => {
          if (!live.current || outcome === undefined) return;
          if (outcome.status === 'saved') {
            setRecentVersion((version) => version + 1);
            toast({ tone: 'info', message: `Saved ${outcome.workspaceFile.fileName}` });
          } else if (outcome.status === 'failed') {
            toast({ tone: 'error', message: outcome.message });
          }
        },
      );
    },
    [enabled, registry, run, toast],
  );

  const runMenuCommand = useCallback(
    (command: WorkspaceMenuCommand) => {
      if (!enabled) return;
      if (command.kind === 'saveWorkspace') save(false);
      else if (command.kind === 'saveWorkspaceAs') save(true);
      else if (command.kind === 'openWorkspace') open({ source: 'dialog' });
      else open({ source: 'recent', id: command.id });
    },
    [enabled, save, open],
  );

  const openDropped = useCallback(
    (file: DroppedFileRef) => {
      if (deps === null) return;
      void run(async () => completeWorkspaceOpen(deps, await deps.bridge.openDropped(file))).then((outcome) => settle(outcome));
    },
    [deps, run, settle],
  );

  const locateData = useCallback(() => {
    if (deps === null || locate === null) return;
    const prompt = locate;
    void run(() => locateWorkspaceData(deps, prompt.token)).then((outcome) => settle(outcome, prompt));
  }, [deps, locate, run, settle]);

  const cancelLocate = useCallback(() => {
    if (locate === null) return;
    forgetToken(locate.token);
    setLocate(null);
    // A recovery snapshot whose data was not found is still on disk: offer it again.
    setRecentVersion((version) => version + 1);
  }, [locate, forgetToken]);

  const relinkData = useCallback(() => {
    const token = mismatch?.relinkToken ?? null;
    if (deps === null || token === null) return;
    void run(() => locateWorkspaceData(deps, token)).then((outcome) => settle(outcome));
  }, [deps, mismatch, run, settle]);

  const dismissMismatch = useCallback(() => {
    forgetToken(mismatchRef.current?.relinkToken ?? null);
    showMismatch(null);
  }, [forgetToken, showMismatch]);

  const restoreRecovery = useCallback(
    (id: string) => {
      if (deps === null || api === null) return;
      void run(async () => completeWorkspaceOpen(deps, await api.restoreRecovery(id))).then((outcome) => {
        settle(outcome);
        if (live.current) setRecentVersion((version) => version + 1);
      });
    },
    [deps, api, run, settle],
  );

  const discardRecovery = useCallback(
    (id: string) => {
      if (api === null) return;
      setRecovery((entries) => entries.filter((entry) => entry.id !== id));
      void run(() => api.discardRecovery(id)).then(() => {
        if (live.current) setRecentVersion((version) => version + 1);
      });
    },
    [api, run],
  );

  // Files the OS opened with the app (double-click, Open with, a second launch).
  useEffect(() => api?.onOpenRequest(({ token }) => open({ source: 'external', token })), [api, open]);

  // The start screen's lists: recent workspaces and unsaved work from earlier sessions (crash recovery).
  const startScreen = state.dataSource === null;
  useEffect(() => {
    if (api === null || !startScreen) return;
    const current = { live: true };
    api.listRecent().then(
      (entries) => current.live && setRecent(entries),
      () => undefined,
    );
    api.listRecovery().then(
      (entries) => current.live && setRecovery(entries),
      () => undefined,
    );
    return () => {
      current.live = false;
    };
  }, [api, startScreen, recentVersion]);

  // The mismatch notice is about one data source; showing another one (another file, undo) retires it.
  const shownHandle = state.dataSource?.handleId ?? null;
  const shownMismatch = mismatch !== null && mismatch.handleId === shownHandle ? mismatch : null;
  useEffect(() => {
    const current = mismatchRef.current;
    if (current !== null && current.handleId !== shownHandle) {
      forgetToken(current.relinkToken);
      showMismatch(null);
    }
  }, [shownHandle, forgetToken, showMismatch]);

  return {
    enabled,
    edited,
    busy: running > 0,
    recent: enabled ? recent : [],
    recovery: enabled ? recovery : [],
    locate,
    mismatch: shownMismatch,
    save,
    open,
    runMenuCommand,
    openDropped,
    locateData,
    cancelLocate,
    relinkData,
    dismissMismatch,
    restoreRecovery,
    discardRecovery,
  };
}
