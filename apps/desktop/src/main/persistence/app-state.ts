import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import type { RecentWorkspace } from '@glassgrid/core';
import { removeStaleTempFiles, writeFileAtomic } from './atomic-write';
import { isRegularFile } from './workspace-io';

/*
 * App state: `<userData>/state.json`, versioned JSON written atomically.
 * Kept out of workspace files on purpose (it is about this machine, not the
 * analysis). Today it holds the recent-workspaces list; window bounds,
 * settings, MCP settings and per-workspace raw-row access join it later.
 */

export const APP_STATE_VERSION = 1;
export const MAX_RECENT_WORKSPACES = 10;

const RecentEntrySchema = z.object({
  path: z.string().min(1),
  lastOpenedAt: z.string(),
});

const AppStateSchema = z.object({
  version: z.literal(APP_STATE_VERSION),
  recentWorkspaces: z.array(RecentEntrySchema).max(100),
});
export type AppState = z.infer<typeof AppStateSchema>;

function initialState(): AppState {
  return { version: APP_STATE_VERSION, recentWorkspaces: [] };
}

/** Stable opaque id of a recent entry: the renderer and agents name entries by it, never by path. */
export function recentWorkspaceId(path: string): string {
  return `rw_${createHash('sha256').update(path).digest('hex').slice(0, 24)}`;
}

export interface AppStateStoreOptions {
  readonly now?: () => Date;
  readonly isFile?: (path: string) => Promise<boolean>;
}

export class AppStateStore {
  private state: AppState | null = null;
  /** Writes run one after another so a slow write never overwrites a newer one. */
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly isFile: (path: string) => Promise<boolean>;

  constructor(
    readonly filePath: string,
    options: AppStateStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.isFile = options.isFile ?? isRegularFile;
  }

  /** Loads the file once; a missing, unreadable or newer-version file starts fresh (and is replaced on the next write). */
  async load(): Promise<AppState> {
    if (this.state) return this.state;
    let loaded = initialState();
    try {
      const parsed = AppStateSchema.safeParse(JSON.parse(await readFile(this.filePath, 'utf8')));
      if (parsed.success) loaded = parsed.data;
      else console.warn(`[app-state] ignoring ${this.filePath}: not a version-${APP_STATE_VERSION} app state file`);
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') console.warn(`[app-state] could not read ${this.filePath}`, error);
    }
    this.state ??= loaded;
    return this.state;
  }

  /** Puts `path` at the top of the recent list (deduplicated, at most 10). */
  async recordRecentWorkspace(path: string): Promise<void> {
    await this.update((state) => ({
      ...state,
      recentWorkspaces: [
        { path, lastOpenedAt: this.now().toISOString() },
        ...state.recentWorkspaces.filter((entry) => entry.path !== path),
      ].slice(0, MAX_RECENT_WORKSPACES),
    }));
  }

  /** The recent list, newest first, without files that no longer exist (which are pruned from the file too). */
  async listRecentWorkspaces(): Promise<RecentWorkspace[]> {
    const state = await this.load();
    const present = await Promise.all(state.recentWorkspaces.map((entry) => this.isFile(entry.path)));
    const missing = new Set(state.recentWorkspaces.filter((_, i) => !present[i]).map((entry) => entry.path));
    if (missing.size > 0) {
      await this.update((current) => ({ ...current, recentWorkspaces: current.recentWorkspaces.filter((entry) => !missing.has(entry.path)) }));
    }
    return (await this.load()).recentWorkspaces.map((entry) => ({
      id: recentWorkspaceId(entry.path),
      fileName: basename(entry.path),
      directory: dirname(entry.path),
      lastOpenedAt: entry.lastOpenedAt,
    }));
  }

  /** The path behind a recent id, if it is (still) in the list. */
  async recentWorkspacePath(id: string): Promise<string | undefined> {
    return (await this.load()).recentWorkspaces.find((entry) => recentWorkspaceId(entry.path) === id)?.path;
  }

  async removeRecentWorkspace(path: string): Promise<void> {
    await this.update((state) => ({ ...state, recentWorkspaces: state.recentWorkspaces.filter((entry) => entry.path !== path) }));
  }

  private update(change: (state: AppState) => AppState): Promise<void> {
    const run = this.queue.then(async () => {
      const next = change(await this.load());
      this.state = next;
      await mkdir(dirname(this.filePath), { recursive: true });
      await removeStaleTempFiles(dirname(this.filePath), { forName: basename(this.filePath) });
      await writeFileAtomic(this.filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    });
    this.queue = run.catch((error: unknown) => console.error('[app-state] could not save app state', error));
    return run;
  }
}
