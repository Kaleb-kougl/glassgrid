import {
  DuckDBDateValue,
  DuckDBDecimalType,
  DuckDBDecimalValue,
  DuckDBIntervalValue,
  DuckDBTimeNSValue,
  DuckDBTimeValue,
  DuckDBTimestampMillisecondsValue,
  DuckDBTimestampNanosecondsValue,
  DuckDBTimestampSecondsValue,
  DuckDBTimestampTZValue,
  DuckDBTimestampValue,
  DuckDBTypeId,
  type DuckDBResultReader,
  type DuckDBType,
  type DuckDBValue,
} from '@duckdb/node-api';
import {
  Bool,
  DateDay,
  Decimal,
  Float32,
  Float64,
  Int8,
  Int16,
  Int32,
  Int64,
  IntervalMonthDayNano,
  Table,
  TimeMicrosecond,
  TimeNanosecond,
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
 * - DECIMAL(p,s) maps to Arrow Decimal128 with the same precision and scale
 *   (exact; the unscaled value is a 128-bit two's complement integer).
 * - TIME maps to Arrow Time64 in microseconds since midnight (TIME_NS to
 *   Time64 in nanoseconds). TIME WITH TIME ZONE stays text, since Arrow has
 *   no zoned time.
 * - INTERVAL maps to Arrow Interval(MONTH_DAY_NANO): months, days and
 *   nanoseconds, the same three parts DuckDB stores (micros x 1000). A
 *   page whose time part would overflow 64-bit nanoseconds (more than about
 *   292 years of hours/minutes/seconds) sends that column as text instead.
 * - Everything else (HUGEINT, UUID, BLOB, nested, ...) travels as DuckDB's
 *   canonical text so no precision is lost.
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

function decimals(type: DuckDBDecimalType): ColumnBuilder {
  const arrowType = new Decimal(type.scale, type.width, 128);
  return (values) => {
    const length = values.length;
    // Two 64-bit little-endian words per value: low, then high (sign-extended).
    const words = new BigUint64Array(length * 2);
    const bitmap = new Uint8Array((length + 7) >> 3);
    let nullCount = 0;
    for (let i = 0; i < length; i += 1) {
      const value = values[i] ?? null;
      if (value === null) {
        nullCount += 1;
        continue;
      }
      const unscaled = expect(value, DuckDBDecimalValue).value;
      words[2 * i] = BigInt.asUintN(64, unscaled);
      words[2 * i + 1] = BigInt.asUintN(64, unscaled >> 64n);
      bitmap[i >> 3] = (bitmap[i >> 3] ?? 0) | (1 << (i & 7));
    }
    return makeVector(
      makeData({
        type: arrowType,
        length,
        nullCount,
        nullBitmap: nullCount > 0 ? bitmap : null,
        data: new Uint32Array(words.buffer),
      }),
    );
  };
}

const MAX_INTERVAL_MICROS = 9_223_372_036_854_775n; // 2^63 / 1000

function intervals(): ColumnBuilder {
  const type = new IntervalMonthDayNano();
  const fallback = viaText();
  return (values) => {
    const length = values.length;
    const parts = new Int32Array(length * 4);
    const nanos = new BigInt64Array(1);
    const nanoWords = new Int32Array(nanos.buffer);
    const bitmap = new Uint8Array((length + 7) >> 3);
    let nullCount = 0;
    for (let i = 0; i < length; i += 1) {
      const value = values[i] ?? null;
      if (value === null) {
        nullCount += 1;
        continue;
      }
      const interval = expect(value, DuckDBIntervalValue);
      if (interval.micros > MAX_INTERVAL_MICROS || interval.micros < -MAX_INTERVAL_MICROS) return fallback(values);
      nanos[0] = interval.micros * 1000n;
      parts[4 * i] = interval.months;
      parts[4 * i + 1] = interval.days;
      parts[4 * i + 2] = nanoWords[0] ?? 0;
      parts[4 * i + 3] = nanoWords[1] ?? 0;
      bitmap[i >> 3] = (bitmap[i >> 3] ?? 0) | (1 << (i & 7));
    }
    return makeVector(makeData({ type, length, nullCount, nullBitmap: nullCount > 0 ? bitmap : null, data: parts }));
  };
}

function times(type: TimeMicrosecond | TimeNanosecond, raw: (value: DuckDBValue) => bigint): ColumnBuilder {
  return (values) => {
    const filled = fill(values, BigInt64Array, raw);
    return makeVector(makeData({ type, ...filled }));
  };
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

function builderFor(duckdbType: DuckDBType): ColumnBuilder {
  switch (duckdbType.typeId) {
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
    case DuckDBTypeId.DECIMAL:
      return duckdbType instanceof DuckDBDecimalType ? decimals(duckdbType) : viaText();
    case DuckDBTypeId.TIME:
      return times(new TimeMicrosecond(), (v) => expect(v, DuckDBTimeValue).micros);
    case DuckDBTypeId.TIME_NS:
      return times(new TimeNanosecond(), (v) => expect(v, DuckDBTimeNSValue).nanos);
    case DuckDBTypeId.INTERVAL:
      return intervals();
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
    vectors[name] = builderFor(reader.columnType(index))(columns[index] ?? []);
  });
  return new Table(vectors);
}

/** Read a DuckDB result straight into Arrow IPC stream bytes. */
export function readerToArrowIPC(reader: DuckDBResultReader): Uint8Array {
  return tableToIPC(readerToArrowTable(reader), 'stream');
}
