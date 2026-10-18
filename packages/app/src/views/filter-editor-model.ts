import { isNumericType, isTemporalType, type ColumnType, type FilterInput, type FilterValue } from '@glassgrid/core';

/*
 * The "+ Filter" editor's rules, free of React: which operators a column
 * type offers, and how the typed values become a filter for `addFilter`
 * (validated here so mistakes are named next to the field; the command
 * validates again against the compiler).
 */

export type FilterOperator = 'between' | 'atLeast' | 'atMost' | 'equals' | 'oneOf' | 'noneOf' | 'isNull' | 'notNull';

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  between: 'is between',
  atLeast: 'is at least',
  atMost: 'is at most',
  equals: 'equals',
  oneOf: 'is one of',
  noneOf: 'is none of',
  isNull: 'is empty',
  notNull: 'is not empty',
};

/** Operators for a column of `type`, the default first. */
export function operatorsFor(type: ColumnType): FilterOperator[] {
  if (isNumericType(type) || isTemporalType(type)) return ['between', 'atLeast', 'atMost', 'equals', 'isNull', 'notNull'];
  return ['oneOf', 'noneOf', 'isNull', 'notNull'];
}

/** How many value fields an operator takes: 0, 1, 2, or a list in one field. */
export function valueFields(operator: FilterOperator): 0 | 1 | 2 | 'list' {
  switch (operator) {
    case 'between':
      return 2;
    case 'atLeast':
    case 'atMost':
    case 'equals':
      return 1;
    case 'oneOf':
    case 'noneOf':
      return 'list';
    case 'isNull':
    case 'notNull':
      return 0;
  }
}

/** Placeholder text for a value field of `type`. */
export function valuePlaceholder(type: ColumnType, list: boolean): string {
  if (type === 'date') return '2024-03-01';
  if (type === 'timestamp') return '2024-03-01 08:00';
  if (isNumericType(type)) return list ? '1, 2, 3' : '0';
  if (type === 'boolean') return 'true, false';
  return list ? 'Cash, Credit card' : 'value';
}

export type FilterDraftResult = { ok: true; filter: FilterInput } | { ok: false; field: 'min' | 'max' | 'value'; message: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/;

function parseBound(text: string, type: ColumnType, field: 'min' | 'max' | 'value'): { ok: true; value: number | string } | { ok: false; field: 'min' | 'max' | 'value'; message: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, field, message: 'Enter a value' };
  if (isTemporalType(type)) {
    if (DATE.test(trimmed) || (type === 'timestamp' && TIMESTAMP.test(trimmed))) {
      const normalized = trimmed.replace('T', ' ');
      if (Number.isFinite(boundMs(normalized))) return { ok: true, value: normalized };
    }
    return { ok: false, field, message: type === 'date' ? 'Use a date like 2024-03-01' : 'Use a date like 2024-03-01 or 2024-03-01 08:00' };
  }
  const number = Number(trimmed.replaceAll(',', ''));
  if (!Number.isFinite(number)) return { ok: false, field, message: `“${trimmed}” is not a number` };
  if (type === 'integer' && !Number.isInteger(number)) return { ok: false, field, message: 'Use a whole number' };
  return { ok: true, value: number };
}

/** Epoch ms of a validated bound (numbers as they are). */
function boundMs(value: number | string): number {
  if (typeof value === 'number') return value;
  return Date.parse(value.length === 10 ? `${value}T00:00Z` : `${value.replace(' ', 'T')}Z`);
}

/** Values of a list field: comma separated, trimmed; numbers and booleans parsed for those types. */
function parseList(text: string, type: ColumnType): { ok: true; values: FilterValue[] } | { ok: false; message: string } {
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return { ok: false, message: 'Enter at least one value' };
  if (type === 'boolean') {
    const values: FilterValue[] = [];
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower !== 'true' && lower !== 'false') return { ok: false, message: `“${part}” is not true or false` };
      values.push(lower === 'true');
    }
    return { ok: true, values };
  }
  if (isNumericType(type)) {
    const values: FilterValue[] = [];
    for (const part of parts) {
      const number = Number(part);
      if (!Number.isFinite(number)) return { ok: false, message: `“${part}” is not a number` };
      values.push(number);
    }
    return { ok: true, values };
  }
  return { ok: true, values: [...new Set(parts)] };
}

/** The filter for the editor's fields, or the first problem with the field it concerns. */
export function buildFilter(
  columnName: string,
  type: ColumnType,
  operator: FilterOperator,
  values: { min: string; max: string; value: string },
): FilterDraftResult {
  switch (operator) {
    case 'isNull':
      return { ok: true, filter: { kind: 'isNull', column: columnName } };
    case 'notNull':
      return { ok: true, filter: { kind: 'notNull', column: columnName } };
    case 'between': {
      const min = parseBound(values.min, type, 'min');
      if (!min.ok) return min;
      const max = parseBound(values.max, type, 'max');
      if (!max.ok) return max;
      if (boundMs(min.value) > boundMs(max.value)) return { ok: false, field: 'max', message: 'The upper bound is below the lower bound' };
      return { ok: true, filter: { kind: 'range', column: columnName, min: min.value, max: max.value } };
    }
    case 'atLeast':
    case 'atMost': {
      const bound = parseBound(values.value, type, 'value');
      if (!bound.ok) return bound;
      return { ok: true, filter: { kind: 'range', column: columnName, ...(operator === 'atLeast' ? { min: bound.value } : { max: bound.value }) } };
    }
    case 'equals': {
      const bound = parseBound(values.value, type, 'value');
      if (!bound.ok) return bound;
      if (typeof bound.value === 'string') return { ok: true, filter: { kind: 'range', column: columnName, min: bound.value, max: bound.value } };
      return { ok: true, filter: { kind: 'in', column: columnName, values: [bound.value] } };
    }
    case 'oneOf':
    case 'noneOf': {
      const list = parseList(values.value, type);
      if (!list.ok) return { ok: false, field: 'value', message: list.message };
      return { ok: true, filter: { kind: operator === 'oneOf' ? 'in' : 'notIn', column: columnName, values: list.values } };
    }
  }
}
