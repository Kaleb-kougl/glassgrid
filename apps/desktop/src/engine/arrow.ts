import { DuckDBTypeId, type DuckDBResultReader, type DuckDBValue } from '@duckdb/node-api';
import {
  Bool,
  Float32,
  Float64,
  Int8,
  Int16,
  Int32,
  Int64,
  Table,
  Uint8,
  Uint16,
  Uint32,
  Uint64,
  Utf8,
  vectorFromArray,
  type DataType,
  type Vector,
} from 'apache-arrow';

/*
 * @duckdb/node-api (1.5.x) does not expose DuckDB's Arrow C API, so results
 * are materialised as JS values and rebuilt as Arrow vectors here. The
 * mapping covers primitive types natively; everything else (temporal,
 * decimal, nested, ...) is carried as its canonical DuckDB string form until
 * the grid milestone adds dedicated mappings. See docs/m0-notes.md.
 */

function arrowTypeFor(typeId: DuckDBTypeId): DataType {
  switch (typeId) {
    case DuckDBTypeId.BOOLEAN:
      return new Bool();
    case DuckDBTypeId.TINYINT:
      return new Int8();
    case DuckDBTypeId.SMALLINT:
      return new Int16();
    case DuckDBTypeId.INTEGER:
      return new Int32();
    case DuckDBTypeId.BIGINT:
      return new Int64();
    case DuckDBTypeId.UTINYINT:
      return new Uint8();
    case DuckDBTypeId.USMALLINT:
      return new Uint16();
    case DuckDBTypeId.UINTEGER:
      return new Uint32();
    case DuckDBTypeId.UBIGINT:
      return new Uint64();
    case DuckDBTypeId.FLOAT:
      return new Float32();
    case DuckDBTypeId.DOUBLE:
      return new Float64();
    default:
      return new Utf8();
  }
}

function toArrowValue(value: DuckDBValue, type: DataType): unknown {
  if (value === null) return null;
  // Non-primitive DuckDB values are objects with a canonical toString().
  if (type instanceof Utf8 && typeof value !== 'string') return String(value);
  return value;
}

/** Convert a fully-read DuckDB result into an Arrow table. */
export function readerToArrowTable(reader: DuckDBResultReader): Table {
  const names = reader.deduplicatedColumnNames();
  const columns = reader.getColumns();

  const vectors: Record<string, Vector> = {};
  names.forEach((name, index) => {
    const type = arrowTypeFor(reader.columnTypeId(index));
    const values = (columns[index] ?? []).map((value) => toArrowValue(value, type));
    vectors[name] = vectorFromArray(values, type);
  });
  return new Table(vectors);
}
