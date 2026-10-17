import { createWorkspace, type CommandPolicy, type CommandRegistry, type WorkspaceStore } from '@glassgrid/core';

/*
 * One workspace (store + command registry) per window. Every UI event that
 * changes workspace state goes through `registry.dispatch`; React reads the
 * store with `useSyncExternalStore(store.subscribe, store.getState)`.
 */

export interface AppWorkspace {
  readonly store: WorkspaceStore;
  readonly registry: CommandRegistry;
}

/**
 * Desktop policy for the gated tiers.
 * - write: a person's own click is the confirmation; AI callers are refused
 *   until the confirmation UI exists (M6).
 * - raw: off until the per-workspace opt-in exists.
 */
export const desktopPolicy: CommandPolicy = {
  confirmWrite: (request) => request.caller === 'user',
  allowRaw: () => false,
};

export function createAppWorkspace(options: { clock?: () => number; newId?: (prefix: string) => string } = {}): AppWorkspace {
  return createWorkspace({
    clock: options.clock ?? (() => Date.now()),
    newId: options.newId ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`),
    policy: desktopPolicy,
  });
}
