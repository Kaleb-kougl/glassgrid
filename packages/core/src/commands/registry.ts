import { z } from 'zod';
import type { WorkspaceState } from '../state/workspace.js';
import { type AnyCommand, type Caller, CallerSchema, type EffectCommand, type Tier } from './define.js';
import { CommandError, invalidInput } from './errors.js';
import type { WorkspaceStore } from './store.js';

/** What a policy hook is asked about. */
export interface AuthorizationRequest {
  readonly command: string;
  readonly tier: Tier;
  readonly caller: Caller;
  /** The validated input. */
  readonly input: unknown;
}

export type PolicyHook = (request: AuthorizationRequest) => boolean | Promise<boolean>;

/**
 * Host-supplied gates for the tiers that touch the outside world. A missing
 * hook means the tier is refused. `read` and `edit` never consult the policy.
 */
export interface CommandPolicy {
  /** `write` tier: e.g. show an in-app confirmation for AI callers, allow user clicks. */
  readonly confirmWrite?: PolicyHook;
  /** `raw` tier: e.g. return the per-workspace raw-row opt-in flag from app state. */
  readonly allowRaw?: PolicyHook;
}

export interface DispatchOptions {
  readonly caller: Caller;
}

export interface DispatchResult {
  /** State after the command. Callers should act on this, never on a cached copy. */
  readonly state: WorkspaceState;
  /**
   * The history entry the call recorded, or for `undo`/`redo` the entry it
   * moved. Null when nothing was recorded (no-op, read, effect or
   * `undoable: false` command, empty history).
   */
  readonly entryId: string | null;
  /** What an effect command's handler returned (plain JSON), e.g. what was copied. */
  readonly value?: unknown;
}

/** What an effect handler is told besides its validated input. */
export interface EffectContext {
  readonly caller: Caller;
  /** The workspace state when the command runs. */
  readonly state: WorkspaceState;
}

/** The host's implementation of an effect command. Its return value becomes `DispatchResult.value`. */
export type EffectHandler = (input: unknown, ctx: EffectContext) => unknown;

export type JsonSchema = z.core.JSONSchema.BaseSchema;

/** One row of `list()`; also the payload of MCP `list_commands`. */
export interface CommandInfo {
  readonly name: string;
  readonly description: string;
  readonly tier: Tier;
  readonly mcp: { readonly exposed: true } | { readonly exposed: false; readonly exemptReason: string };
  /** JSON Schema (draft 2020-12) of the input, as a caller must send it. */
  readonly inputSchema: JsonSchema;
}

const COMMAND_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;

/**
 * One registry for every caller. Buttons, menus, shortcuts and drag-drop call
 * `dispatch` with `caller: 'user'`; the MCP bridge calls it with `caller: 'ai'`.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, { command: AnyCommand; info: CommandInfo }>();
  private readonly store: WorkspaceStore;
  private readonly policy: CommandPolicy;
  private readonly effects = new Map<string, EffectHandler>();

  constructor(store: WorkspaceStore, options: { policy?: CommandPolicy } = {}) {
    this.store = store;
    this.policy = options.policy ?? {};
  }

  register(command: AnyCommand): this {
    if (!COMMAND_NAME.test(command.name)) {
      throw new Error(`Command name "${command.name}" must be camelCase ASCII`);
    }
    if (this.commands.has(command.name)) {
      throw new Error(`Command "${command.name}" is already registered`);
    }
    const mcp = describeMcp(command);
    if (mcp === null) {
      throw new Error(`Command "${command.name}" must declare mcp: true or mcp: { exempt: '<reason>' }`);
    }
    const info: CommandInfo = Object.freeze({
      name: command.name,
      description: command.description,
      tier: command.tier,
      mcp,
      inputSchema: z.toJSONSchema(command.input, { io: 'input' }),
    });
    this.commands.set(command.name, { command, info });
    return this;
  }

  /**
   * Implements a registered effect command (e.g. `copySelection` with the
   * app's clipboard). One handler per command; providing again replaces it.
   * Returns a function that removes this handler.
   */
  provide(name: string, handler: EffectHandler): () => void {
    const entry = this.commands.get(name);
    if (entry?.command.kind !== 'effect') throw new Error(`"${name}" is not a registered effect command`);
    this.effects.set(name, handler);
    return () => {
      if (this.effects.get(name) === handler) this.effects.delete(name);
    };
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  /** Registered command definitions, in registration order. */
  definitions(): AnyCommand[] {
    return [...this.commands.values()].map((entry) => entry.command);
  }

  /** Every command with its tier, MCP exposure and input JSON Schema. */
  list(): CommandInfo[] {
    return [...this.commands.values()].map((entry) => entry.info);
  }

  /**
   * Validates and runs a command.
   *
   * `read` and `edit` commands apply synchronously, before this returns, so UI
   * dispatches keep their order. `write` and `raw` commands wait for the
   * policy hook. Rejects with `CommandError` for anything the caller can fix.
   */
  dispatch(name: string, rawInput: unknown, options: DispatchOptions): Promise<DispatchResult> {
    try {
      const { command, input, caller } = this.prepare(name, rawInput, options);
      const hook = command.tier === 'write' ? this.policy.confirmWrite : command.tier === 'raw' ? this.policy.allowRaw : null;
      if (hook === null) {
        return command.kind === 'effect' ? this.runEffect(command, input, caller) : Promise.resolve(this.run(command, input, caller));
      }
      if (hook === undefined) {
        return Promise.reject(
          new CommandError('forbidden', `"${name}" is a ${command.tier}-tier command and this host does not allow it`, {
            command: name,
          }),
        );
      }
      const request: AuthorizationRequest = { command: name, tier: command.tier, caller, input };
      return Promise.resolve(hook(request)).then((allowed) => {
        if (!allowed) {
          throw new CommandError('forbidden', `"${name}" was not allowed (${command.tier} tier)`, { command: name });
        }
        return command.kind === 'effect' ? this.runEffect(command, input, caller) : this.run(command, input, caller);
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private prepare(
    name: string,
    rawInput: unknown,
    options: DispatchOptions,
  ): { command: AnyCommand; input: unknown; caller: Caller } {
    const callerResult = CallerSchema.safeParse((options as Partial<DispatchOptions> | undefined)?.caller);
    if (!callerResult.success) {
      throw new CommandError('invalid_caller', `Unknown caller; expected one of ${CallerSchema.options.join(', ')}`);
    }
    const caller = callerResult.data;
    // The MCP bridge forwards names from outside; do not trust the static type.
    if (typeof (name as unknown) !== 'string') {
      throw new CommandError('unknown_command', 'Command name must be a string; call list_commands for the list');
    }
    const entry = this.commands.get(name);
    if (entry === undefined) {
      throw new CommandError('unknown_command', `Unknown command "${name.slice(0, 80)}"; call list_commands for the list`, {
        command: name,
      });
    }
    const { command, info } = entry;
    if (caller === 'ai' && !info.mcp.exposed) {
      throw new CommandError('forbidden', `"${name}" is not available to AI callers: ${info.mcp.exemptReason}`, {
        command: name,
      });
    }
    // Commands without arguments may be called without an input object.
    const parsed = command.input.safeParse(rawInput === undefined ? {} : rawInput);
    if (!parsed.success) throw invalidInput(name, parsed.error);
    if (command.kind === 'effect') command.checkCaller?.(parsed.data, caller);
    return { command, input: parsed.data, caller };
  }

  private async runEffect(command: EffectCommand, input: unknown, caller: Caller): Promise<DispatchResult> {
    const handler = this.effects.get(command.name);
    if (handler === undefined) {
      throw new CommandError('unavailable', `"${command.name}" is not available in this app right now`, { command: command.name });
    }
    const value = await handler(input, { caller, state: this.store.getState() });
    return { state: this.store.getState(), entryId: null, value };
  }

  private run(command: Exclude<AnyCommand, EffectCommand>, input: unknown, caller: Caller): DispatchResult {
    let entryId: string | null;
    if (command.kind === 'history') {
      const moved = command.direction === 'undo' ? this.store.undo() : this.store.redo();
      entryId = moved?.id ?? null;
    } else {
      const entry = this.store.commit(
        { name: command.name, caller, input },
        (draft, ctx) => {
          command.apply(draft, input, ctx);
        },
        { readOnly: command.tier === 'read', record: command.undoable !== false },
      );
      entryId = entry?.id ?? null;
    }
    return { state: this.store.getState(), entryId };
  }
}

function describeMcp(command: AnyCommand): CommandInfo['mcp'] | null {
  const mcp: unknown = command.mcp;
  if (mcp === true) return { exposed: true };
  if (typeof mcp === 'object' && mcp !== null && 'exempt' in mcp) {
    const reason = mcp.exempt;
    if (typeof reason === 'string' && reason.trim() !== '') return { exposed: false, exemptReason: reason };
  }
  return null;
}
