import { DataType, DateUnit, TimeUnit, type Data, type Field, type Table, type Vector } from 'apache-arrow';
import type { FilterValue } from '@glassgrid/core';
import { filterValue, formatterFor, valueKind, type ValueKind } from '../grid/format.js';
import type { AxisKind, ChartCategory, ChartColumns, ChartMark, ChartSeries } from './types.js';

/*
 * Arrow result → typed columns, per the compiler's result contract
 * (docs/m1-compiler.md, "SQL shape per mark"):
 *
 * | mark          | columns                                  |
 * | ------------- | ---------------------------------------- |
 * | bar           | x, y                                     |
 * | histogram     | x, x_end, y                              |
 * | line / area   | x, y (M4: up to 4 rows per pixel column) |
 * | heatmap       | x, x_end, y, y_end, count                |
 * | scatter       | x, y                                     |
 *
 * plus `color` (NULL for "Other") and `color_other` BOOLEAN when the chart
 * has a colour field (at most 9 series). Numeric columns are copied straight
 * out of the Arrow buffers into Float64Arrays (NULL → NaN); temporal ones
 * become epoch milliseconds. Nothing allocates per row except bar
 * categories (at most 1,000) and BIGINT/DECIMAL conversions.
 */

/** Key of the folded "Other" series. Not valid JSON, so it never equals a value's key. */
export const OTHER_SERIES_KEY = '\u0000other';

/** JSON identity of a filter value: a bar's or a series' key. */
export function valueKey(value: FilterValue): string {
  return JSON.stringify(value);
}

function isValid(data: Data, i: number): boolean {
  if (data.nullCount === 0) return true;
  const bitmap = data.nullBitmap;
  if (bitmap.length === 0) return true;
  const bit = data.offset + i;
  return ((bitmap[bit >> 3] ?? 0) & (1 << (bit & 7))) !== 0;
}

/** Axis kind of an Arrow field. */
export function axisKindOf(field: Field | undefined): AxisKind {
  if (!field) return 'number';
  const type: unknown = field.type;
  if (DataType.isDate(type) || DataType.isTimestamp(type)) return 'time';
  if (DataType.isInt(type) || DataType.isFloat(type) || DataType.isDecimal(type)) return 'number';
  return 'category';
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return value === '' ? Number.NaN : Number(value);
  return Number.NaN;
}

/** Divisor from a Timestamp unit to milliseconds. */
function timestampScale(unit: TimeUnit): number {
  switch (unit) {
    case TimeUnit.SECOND:
      return 1e-3;
    case TimeUnit.MILLISECOND:
      return 1;
    case TimeUnit.MICROSECOND:
      return 1e3;
    default:
      return 1e6;
  }
}

/**
 * Copies a numeric or temporal column into `out` (NULL → NaN, time → epoch
 * ms) straight from the Arrow buffers; other types fall back to `get(i)`.
 */
export function fillNumbers(vector: Vector | null, out: Float64Array): void {
  if (!vector) {
    out.fill(Number.NaN);
    return;
  }
  let offset = 0;
  const vectorType: unknown = vector.type;
  const decimalScale = DataType.isDecimal(vectorType) ? vectorType.scale : null;
  for (const data of vector.data as Data[]) {
    const n = data.length;
    const type: unknown = data.type;
    const values: unknown = data.values;
    if ((DataType.isFloat(type) || DataType.isInt(type)) && !(values instanceof BigInt64Array) && !(values instanceof BigUint64Array) && ArrayBuffer.isView(values)) {
      const typed = values as unknown as ArrayLike<number>;
      for (let i = 0; i < n; i += 1) out[offset + i] = isValid(data, i) ? (typed[i] ?? Number.NaN) : Number.NaN;
    } else if (DataType.isInt(type) && (values instanceof BigInt64Array || values instanceof BigUint64Array)) {
      for (let i = 0; i < n; i += 1) out[offset + i] = isValid(data, i) ? Number(values[i] ?? 0n) : Number.NaN;
    } else if (DataType.isTimestamp(type) && values instanceof BigInt64Array) {
      const scale = timestampScale(type.unit);
      for (let i = 0; i < n; i += 1) out[offset + i] = isValid(data, i) ? Number(values[i] ?? 0n) / scale : Number.NaN;
    } else if (DataType.isDate(type) && type.unit === DateUnit.DAY && values instanceof Int32Array) {
      for (let i = 0; i < n; i += 1) out[offset + i] = isValid(data, i) ? (values[i] ?? 0) * 86_400_000 : Number.NaN;
    } else if (decimalScale !== null && values instanceof Uint32Array) {
      // Decimal128: four little-endian words per value.
      for (let i = 0; i < n; i += 1) {
        if (!isValid(data, i)) {
          out[offset + i] = Number.NaN;
          continue;
        }
        let unscaled = 0n;
        for (let w = 3; w >= 0; w -= 1) unscaled = (unscaled << 32n) | BigInt(values[i * 4 + w] ?? 0);
        out[offset + i] = Number(BigInt.asIntN(128, unscaled)) / 10 ** decimalScale;
      }
    } else {
      const chunk = vector.slice(offset, offset + n);
      for (let i = 0; i < n; i += 1) out[offset + i] = toNumber(chunk.get(i));
    }
    offset += n;
  }
}

function column(table: Table, name: string): { vector: Vector | null; field: Field | undefined } {
  const field = table.schema.fields.find((f) => f.name === name);
  return { vector: field ? table.getChild(name) : null, field };
}

function numbers(table: Table, name: string): Float64Array | null {
  const { vector } = column(table, name);
  if (!vector) return null;
  const out = new Float64Array(table.numRows);
  fillNumbers(vector, out);
  return out;
}

/** A BOOLEAN column as 0/1 bytes (NULL → 0), straight from the bit-packed buffers. */
function readFlags(vector: Vector | null, n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (!vector) return out;
  let offset = 0;
  for (const data of vector.data as Data[]) {
    const bits: unknown = data.values;
    if (DataType.isBool(data.type) && bits instanceof Uint8Array) {
      for (let i = 0; i < data.length; i += 1) {
        const bit = data.offset + i;
        out[offset + i] = isValid(data, i) && ((bits[bit >> 3] ?? 0) & (1 << (bit & 7))) !== 0 ? 1 : 0;
      }
    } else {
      const chunk = vector.slice(offset, offset + data.length);
      for (let i = 0; i < data.length; i += 1) out[offset + i] = chunk.get(i) === true ? 1 : 0;
    }
    offset += data.length;
  }
  return out;
}

interface SeriesSlot {
  value: unknown;
  /** Comparable identity of `value` (JSON for objects such as decimal words). */
  id: unknown;
  /** UTF-8 bytes of a string value (Utf8 fast path). */
  bytes: Uint8Array | null;
  isOther: boolean;
  isNull: boolean;
  rows: number;
  total: number;
}

/** A value comparable with `===`: primitives as they are, objects (decimal words, dates) as JSON. */
function identity(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Date) return value.getTime();
  return JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

function bytesEqual(a: Uint8Array, values: Uint8Array, start: number, end: number): boolean {
  if (a.length !== end - start) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== values[start + i]) return false;
  return true;
}

/**
 * Series index per row from `color` / `color_other`. Looks each row up among
 * the (at most 9) series seen so far without decoding strings: Utf8 compares
 * bytes, dictionaries compare indices, primitives compare values.
 */
function readSeries(table: Table, measure: Float64Array, countRows: boolean): { series: Uint8Array; slots: SeriesSlot[]; kind: ValueKind } | null {
  const { vector: color, field: colorField } = column(table, 'color');
  if (!color) return null;
  const { vector: other } = column(table, 'color_other');
  const kind = valueKind(colorField);
  const n = table.numRows;
  const series = new Uint8Array(n);
  const slots: SeriesSlot[] = [];
  const add = (slot: SeriesSlot): number => {
    if (slots.length >= 255) throw new Error('chart result has more than 255 colour series');
    slots.push(slot);
    return slots.length - 1;
  };
  let otherSlot = -1;
  let nullSlot = -1;
  let offset = 0;
  const others = readFlags(other, n);
  /** Slot of a UTF-8 value, comparing bytes against the (at most 9) slots seen so far. */
  const utf8Slot = (bytes: Uint8Array, start: number, end: number): number => {
    for (let s = 0; s < slots.length; s += 1) {
      const slotBytes = slots[s]?.bytes;
      if (slotBytes && bytesEqual(slotBytes, bytes, start, end)) return s;
    }
    return -1;
  };
  for (const data of color.data as Data[]) {
    const len = data.length;
    const type: unknown = data.type;
    const isUtf8 = DataType.isUtf8(type) && data.valueOffsets instanceof Int32Array && data.values instanceof Uint8Array;
    const isDict = DataType.isDictionary(type) && ArrayBuffer.isView(data.values) && data.dictionary;
    const dictSlots = new Map<number, number>();
    const chunk = isUtf8 || isDict ? null : color.slice(offset, offset + len);
    for (let i = 0; i < len; i += 1) {
      let slot: number;
      if (others[offset + i] === 1) {
        if (otherSlot < 0) otherSlot = add({ value: null, id: null, bytes: null, isOther: true, isNull: false, rows: 0, total: 0 });
        slot = otherSlot;
      } else if (!isValid(data, i)) {
        if (nullSlot < 0) nullSlot = add({ value: null, id: null, bytes: null, isOther: false, isNull: true, rows: 0, total: 0 });
        slot = nullSlot;
      } else if (isUtf8) {
        const offsets = data.valueOffsets;
        const bytes = data.values;
        const start = offsets[i] ?? 0;
        const end = offsets[i + 1] ?? start;
        slot = utf8Slot(bytes, start, end);
        if (slot < 0) {
          const text = new TextDecoder().decode(bytes.subarray(start, end));
          slot = add({ value: text, id: text, bytes: bytes.slice(start, end), isOther: false, isNull: false, rows: 0, total: 0 });
        }
      } else if (isDict) {
        const index = Number((data.values as unknown as ArrayLike<number | bigint>)[i] ?? 0);
        const known = dictSlots.get(index);
        if (known !== undefined) slot = known;
        else {
          const value: unknown = data.dictionary?.get(index);
          slot = slots.findIndex((s) => !s.isOther && !s.isNull && s.id === value);
          if (slot < 0) slot = add({ value, id: value, bytes: null, isOther: false, isNull: false, rows: 0, total: 0 });
          dictSlots.set(index, slot);
        }
      } else {
        const value: unknown = chunk?.get(i);
        const id = identity(value);
        slot = slots.findIndex((s) => !s.isOther && !s.isNull && s.id === id);
        if (slot < 0) slot = add({ value, id, bytes: null, isOther: false, isNull: false, rows: 0, total: 0 });
      }
      series[offset + i] = slot;
      const s = slots[slot];
      if (s) {
        s.rows += 1;
        const m = measure[offset + i] ?? Number.NaN;
        s.total += countRows ? 1 : Number.isFinite(m) ? m : 0;
      }
    }
    offset += len;
  }
  return { series, slots, kind };
}

/**
 * Orders series like the compiler ranks them: largest total first (rows for
 * scatter), the NULL series after equal totals, Other last; ties by label.
 * Returns the new index of each old slot.
 */
function rankSeries(slots: readonly SeriesSlot[], labels: readonly string[]): Uint8Array {
  const order = slots.map((_, i) => i);
  order.sort((a, b) => {
    const sa = slots[a];
    const sb = slots[b];
    if (!sa || !sb) return 0;
    if (sa.isOther !== sb.isOther) return sa.isOther ? 1 : -1;
    if (sa.total !== sb.total) return sb.total - sa.total;
    if (sa.isNull !== sb.isNull) return sa.isNull ? 1 : -1;
    return (labels[a] ?? '').localeCompare(labels[b] ?? '');
  });
  const remap = new Uint8Array(slots.length);
  order.forEach((old, rank) => (remap[old] = rank));
  return remap;
}

/** Row indices grouped by series and (with `sortByX`) sorted by x within each (stable). */
function orderRows(x: Float64Array, series: Uint8Array | null, seriesCount: number, sortByX: boolean): { order: Uint32Array; seriesStart: Uint32Array } {
  const n = x.length;
  const groups = Math.max(1, seriesCount);
  const seriesStart = new Uint32Array(groups + 1);
  if (series) for (let i = 0; i < n; i += 1) seriesStart[(series[i] ?? 0) + 1] = (seriesStart[(series[i] ?? 0) + 1] ?? 0) + 1;
  else seriesStart[1] = n;
  for (let s = 1; s <= groups; s += 1) seriesStart[s] = (seriesStart[s] ?? 0) + (seriesStart[s - 1] ?? 0);
  const order = new Uint32Array(n);
  const cursor = seriesStart.slice(0, groups);
  for (let i = 0; i < n; i += 1) {
    const s = series ? (series[i] ?? 0) : 0;
    order[cursor[s] ?? 0] = i;
    cursor[s] = (cursor[s] ?? 0) + 1;
  }
  for (let s = 0; s < groups && sortByX; s += 1) {
    const start = seriesStart[s] ?? 0;
    const end = seriesStart[s + 1] ?? start;
    let sorted = true;
    for (let k = start + 1; k < end; k += 1) {
      if ((x[order[k] ?? 0] ?? 0) < (x[order[k - 1] ?? 0] ?? 0)) {
        sorted = false;
        break;
      }
    }
    if (!sorted) order.subarray(start, end).sort((a, b) => (x[a] ?? 0) - (x[b] ?? 0) || a - b);
  }
  return { order, seriesStart };
}

function categoriesOf(vector: Vector | null, field: Field | undefined, n: number): ChartCategory[] {
  const kind = valueKind(field);
  const format = formatterFor(kind);
  const out: ChartCategory[] = [];
  for (let i = 0; i < n; i += 1) {
    const raw: unknown = vector?.get(i);
    const value = filterValue(raw, kind);
    const label = format(raw);
    out.push({ key: valueKey(value), label: label ?? 'null', isNull: label === null, value });
  }
  return out;
}

/**
 * Typed columns of a chart result for `mark`. Missing optional columns
 * (no colour, no `x_end`) are null; a missing `y` is all NaN.
 */
export function chartColumnsFromArrow(table: Table, mark: ChartMark): ChartColumns {
  const n = table.numRows;
  const { vector: xVector, field: xField } = column(table, 'x');
  const { field: yField } = column(table, 'y');
  let xKind = axisKindOf(xField);
  let categories: ChartCategory[] | null = null;
  let x: Float64Array;
  if (mark === 'bar' || xKind === 'category') {
    xKind = 'category';
    categories = categoriesOf(xVector, xField, n);
    x = new Float64Array(n);
    for (let i = 0; i < n; i += 1) x[i] = i;
  } else {
    x = new Float64Array(n);
    fillNumbers(xVector, x);
  }
  const y = numbers(table, 'y') ?? new Float64Array(n).fill(Number.NaN);
  const xEnd = mark === 'histogram' || mark === 'heatmap' ? numbers(table, 'x_end') : null;
  const yEnd = mark === 'heatmap' ? numbers(table, 'y_end') : null;
  const count = mark === 'heatmap' ? numbers(table, 'count') : null;

  let series: Uint8Array | null = null;
  let seriesList: ChartSeries[] = [];
  let colorValueKind: ValueKind = 'other';
  const read = mark === 'heatmap' ? null : readSeries(table, y, mark === 'scatter');
  if (read) {
    colorValueKind = read.kind;
    const format = formatterFor(read.kind);
    const labels = read.slots.map((s) => (s.isOther ? 'Other' : s.isNull ? 'null' : (format(s.value) ?? 'null')));
    const remap = rankSeries(read.slots, labels);
    series = read.series;
    for (let i = 0; i < n; i += 1) series[i] = remap[series[i] ?? 0] ?? 0;
    seriesList = read.slots.map((s, old): ChartSeries => {
      const value = s.isOther || s.isNull ? null : filterValue(s.value, read.kind);
      return {
        index: remap[old] ?? old,
        key: s.isOther ? OTHER_SERIES_KEY : valueKey(value),
        label: labels[old] ?? '',
        value,
        isOther: s.isOther,
        isNull: s.isNull,
        rows: s.rows,
        total: s.total,
      };
    });
    seriesList.sort((a, b) => a.index - b.index);
  }
  // Lines, areas and histograms walk rows in x order; scatter, heatmap and bar keep result order.
  const sortByX = mark === 'line' || mark === 'area' || mark === 'histogram';
  const { order, seriesStart } = orderRows(x, series, seriesList.length, sortByX);
  return {
    length: n,
    x,
    xEnd,
    y,
    yEnd,
    count,
    series,
    seriesList,
    xKind,
    yKind: axisKindOf(yField) === 'time' ? 'time' : 'number',
    xValueKind: valueKind(xField),
    yValueKind: valueKind(yField),
    colorValueKind,
    categories,
    order,
    seriesStart,
  };
}

/** Number of series groups in `order` (1 without colour). */
export function seriesGroups(data: ChartColumns): number {
  return Math.max(1, data.seriesList.length);
}
