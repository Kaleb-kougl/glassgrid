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
   * Whether a change is recorded on the undo stack (default true). Set
   * `false` only for ephemeral view state that a person would not expect
   * Undo to step through, such as the grid selection: the change is applied
   * and broadcast like any other, but records no entry and keeps the redo
   * stack. Undo and redo replay recorded entries' patches, which may
   * overwrite such state (undoing `openFile` brings back the previous
   * file's selection), so keep it to state where that is harmless.
   */
  readonly undoable?: boolean;
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

/**
 * A command whose effect is outside the workspace state, such as copying
 * cells to the clipboard. Core declares it (name, schema, tier, MCP
 * exposure) so every caller sees it in one registry and the tier policy
 * applies; the host implements it with `registry.provide(name, handler)`,
 * because the effect needs the host's runtime (DOM, preload bridge). It
 * never changes state and is never recorded on the undo stack.
 */
export interface EffectCommand<S extends z.ZodType = z.ZodType> {
  readonly kind: 'effect';
  readonly name: string;
  readonly description: string;
  readonly input: S;
  readonly tier: Tier;
  readonly mcp: McpExposure;
  /**
   * Optional per-input caller rule, checked after validation and before the
   * tier policy and the host's handler. Throw `CommandError('forbidden', …)`
   * to refuse, e.g. `openWorkspace` lets AI callers open only recent
   * workspaces. Core declares it so every host enforces the same rule.
   */
  checkCaller?(input: z.output<S>, caller: Caller): void;
}

export type AnyCommand = StateCommand | HistoryCommand | EffectCommand;

/** Declares an effect command; the host supplies its implementation with `registry.provide`. */
export function defineEffect<S extends z.ZodType>(spec: Omit<EffectCommand<S>, 'kind'>): EffectCommand<S> {
  return Object.freeze({ ...spec, kind: 'effect' as const });
}

/** Declares a state command. The returned object is what you register. */
export function defineCommand<S extends z.ZodType>(spec: CommandSpec<S>): StateCommand<S> {
  return Object.freeze({ ...spec, kind: 'state' as const });
}
