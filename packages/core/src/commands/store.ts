import { applyPatches, type Draft, enablePatches, freeze, type Patch, produceWithPatches } from 'immer';
import type { WorkspaceState } from '../state/workspace.js';
import type { Caller, CommandContext } from './define.js';

enablePatches();

/** Returns the current time in milliseconds. Injected so core stays deterministic under test. */
export type Clock = () => number;
/** Returns a fresh, unique id starting with `prefix`. Injected for the same reason. */
export type IdGenerator = (prefix: string) => string;

/** One undoable step: the patches a command produced and how to reverse them. */
export interface UndoEntry {
  readonly id: string;
  /** Command name. */
  readonly name: string;
  readonly caller: Caller;
  /** The validated input the command ran with. */
  readonly input: unknown;
  readonly patches: readonly Patch[];
  readonly inversePatches: readonly Patch[];
  /** Clock time when the command was applied. */
  readonly at: number;
}

export interface HistorySnapshot {
  /** Applied entries, oldest first. The last one is undone next. */
  readonly past: readonly UndoEntry[];
  /** Undone entries, next to redo first. Cleared by any new state change. */
  readonly future: readonly UndoEntry[];
}

export interface WorkspaceStoreOptions {
  readonly clock: Clock;
  readonly newId: IdGenerator;
  /** Oldest entries beyond this many are dropped. Default 1000. */
  readonly historyLimit?: number;
}

export interface CommitMeta {
  readonly name: string;
  readonly caller: Caller;
  readonly input: unknown;
}

/**
 * The renderer's single source of workspace truth.
 *
 * State is immutable (Immer freezes it) and replaced on each change, so
 * `getState` and `getHistory` return stable references between changes and
 * work directly as `useSyncExternalStore` snapshots:
 *
 *   const state = useSyncExternalStore(store.subscribe, store.getState);
 *
 * Change state through the `CommandRegistry`, not by calling `commit` from UI
 * code: the registry is where validation, tiers and attribution happen.
 */
export class WorkspaceStore {
  private state: WorkspaceState;
  private history: HistorySnapshot = { past: [], future: [] };
  private readonly listeners = new Set<() => void>();
  private readonly clock: Clock;
  private readonly newId: IdGenerator;
  private readonly historyLimit: number;

  constructor(initial: WorkspaceState, options: WorkspaceStoreOptions) {
    // Copy through JSON: the store owns its state, and state must be plain JSON anyway.
    this.state = freeze(JSON.parse(JSON.stringify(initial)) as WorkspaceState, true);
    this.clock = options.clock;
    this.newId = options.newId;
    this.historyLimit = Math.max(1, options.historyLimit ?? 1000);
  }

  readonly getState = (): WorkspaceState => this.state;

  readonly getHistory = (): HistorySnapshot => this.history;

  /** Registers a listener called once after every state change. Returns the unsubscribe function. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  canUndo(): boolean {
    return this.history.past.length > 0;
  }

  canRedo(): boolean {
    return this.history.future.length > 0;
  }

  /**
   * Applies `recipe` to a draft of the state. If it changed anything, records
   * an undo entry, clears the redo stack and notifies subscribers once.
   * Returns the entry, or null for a no-op (nothing recorded or notified).
   * If `recipe` throws, state is untouched and the error propagates.
   */
  commit(
    meta: CommitMeta,
    recipe: (draft: Draft<WorkspaceState>, ctx: CommandContext) => void,
    options: { readOnly?: boolean } = {},
  ): UndoEntry | null {
    const now = this.clock();
    const ctx: CommandContext = { caller: meta.caller, now, newId: this.newId };
    const [next, patches, inversePatches] = produceWithPatches(this.state, (draft) => {
      recipe(draft, ctx);
    });
    if (patches.length === 0) return null;
    if (options.readOnly === true) {
      throw new Error(`Read-tier command "${meta.name}" tried to change state`);
    }
    const entry: UndoEntry = Object.freeze({
      id: this.newId('entry'),
      name: meta.name,
      caller: meta.caller,
      input: meta.input,
      patches,
      inversePatches,
      at: now,
    });
    const past = [...this.history.past, entry];
    if (past.length > this.historyLimit) past.splice(0, past.length - this.historyLimit);
    this.state = next;
    this.history = { past, future: [] };
    this.emit();
    return entry;
  }

  /** Reverts the latest entry. Returns it, or null if there is nothing to undo. */
  undo(): UndoEntry | null {
    const entry = this.history.past.at(-1);
    if (entry === undefined) return null;
    this.state = applyPatches(this.state, entry.inversePatches);
    this.history = { past: this.history.past.slice(0, -1), future: [entry, ...this.history.future] };
    this.emit();
    return entry;
  }

  /** Re-applies the most recently undone entry. Returns it, or null if there is nothing to redo. */
  redo(): UndoEntry | null {
    const [entry, ...rest] = this.history.future;
    if (entry === undefined) return null;
    this.state = applyPatches(this.state, entry.patches);
    this.history = { past: [...this.history.past, entry], future: rest };
    this.emit();
    return entry;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
