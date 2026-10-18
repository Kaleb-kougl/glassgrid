import {
  DataType,
  DateUnit,
  Table,
  Type,
  Utf8,
  makeBuilder,
  makeVector,
  tableFromIPC,
  tableToIPC,
  type Builder,
  type Data,
  type Field,
  type Vector,
} from 'apache-arrow';
import type { DriverValue } from '../driver';

/*
 * DuckDB-WASM returns query results as Arrow IPC produced by DuckDB itself
 * (the native driver rebuilds Arrow from JS values, native/arrow.ts). The
 * two agree for every type the engine produces from CSV and Parquet input:
 * Bool, Int8..64, Uint8..64, Float32/64, Utf8, DateDay, Timestamp (all
 * units, UTC for TIMESTAMPTZ), Decimal128, Time64 and
 * Interval(MONTH_DAY_NANO). The rest is normalized here so the renderer sees
 * the engine's mapping (docs/m2-engine-notes.md, "Arrow types"):
 *
 * - HUGEINT arrives as Decimal(38, 0); the native driver sends it as text,
 *   so Decimal(38, 0) becomes Utf8 (a real DECIMAL(38,0) column then also
 *   travels as text, shown identically).
 * - BLOB, LIST, STRUCT, MAP, ENUM (dictionary), NULL and Utf8 variants
 *   become Utf8 in a DuckDB-like rendering (nested values are best-effort:
 *   see docs/m4-engine-portability.md).
 * - TIME WITH TIME ZONE arrives as Time64 without its offset (DuckDB's
 *   Arrow export drops it); the native driver sends text. Documented.
 *
 * Results that need no change are passed through byte for byte.
 */

/** An Arrow IPC stream end-of-stream marker (continuation token + zero length). */
const EOS = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);

/** Join DuckDB-WASM's result chunks (schema message, record batches) into one IPC stream. */
export function concatIpc(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) + EOS.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  out.set(EOS, offset);
  return out;
}

function isCanonical(type: DataType): boolean {
  switch (type.typeId) {
    case Type.Bool:
    case Type.Int:
    case Type.Float:
    case Type.Utf8:
    case Type.Timestamp:
    case Type.Interval:
      return true;
    case Type.Date:
      return DataType.isDate(type) && type.unit === DateUnit.DAY;
    case Type.Time:
      return DataType.isTime(type) && type.bitWidth === 64;
    case Type.Decimal:
      return DataType.isDecimal(type) && !(type.precision === 38 && type.scale === 0);
    default:
      return false;
  }
}

/** Normalize a DuckDB-WASM Arrow stream to the engine's type mapping (unchanged bytes when nothing differs). */
export function normalizeIpc(ipc: Uint8Array): Uint8Array {
  const table = tableFromIPC(ipc);
  if (table.schema.fields.every((field: Field) => isCanonical(field.type as DataType))) return ipc;
  const columns: Record<string, Vector> = {};
  for (const [index, field] of (table.schema.fields).entries()) {
    const vector = table.getChildAt(index);
    if (!vector) continue;
    columns[field.name] = isCanonical(field.type as DataType) ? vector : asText(vector, field);
  }
  return tableToIPC(new Table(columns), 'stream');
}

function asText(vector: Vector, field: Field): Vector {
  const values: (string | null)[] = [];
  for (let i = 0; i < vector.length; i += 1) {
    const value = valueAt(vector, i);
    values.push(value === null ? null : renderText(value, field.type as DataType));
  }
  return textVector(values);
}

/**
 * A Utf8 vector from strings and nulls, built without code generation.
 * Arrow's `vectorFromArray` (and any builder given `nullValues`) compiles
 * its null check with `new Function`, which a Content-Security-Policy
 * without `'unsafe-eval'` refuses; the web demo's header CSP applies to this
 * worker. Same vector, plain closure (as `vectorFromValues` in @glassgrid/ui).
 */
export function textVector(values: readonly (string | null)[]): Vector<Utf8> {
  // Without null values the builder keeps its prototype's `_isValid` and compiles nothing.
  const builder: Builder<Utf8, null> = makeBuilder<Utf8, null>({ type: new Utf8(), nullValues: [] });
  (builder as unknown as { _isValid: (value: unknown) => boolean })._isValid = (value) => value !== null && value !== undefined;
  for (const value of values) builder.append(value);
  return builder.finish().toVector();
}

// ---------------------------------------------------------------------------
// Values (DuckConnection.query)

/** Rows of a (small) result as driver values; see `DriverValue` for the mapping. */
export function ipcToRows(ipc: Uint8Array): { columns: string[]; rows: DriverValue[][] } {
  const table = tableFromIPC(ipc);
  const columns = table.schema.fields.map((field) => field.name);
  const vectors = table.schema.fields.map((_, index) => table.getChildAt(index));
  const rows: DriverValue[][] = [];
  for (let i = 0; i < table.numRows; i += 1) rows.push(vectors.map((vector) => (vector ? valueAt(vector, i) : null)));
  return { columns, rows };
}

/** The data chunk and index inside it that hold row `index` of a vector. */
function locate(vector: Vector, index: number): { data: Data; at: number } {
  let rest = index;
  for (const data of vector.data as Data[]) {
    if (rest < data.length) return { data, at: rest };
    rest -= data.length;
  }
  throw new RangeError(`Row ${index} is out of range`);
}

function isValid(data: Data, at: number): boolean {
  return data.nullCount === 0 || data.getValid(at);
}

function pad(value: number | bigint, width: number): string {
  return String(value).padStart(width, '0');
}

function dateText(days: number): string {
  const date = new Date(days * 86_400_000);
  const year = date.getUTCFullYear();
  const text = `${pad(Math.abs(year), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
  return year <= 0 ? `${pad(1 - year, 4)}-${text.slice(5)} (BC)` : text;
}

/** HH:MM:SS[.fraction] with trailing zeros dropped, from a count of `perSecond` units since midnight. */
function timeOfDay(units: bigint, perSecond: bigint): string {
  const seconds = units / perSecond;
  const fraction = units % perSecond;
  const digits = String(perSecond).length - 1;
  const base = `${pad(seconds / 3600n, 2)}:${pad((seconds / 60n) % 60n, 2)}:${pad(seconds % 60n, 2)}`;
  if (fraction === 0n) return base;
  return `${base}.${pad(fraction, digits).replace(/0+$/, '')}`;
}

function timestampText(value: bigint, perSecond: bigint, utc: boolean): string {
  const perDay = 86_400n * perSecond;
  let days = value / perDay;
  let rest = value % perDay;
  if (rest < 0n) {
    rest += perDay;
    days -= 1n;
  }
  return `${dateText(Number(days))} ${timeOfDay(rest, perSecond)}${utc ? '+00' : ''}`;
}

const UNIT_PER_SECOND = [1n, 1_000n, 1_000_000n, 1_000_000_000n];

function unscaled(words: Uint32Array, offset: number): bigint {
  let value = 0n;
  for (let i = 3; i >= 0; i -= 1) value = (value << 32n) | BigInt(words[offset + i] ?? 0);
  return BigInt.asIntN(128, value);
}

function decimalText(value: bigint, scale: number): string {
  if (scale === 0) return value.toString();
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** One value of a vector as a driver value (temporal types as DuckDB-like text). */
function valueAt(vector: Vector, index: number): DriverValue {
  const { data, at } = locate(vector, index);
  if (!isValid(data, at)) return null;
  const type = data.type;
  const position = data.offset + at;
  switch (type.typeId) {
    case Type.Null:
      return null;
    case Type.Bool:
    case Type.Utf8:
    case Type.LargeUtf8:
    case Type.Float: {
      const value: unknown = vector.get(index);
      return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' ? value : null;
    }
    case Type.Int: {
      const value: unknown = vector.get(index);
      return typeof value === 'number' || typeof value === 'bigint' ? value : null;
    }
    case Type.Decimal: {
      const scale = DataType.isDecimal(type) ? type.scale : 0;
      const raw = unscaled(data.values as Uint32Array, position * 4);
      return scale === 0 ? raw : Number(decimalText(raw, scale));
    }
    case Type.Date: {
      if (DataType.isDate(type) && type.unit === DateUnit.DAY) return dateText((data.values as Int32Array)[position] ?? 0);
      const millis: unknown = vector.get(index); // Date64 (DuckDB does not emit it)
      return typeof millis === 'number' ? dateText(Math.floor(millis / 86_400_000)) : null;
    }
    case Type.Timestamp: {
      if (!DataType.isTimestamp(type)) return null;
      const raw = (data.values as BigInt64Array | Int32Array)[position] ?? 0;
      const value = typeof raw === 'bigint' ? raw : BigInt(raw);
      return timestampText(value, UNIT_PER_SECOND[type.unit] ?? 1_000_000n, type.timezone !== null && type.timezone !== undefined);
    }
    case Type.Time: {
      if (!DataType.isTime(type)) return null;
      const raw = (data.values as BigInt64Array | Int32Array)[position] ?? 0;
      return timeOfDay(typeof raw === 'bigint' ? raw : BigInt(raw), UNIT_PER_SECOND[type.unit] ?? 1_000_000n);
    }
    case Type.Interval: {
      const parts = data.values as Int32Array;
      if (parts.length >= (position + 1) * 4) {
        const months = parts[position * 4] ?? 0;
        const days = parts[position * 4 + 1] ?? 0;
        const nanos = (BigInt(parts[position * 4 + 3] ?? 0) << 32n) | BigInt((parts[position * 4 + 2] ?? 0) >>> 0);
        return intervalText(months, days, nanos / 1000n);
      }
      return renderText(vector.get(index), type);
    }
    case Type.Binary:
    case Type.LargeBinary:
    case Type.FixedSizeBinary:
      return blobText(vector.get(index) as Uint8Array);
    case Type.Dictionary: {
      const value: unknown = vector.get(index);
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' ? value : null;
    }
    case Type.List:
    case Type.FixedSizeList: {
      const child = vector.get(index) as Vector | null;
      if (!child) return null;
      return Array.from({ length: child.length }, (_, i) => valueAt(child, i));
    }
    case Type.Struct: {
      const children: Field[] = type.children;
      const out: Record<string, DriverValue> = {};
      children.forEach((childField, childIndex) => {
        const childData = data.children[childIndex];
        out[childField.name] = childData ? valueAt(makeVector(childData), position) : null;
      });
      return out;
    }
    default: {
      const value: unknown = vector.get(index);
      return value === null || value === undefined ? null : renderText(value, type);
    }
  }
}

function intervalText(months: number, days: number, micros: bigint): string {
  const parts: string[] = [];
  const years = Math.trunc(months / 12);
  const restMonths = months % 12;
  if (years !== 0) parts.push(`${years} year${Math.abs(years) === 1 ? '' : 's'}`);
  if (restMonths !== 0) parts.push(`${restMonths} month${Math.abs(restMonths) === 1 ? '' : 's'}`);
  if (days !== 0) parts.push(`${days} day${Math.abs(days) === 1 ? '' : 's'}`);
  if (micros !== 0n || parts.length === 0) {
    const negative = micros < 0n;
    parts.push(`${negative ? '-' : ''}${timeOfDay(negative ? -micros : micros, 1_000_000n)}`);
  }
  return parts.join(' ');
}

function blobText(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte >= 0x20 && byte < 0x7f && byte !== 0x5c && byte !== 0x27 && byte !== 0x22 ? String.fromCharCode(byte) : `\\x${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** DuckDB-like text of any driver value (nested values best-effort). */
function renderText(value: unknown, type: DataType): string {
  if (DataType.isDecimal(type) && value instanceof Uint32Array) return decimalText(unscaled(value, 0), type.scale);
  if (value instanceof Uint8Array) return blobText(value);
  return nestedText(value);
}

function nestedText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return `[${value.map(nestedText).join(', ')}]`;
  if (typeof value === 'object') {
    const candidate = value as { toArray?: () => unknown[]; toJSON?: () => unknown };
    if (typeof candidate.toArray === 'function' && !(value instanceof Map)) {
      const json = typeof candidate.toJSON === 'function' ? candidate.toJSON() : undefined;
      if (json && typeof json === 'object' && !Array.isArray(json)) return structText(json as Record<string, unknown>);
      return `[${candidate.toArray().map(nestedText).join(', ')}]`;
    }
    if (value instanceof Map) return `{${[...value].map(([k, v]) => `${nestedText(k)}=${nestedText(v)}`).join(', ')}}`;
    return structText(value as Record<string, unknown>);
  }
  return JSON.stringify(value);
}

function structText(record: Record<string, unknown>): string {
  return `{${Object.entries(record)
    .map(([key, entry]) => `'${key}': ${typeof entry === 'string' ? `'${entry}'` : nestedText(entry)}`)
    .join(', ')}}`;
}
