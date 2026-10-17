/**
 * Why a spec or query could not be compiled.
 * - `invalid_spec`: the input does not match its Zod schema.
 * - `unknown_column`: a channel, filter or sort key names a column the table lacks.
 * - `type_mismatch`: a column's type does not fit how it is used
 *   (e.g. `sum` of a text column, a range filter on a boolean).
 * - `unsupported`: a valid option that this mark does not take
 *   (e.g. `limit` on a histogram, `color` on a heatmap).
 * - `too_many_bins`: an explicit bin width would produce too many bins.
 */
export type CompileErrorCode = 'invalid_spec' | 'unknown_column' | 'type_mismatch' | 'unsupported' | 'too_many_bins';

/**
 * Thrown by every compile function. The message is written for end users and
 * AI models alike: it names the offending path and says what would be valid.
 */
export class CompileError extends Error {
  override readonly name = 'CompileError';

  constructor(
    readonly code: CompileErrorCode,
    message: string,
    /** Dotted path of the offending input, e.g. `y.aggregate` or `filters[1].column`. */
    readonly path?: string,
  ) {
    super(message);
  }
}

export function isCompileError(error: unknown): error is CompileError {
  return error instanceof CompileError;
}
