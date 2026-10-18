import { z } from 'zod';
import { isNumericType, isTemporalType, type CompileColumn } from '../spec/column.js';
import { FilterSchema, type Filter, type FilterInput, type FilterValue, type RangeBound } from '../spec/filter.js';
import { parseTemporal } from './bins.js';
import { Params, quoteIdent, type CompiledQuery } from './builder.js';
import { ColumnIndex } from './columns.js';
import { CompileError } from './errors.js';

const TEMPORAL_HINT = 'an ISO date or timestamp string such as "2024-01-31" or "2024-01-31 12:00:00", or integer epoch milliseconds';

/** Parse with a Zod schema, turning failures into an `invalid_spec` CompileError. */
export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new CompileError('invalid_spec', `Invalid ${what}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function temporalValue(value: RangeBound | FilterValue, params: Params, path: string, column: CompileColumn): string {
  if (typeof value === 'string' && parseTemporal(value) !== null) return params.timestamp(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return params.epochMs(value);
  throw new CompileError(
    'type_mismatch',
    `${path} must be ${TEMPORAL_HINT} because column ${JSON.stringify(column.name)} is a ${column.type}; got ${JSON.stringify(value)}`,
    path,
  );
}

function rangeBound(column: CompileColumn, value: RangeBound, params: Params, path: string): string {
  if (isNumericType(column.type)) {
    if (typeof value !== 'number') {
      throw new CompileError(
        'type_mismatch',
        `${path} must be a number because column ${JSON.stringify(column.name)} is ${column.type}; got ${JSON.stringify(value)}`,
        path,
      );
    }
    return params.double(value);
  }
  return temporalValue(value, params, path, column);
}

function setValue(column: CompileColumn, value: Exclude<FilterValue, null>, params: Params, path: string): string {
  const mismatch = (expected: string) =>
    new CompileError(
      'type_mismatch',
      `${path} must be ${expected} because column ${JSON.stringify(column.name)} is ${column.type}; got ${JSON.stringify(value)}`,
      path,
    );
  switch (column.type) {
    case 'text':
      if (typeof value !== 'string') throw mismatch('a string');
      return params.text(value);
    case 'boolean':
      if (typeof value !== 'boolean') throw mismatch('true or false');
      return params.boolean(value);
    case 'integer':
    case 'float':
    case 'decimal':
      if (typeof value !== 'number') throw mismatch('a number');
      return params.double(value);
    case 'date':
    case 'timestamp':
      return temporalValue(value, params, path, column);
  }
}

export function compileFilter(filter: Filter, columns: ColumnIndex, params: Params, path: string): string {
  const column = columns.get(filter.column, `${path}.column`);
  const ref = quoteIdent(column.name);
  switch (filter.kind) {
    case 'isNull':
      return `${ref} IS NULL`;
    case 'notNull':
      return `${ref} IS NOT NULL`;
    case 'range': {
      if (!isNumericType(column.type) && !isTemporalType(column.type)) {
        throw new CompileError(
          'type_mismatch',
          `Range filters need a numeric, date or timestamp column, but ${JSON.stringify(column.name)} is ${column.type}. Use an "in" filter to select values.`,
          `${path}.column`,
        );
      }
      const parts: string[] = [];
      if (filter.min !== undefined) {
        parts.push(`${ref} ${filter.minInclusive ? '>=' : '>'} ${rangeBound(column, filter.min, params, `${path}.min`)}`);
      }
      if (filter.max !== undefined) {
        parts.push(`${ref} ${filter.maxInclusive ? '<=' : '<'} ${rangeBound(column, filter.max, params, `${path}.max`)}`);
      }
      return parts.length === 1 ? (parts[0] ?? 'TRUE') : `(${parts.join(' AND ')})`;
    }
    case 'in':
    case 'notIn': {
      const placeholders: string[] = [];
      let listsNull = false;
      for (const [i, value] of filter.values.entries()) {
        if (value === null) listsNull = true;
        else placeholders.push(setValue(column, value, params, `${path}.values[${i}]`));
      }
      const list = placeholders.join(', ');
      if (filter.kind === 'in') {
        const inList = placeholders.length > 0 ? `${ref} IN (${list})` : null;
        if (inList && listsNull) return `(${inList} OR ${ref} IS NULL)`;
        if (inList) return inList;
        return listsNull ? `${ref} IS NULL` : 'FALSE';
      }
      // NOT IN over a non-NULL value list is NULL (no match) for NULL cells, which is right when null is listed.
      if (placeholders.length === 0) return listsNull ? `${ref} IS NOT NULL` : 'TRUE';
      return listsNull ? `${ref} NOT IN (${list})` : `(${ref} NOT IN (${list}) OR ${ref} IS NULL)`;
    }
  }
}

/**
 * Compile already-validated filters into predicates (one per filter), adding
 * their values to `params`. Internal building block of every compile function.
 */
export function filterPredicates(
  filters: readonly Filter[],
  columns: ColumnIndex,
  params: Params,
  pathPrefix = 'filters',
): string[] {
  return filters.map((filter, i) => compileFilter(filter, columns, params, `${pathPrefix}[${i}]`));
}

/** `\nWHERE a\n  AND b`, or '' when there are no predicates. */
export function whereClause(predicates: readonly string[]): string {
  return predicates.length === 0 ? '' : `\nWHERE ${predicates.join('\n  AND ')}`;
}

/**
 * Compile filters to one boolean SQL expression (`TRUE` when there are none),
 * with parameters numbered from `$1`. The filters are ANDed together.
 */
export function compileWhere(filters: readonly FilterInput[], columns: readonly CompileColumn[]): CompiledQuery {
  const parsed = parseOrThrow(z.array(FilterSchema), filters, 'filters');
  const params = new Params();
  const predicates = filterPredicates(parsed, new ColumnIndex(columns), params);
  return { sql: predicates.length === 0 ? 'TRUE' : predicates.join(' AND '), params: params.values };
}
