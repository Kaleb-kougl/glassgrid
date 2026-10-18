import { makeBuilder, type Builder, type DataType, type Vector } from 'apache-arrow';

/**
 * `vectorFromArray(values, type)` without code generation. Arrow's builders
 * compile their null check with `new Function` whenever they are given null
 * values (`vectorFromArray` and `tableFromArrays` always are), which a
 * Content Security Policy without `'unsafe-eval'` refuses; the web build's
 * does. Same vector: `null` and `undefined` become NULL. Reading Arrow
 * (`tableFromIPC`) never needs this.
 */
export function vectorFromValues<T extends DataType>(values: Iterable<unknown>, type: T): Vector<T> {
  // Without null values the builder keeps its prototype's `_isValid` (`() => true`) and compiles nothing.
  const builder: Builder<T, null | undefined> = makeBuilder<T, null | undefined>({ type, nullValues: [] });
  (builder as unknown as { _isValid: (value: unknown) => boolean })._isValid = (value) => value !== null && value !== undefined;
  for (const value of values) builder.append(value);
  return builder.finish().toVector();
}
