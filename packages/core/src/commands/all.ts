import { createInitialWorkspaceState, type WorkspaceState } from '../state/workspace.js';
import { redo, undo } from './builtins/history.js';
import { addChart, removeChart, renameChart, setMark, setShelf } from './builtins/charts.js';
import { addFilter, brush, clearFilter, setFilter } from './builtins/filters.js';
import { copySelection, reorderColumn, resizeColumn, setSelection, sortGrid } from './builtins/grid.js';
import { openFile, setColumnProfiles } from './builtins/open-file.js';
import { setColumnType } from './builtins/set-column-type.js';
import {
  listRecentWorkspaces,
  loadWorkspace,
  markWorkspaceSaved,
  openWorkspace,
  saveWorkspace,
  saveWorkspaceAs,
} from './builtins/workspace.js';
import type { AnyCommand } from './define.js';
import { type CommandPolicy, CommandRegistry } from './registry.js';
import { WorkspaceStore, type WorkspaceStoreOptions } from './store.js';

/**
 * Every workspace command. New commands are added here so the parity test,
 * `list_commands` and the UI all see the same set.
 */
export const ALL_COMMANDS: readonly AnyCommand[] = Object.freeze([
  openFile,
  setColumnProfiles,
  setColumnType,
  sortGrid,
  resizeColumn,
  reorderColumn,
  setSelection,
  copySelection,
  setFilter,
  clearFilter,
  addFilter,
  brush,
  addChart,
  removeChart,
  renameChart,
  setShelf,
  setMark,
  saveWorkspace,
  saveWorkspaceAs,
  openWorkspace,
  listRecentWorkspaces,
  loadWorkspace,
  markWorkspaceSaved,
  undo,
  redo,
]);

export interface CreateWorkspaceOptions extends WorkspaceStoreOptions {
  readonly initialState?: WorkspaceState;
  readonly policy?: CommandPolicy;
}

/** Builds a store and a registry with every command registered. */
export function createWorkspace(options: CreateWorkspaceOptions): {
  store: WorkspaceStore;
  registry: CommandRegistry;
} {
  const store = new WorkspaceStore(options.initialState ?? createInitialWorkspaceState(), options);
  const registry = new CommandRegistry(store, options.policy === undefined ? {} : { policy: options.policy });
  for (const command of ALL_COMMANDS) registry.register(command);
  return { store, registry };
}
