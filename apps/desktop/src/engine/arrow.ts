import {
  DuckDBDateValue,
  DuckDBTimestampMillisecondsValue,
  DuckDBTimestampNanosecondsValue,
  DuckDBTimestampSecondsValue,
  DuckDBTimestampTZValue,
  DuckDBTimestampValue,
  DuckDBTypeId,
  type DuckDBResultReader,
  type DuckDBValue,
} from '@duckdb/node-api';
import {
  Bool,
  DateDay,
  Float32,
  Float64,
  Int8,
  Int16,
  Int32,
  Int64,
  Table,
  TimestampMicrosecond,
  TimestampMillisecond,
  TimestampNanosecond,
  TimestampSecond,
  Uint8,
  Uint16,
  Uint32,
  Uint64,
  Utf8,
  makeData,
  makeVector,
  tableToIPC,
  vectorFromArray,
  type DataType,
  type Vector,
} from 'apache-arrow';

/*
 * @duckdb/node-api (1.5.x) does not expose DuckDB's Arrow C API, so results
 * are read as JS values and rebuilt as Arrow vectors here (docs/m0-notes.md).
 *
 * - Numbers and booleans map to the matching Arrow type.
 * - DATE and the TIMESTAMP family map to Arrow DateDay / Timestamp with the
 *   same unit, built straight into typed arrays (no Date objects, no
 *   precision loss). TIMESTAMP WITH TIME ZONE is a UTC timestamp.
 * - Everything else (DECIMAL, TIME, INTERVAL, UUID, nested, ...) travels as
 *   DuckDB's canonical text so no precision is lost; DECIMAL in particular
 *   stays exact for display.
 *
 * Pages are at most 1,000 rows, so the per-value cost is small (measured in
 * docs/m1-engine-notes.md).
 */

type ColumnBuilder = (values: readonly DuckDBValue[]) => Vector;

function viaArray(type: DataType): ColumnBuilder {
  return (values) => vectorFromArray(values as unknown[], type);
}

function viaText(): ColumnBuilder {
  const type = new Utf8();
  return (values) => vectorFromArray(values.map((value) => (value === null ? null : String(value))), type);
}

interface Filled<A> {
  data: A;
  nullBitmap: Uint8Array | null;
  nullCount: number;
  length: number;
}

/** Copy raw values into a typed array plus an Arrow validity bitmap (LSB order). */
function fill<A extends Int32Array | BigInt64Array>(
  values: readonly DuckDBValue[],
  ArrayType: new (length: number) => A,
  raw: (value: DuckDBValue) => A[number],
): Filled<A> {
  const length = values.length;
  const data = new ArrayType(length);
  const bitmap = new Uint8Array((length + 7) >> 3);
  let nullCount = 0;
  for (let i = 0; i < length; i += 1) {
    const value = values[i] ?? null;
    if (value === null) {
      nullCount += 1;
      continue;
    }
    data[i] = raw(value);
    bitmap[i >> 3] = (bitmap[i >> 3] ?? 0) | (1 << (i & 7));
  }
  return { data, nullBitmap: nullCount > 0 ? bitmap : null, nullCount, length };
}

function dateDays(): ColumnBuilder {
  const type = new DateDay();
  return (values) => {
    const filled = fill(values, Int32Array, (v) => expect(v, DuckDBDateValue).days);
    return makeVector(makeData({ type, ...filled }));
  };
}

type AnyTimestamp = TimestampSecond | TimestampMillisecond | TimestampMicrosecond | TimestampNanosecond;

function timestamps(type: AnyTimestamp, raw: (value: DuckDBValue) => bigint): ColumnBuilder {
  return (values) => {
    const filled = fill(values, BigInt64Array, raw);
    return makeVector(makeData({ type, ...filled }));
  };
}

function expect<T>(value: DuckDBValue, ctor: abstract new (...args: never[]) => T): T {
  if (!(value instanceof ctor)) throw new TypeError(`Unexpected DuckDB value ${String(value)}`);
  return value;
}

function builderFor(typeId: DuckDBTypeId): ColumnBuilder {
  switch (typeId) {
    case DuckDBTypeId.BOOLEAN:
      return viaArray(new Bool());
    case DuckDBTypeId.TINYINT:
      return viaArray(new Int8());
    case DuckDBTypeId.SMALLINT:
      return viaArray(new Int16());
    case DuckDBTypeId.INTEGER:
      return viaArray(new Int32());
    case DuckDBTypeId.BIGINT:
      return viaArray(new Int64());
    case DuckDBTypeId.UTINYINT:
      return viaArray(new Uint8());
    case DuckDBTypeId.USMALLINT:
      return viaArray(new Uint16());
    case DuckDBTypeId.UINTEGER:
      return viaArray(new Uint32());
    case DuckDBTypeId.UBIGINT:
      return viaArray(new Uint64());
    case DuckDBTypeId.FLOAT:
      return viaArray(new Float32());
    case DuckDBTypeId.DOUBLE:
      return viaArray(new Float64());
    case DuckDBTypeId.VARCHAR:
      return viaArray(new Utf8());
    case DuckDBTypeId.DATE:
      return dateDays();
    case DuckDBTypeId.TIMESTAMP:
      return timestamps(new TimestampMicrosecond(), (v) => expect(v, DuckDBTimestampValue).micros);
    case DuckDBTypeId.TIMESTAMP_TZ:
      return timestamps(new TimestampMicrosecond('UTC'), (v) => expect(v, DuckDBTimestampTZValue).micros);
    case DuckDBTypeId.TIMESTAMP_S:
      return timestamps(new TimestampSecond(), (v) => expect(v, DuckDBTimestampSecondsValue).seconds);
    case DuckDBTypeId.TIMESTAMP_MS:
      return timestamps(new TimestampMillisecond(), (v) => expect(v, DuckDBTimestampMillisecondsValue).millis);
    case DuckDBTypeId.TIMESTAMP_NS:
      return timestamps(new TimestampNanosecond(), (v) => expect(v, DuckDBTimestampNanosecondsValue).nanos);
    default:
      return viaText();
  }
}

/** Convert a fully-read DuckDB result into an Arrow table. */
export function readerToArrowTable(reader: DuckDBResultReader): Table {
  const names = reader.deduplicatedColumnNames();
  const columns = reader.getColumns();

  const vectors: Record<string, Vector> = {};
  names.forEach((name, index) => {
    vectors[name] = builderFor(reader.columnTypeId(index))(columns[index] ?? []);
  });
  return new Table(vectors);
}

/** Read a DuckDB result straight into Arrow IPC stream bytes. */
export function readerToArrowIPC(reader: DuckDBResultReader): Uint8Array {
  return tableToIPC(readerToArrowTable(reader), 'stream');
}
