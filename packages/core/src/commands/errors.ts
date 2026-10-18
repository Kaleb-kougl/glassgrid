import type { z } from 'zod';

export type CommandErrorCode =
  /** No command with that name is registered. */
  | 'unknown_command'
  /** The caller is not one of the known callers. */
  | 'invalid_caller'
  /** The input failed the command's Zod schema; see `issues`. */
  | 'invalid_input'
  /** The tier policy, or the command's MCP exemption, refused the call. */
  | 'forbidden'
  /** The input was well formed but does not fit the current state. */
  | 'precondition_failed'
  /** An effect command this host has not implemented (see `CommandRegistry.provide`). */
  | 'unavailable';

export interface CommandIssue {
  /** Dotted path into the input, e.g. `columns[2].type`; empty for the root. */
  readonly path: string;
  readonly message: string;
}

/**
 * The one error type dispatch rejects with for anything a caller can fix.
 *
 * Messages are written for people and models alike: they name the command,
 * the offending field and what was expected, so an MCP client can return the
 * message as a tool error and let the model correct itself.
 */
export class CommandError extends Error {
  override readonly name = 'CommandError';
  readonly code: CommandErrorCode;
  readonly command: string | undefined;
  readonly issues: readonly CommandIssue[];

  constructor(code: CommandErrorCode, message: string, options: { command?: string; issues?: CommandIssue[] } = {}) {
    super(message);
    this.code = code;
    this.command = options.command;
    this.issues = options.issues ?? [];
  }

  /** Plain-JSON form for IPC and MCP tool errors. */
  toJSON(): { code: CommandErrorCode; message: string; command: string | undefined; issues: readonly CommandIssue[] } {
    return { code: this.code, message: this.message, command: this.command, issues: this.issues };
  }
}

export function isCommandError(value: unknown): value is CommandError {
  return value instanceof CommandError;
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`;
    else out += out === '' ? String(key) : `.${String(key)}`;
  }
  return out;
}

export function issuesFromZod(error: z.ZodError): CommandIssue[] {
  return error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message }));
}

export function invalidInput(command: string, error: z.ZodError): CommandError {
  const issues = issuesFromZod(error);
  const detail = issues.map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`)).join('; ');
  return new CommandError('invalid_input', `Invalid input for "${command}": ${detail}`, { command, issues });
}
