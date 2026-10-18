import { z } from 'zod';

export const WorkspaceFileErrorCodeSchema = z.enum([
  /** Not JSON at all. */
  'invalid_json',
  /** JSON, but not a Glassgrid workspace (no numeric `formatVersion`). */
  'not_a_workspace',
  /** Written by a newer Glassgrid in a format this version cannot read. */
  'newer_version',
  /** An old format version with no migration (should not happen for released versions). */
  'unsupported_version',
  /** The right version, but the content does not validate. */
  'invalid_file',
]);
export type WorkspaceFileErrorCode = z.infer<typeof WorkspaceFileErrorCodeSchema>;

export interface WorkspaceFileIssue {
  readonly path: string;
  readonly message: string;
}

/** Why a workspace file could not be read. `message` is written for the person. */
export class WorkspaceFileError extends Error {
  override readonly name = 'WorkspaceFileError';
  readonly code: WorkspaceFileErrorCode;
  readonly issues: readonly WorkspaceFileIssue[];

  constructor(code: WorkspaceFileErrorCode, message: string, issues: readonly WorkspaceFileIssue[] = []) {
    super(message);
    this.code = code;
    this.issues = issues;
  }
}

export function isWorkspaceFileError(error: unknown): error is WorkspaceFileError {
  return error instanceof WorkspaceFileError;
}

const MAX_ISSUES = 20;

/** Zod issues as `{ path, message }`, at most 20. */
export function fileIssues(error: z.ZodError, prefix: readonly PropertyKey[] = []): WorkspaceFileIssue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: [...prefix, ...issue.path].map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`)).join('').replace(/^\./, '') || '(root)',
    message: issue.message,
  }));
}
