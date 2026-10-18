import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { digestPersisted, WORKSPACE_FILE_EXTENSION, type ParsedWorkspace, type RecoveryUpdate } from '@glassgrid/core';
import { removeStaleTempFiles, writeFileAtomic } from './atomic-write';
import { readWorkspaceFile } from './workspace-io';

/*
 * Crash recovery. While a window has unsaved work, main writes it every few
 * seconds to `<userData>/recovery/<id>.glassgrid`: the normal workspace
 * format plus `recoveryOf` (which workspace file, if any, it belongs to),
 * written atomically. It is never written over the person's own file. A
 * clean save, "Don't Save" or a clean close deletes it; after a crash it
 * stays, and the next launch offers it ("Restore unsaved work") as long as
 * it is newer than the workspace file it belongs to.
 */

const RECOVERY_ID = /^rs_[A-Za-z0-9-]{8,64}$/;

export function newRecoveryId(): string {
  return `rs_${randomUUID()}`;
}

export interface RecoveryEntry {
  readonly id: string;
  readonly parsed: ParsedWorkspace;
  /** From `recoveryOf`: the workspace file the work belongs to, or null when untitled. */
  readonly workspacePath: string | null;
}

export class RecoveryStore {
  constructor(readonly dir: string) {}

  pathOf(id: string): string {
    if (!RECOVERY_ID.test(id)) throw new Error('Invalid recovery id');
    return join(this.dir, `${id}.${WORKSPACE_FILE_EXTENSION}`);
  }

  async write(id: string, text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.pathOf(id), text, { mode: 0o600 });
  }

  async remove(id: string): Promise<void> {
    await unlink(this.pathOf(id)).catch((error: unknown) => {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
    });
  }

  /** A snapshot, or null when it is missing or unreadable. */
  async read(id: string): Promise<RecoveryEntry | null> {
    try {
      const parsed = await readWorkspaceFile(this.pathOf(id));
      return { id, parsed, workspacePath: parsed.file.recoveryOf?.workspacePath ?? null };
    } catch {
      return null;
    }
  }

  /**
   * Snapshots worth offering, newest first. Deletes the ones that are not:
   * unreadable, not recovery snapshots, or older than the workspace file
   * they belong to (it was saved after the snapshot was taken). `exclude`
   * names snapshots that belong to windows open right now.
   */
  async list(exclude: ReadonlySet<string> = new Set()): Promise<RecoveryEntry[]> {
    await removeStaleTempFiles(this.dir);
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const entries: RecoveryEntry[] = [];
    for (const name of names) {
      const id = name.endsWith(`.${WORKSPACE_FILE_EXTENSION}`) ? name.slice(0, -WORKSPACE_FILE_EXTENSION.length - 1) : '';
      if (!RECOVERY_ID.test(id) || exclude.has(id)) continue;
      const entry = await this.read(id);
      if (entry?.parsed.file.recoveryOf === undefined) {
        await this.remove(id).catch(() => undefined);
        continue;
      }
      if (entry.workspacePath !== null) {
        const savedMs = await stat(entry.workspacePath).then((info) => info.mtimeMs, () => null);
        if (savedMs !== null && savedMs >= Date.parse(entry.parsed.file.savedAt)) {
          await this.remove(id).catch(() => undefined);
          continue;
        }
      }
      entries.push(entry);
    }
    return entries.sort((a, b) => Date.parse(b.parsed.file.savedAt) - Date.parse(a.parsed.file.savedAt));
  }
}

interface Slot {
  /** The latest update not yet written; `undefined` when there is nothing new. */
  pending: RecoveryUpdate | null | undefined;
  /** Digest of what the recovery file holds now, or null when there is no file. */
  written: string | null;
  /** Digest of the latest update reported (pending or written), or null when the last report was "clean". */
  latest: string | null;
  /** Writes for one slot run in order. */
  chain: Promise<void>;
}

export interface AutosaverOptions {
  /** How often pending work is written (default 5 s). */
  readonly intervalMs?: number;
  readonly write: (recoveryId: string, update: RecoveryUpdate) => Promise<void>;
  readonly remove: (recoveryId: string) => Promise<void>;
  readonly setInterval?: (run: () => void, ms: number) => { unref?(): void };
  readonly clearInterval?: (timer: unknown) => void;
}

export const DEFAULT_AUTOSAVE_INTERVAL_MS = 5_000;

function updateDigest(update: RecoveryUpdate): string {
  return `${update.snapshot.dataSource.handleId}:${digestPersisted(update.snapshot.workspace)}`;
}

/**
 * Writes each window's latest unsaved work at most every `intervalMs`, only
 * when it changed, and deletes the snapshot when the work becomes clean.
 */
export class Autosaver {
  private readonly slots = new Map<string, Slot>();
  private timer: unknown = null;
  private readonly intervalMs: number;

  constructor(private readonly options: AutosaverOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_AUTOSAVE_INTERVAL_MS;
  }

  start(): void {
    if (this.timer !== null) return;
    const set = this.options.setInterval ?? ((run, ms) => setInterval(run, ms));
    const timer = set(() => void this.flushAll(), this.intervalMs);
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer === null) return;
    (this.options.clearInterval ?? ((timer) => clearInterval(timer as NodeJS.Timeout)))(this.timer);
    this.timer = null;
  }

  /** Records the window's unsaved work (or null once it is clean); written on the next tick. */
  update(recoveryId: string, update: RecoveryUpdate | null): void {
    const slot = this.slot(recoveryId);
    slot.pending = update;
    slot.latest = update === null ? null : updateDigest(update);
  }

  /** Writes every slot's pending work now. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.slots.keys()].map((id) => this.flush(id)));
  }

  /** Writes one slot's pending work now (on close, so a hung renderer still leaves its latest work). */
  flush(recoveryId: string): Promise<void> {
    const slot = this.slots.get(recoveryId);
    if (!slot) return Promise.resolve();
    slot.chain = slot.chain.then(async () => {
      const update = slot.pending;
      if (update === undefined) return;
      slot.pending = undefined;
      if (update === null) {
        if (slot.written !== null) await this.options.remove(recoveryId);
        slot.written = null;
      } else {
        await this.options.write(recoveryId, update);
        slot.written = updateDigest(update);
      }
    }).catch((error: unknown) => console.error(`[autosave] could not write recovery snapshot ${recoveryId}`, error));
    return slot.chain;
  }

  /**
   * The work was saved to its file: delete the snapshot unless the window
   * reported newer work than what was saved (edits made while saving).
   */
  async saved(recoveryId: string, saved: RecoveryUpdate): Promise<void> {
    const slot = this.slots.get(recoveryId);
    if (!slot) {
      await this.options.remove(recoveryId).catch(() => undefined);
      return;
    }
    if (slot.latest !== null && slot.latest !== updateDigest(saved)) return;
    await this.discard(recoveryId);
  }

  /** Drops pending work and deletes the snapshot ("Don't Save", a clean close, "Discard"). */
  async discard(recoveryId: string): Promise<void> {
    const slot = this.slot(recoveryId);
    slot.pending = undefined;
    slot.latest = null;
    slot.chain = slot.chain.then(async () => {
      await this.options.remove(recoveryId);
      slot.written = null;
    }).catch((error: unknown) => console.error(`[autosave] could not delete recovery snapshot ${recoveryId}`, error));
    await slot.chain;
  }

  /** A window took over an existing snapshot (restored work): its file is now this slot's. */
  adopt(recoveryId: string): void {
    const slot = this.slot(recoveryId);
    slot.written ??= 'adopted';
  }

  /** Forgets a slot (after its window closed); its file, if any, stays for the next launch. */
  forget(recoveryId: string): void {
    this.slots.delete(recoveryId);
  }

  /** Whether the slot has a recovery file on disk right now. */
  hasSnapshot(recoveryId: string): boolean {
    return (this.slots.get(recoveryId)?.written ?? null) !== null;
  }

  private slot(recoveryId: string): Slot {
    let slot = this.slots.get(recoveryId);
    if (!slot) {
      slot = { pending: undefined, written: null, latest: null, chain: Promise.resolve() };
      this.slots.set(recoveryId, slot);
    }
    return slot;
  }
}
