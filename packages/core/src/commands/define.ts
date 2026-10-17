import type { Draft } from 'immer';
import { z } from 'zod';
import type { WorkspaceState } from '../state/workspace.js';

/** Who issued a command. Both share one registry, one undo stack and one set of rules. */
export const CallerSchema = z.enum(['user', 'ai']);
export type Caller = z.infer<typeof CallerSchema>;

/**
 * Permission tier (see "Permission tiers" in docs/technical-design.md).
 *
 * - `read`: never changes state; always runs.
 * - `edit`: changes the workspace; always runs and is undoable.
 * - `write`: writes files; runs only if the host's `confirmWrite` hook allows it.
 * - `raw`: reads rows beyond the visible grid; runs only if the host's
 *   `allowRaw` hook allows it (per-workspace opt-in).
 */
export const TierSchema = z.enum(['read', 'edit', 'write', 'raw']);
export type Tier = z.infer<typeof TierSchema>;

/**
 * Whether the MCP bridge exposes a command. Every command must say so: either
 * `true`, or an exemption with a reason that is also listed in
 * `mcp-exemptions.ts` (enforced by the parity test).
 */
export type McpExposure = true | { readonly exempt: string };

/** Everything a command's `apply` may use besides the draft and its input. */
export interface CommandContext {
  readonly caller: Caller;
  /** Timestamp of this dispatch from the injected clock. Never call `Date.now()` in `apply`. */
  readonly now: number;
  /** Fresh id from the injected generator, e.g. `newId('chart')`. Never use `Math.random()` in `apply`. */
  newId(prefix: string): string;
}

/** Input type of a command schema, as `apply` sees it after parsing. */
export type CommandInput<S extends z.ZodType> = z.output<S>;

export interface CommandSpec<S extends z.ZodType> {
  /** camelCase, unique in the registry, stable: MCP clients call it by name. */
  readonly name: string;
  /** One or two sentences; becomes the MCP tool description. */
  readonly description: string;
  /** Validates every call, from any caller. Prefer `z.strictObject` so typos are errors. */
  readonly input: S;
  readonly tier: Tier;
  readonly mcp: McpExposure;
  /**
   * Pure, synchronous state update on an Immer draft. Mutate the draft; do not
   * return a value. Throw `CommandError('precondition_failed', …)` when the
   * input does not fit the state; the draft is then discarded.
   */
  apply(draft: Draft<WorkspaceState>, input: CommandInput<S>, ctx: CommandContext): void;
}

/** A command that updates workspace state through `apply`. */
export interface StateCommand<S extends z.ZodType = z.ZodType> extends CommandSpec<S> {
  readonly kind: 'state';
}

/**
 * `undo` and `redo`. They are commands so every caller can reach them through
 * the registry, but they move along the history instead of applying a draft
 * and are never recorded as entries themselves.
 */
export interface HistoryCommand {
  readonly kind: 'history';
  readonly direction: 'undo' | 'redo';
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType;
  readonly tier: Tier;
  readonly mcp: McpExposure;
}

export type AnyCommand = StateCommand | HistoryCommand;

/** Declares a state command. The returned object is what you register. */
export function defineCommand<S extends z.ZodType>(spec: CommandSpec<S>): StateCommand<S> {
  return Object.freeze({ ...spec, kind: 'state' as const });
}
