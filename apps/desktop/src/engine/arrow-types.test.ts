import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { DataType, IntervalUnit, TimeUnit } from 'apache-arrow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { displayValue, filterValue, valueKind } from '../renderer/src/arrow-values';
import { readerToArrowTable } from './arrow';
import { createHarness, decode, type Harness } from './test-support';

/*
 * DECIMAL -> Arrow Decimal128, TIME -> Time64, INTERVAL -> Interval
 * (MONTH_DAY_NANO), and the renderer's formatting of each, checked against
 * DuckDB's own text rendering of the same values.
 */

let db: DuckDBInstance;
let h: Harness;

beforeAll(async () => {
  db = await DuckDBInstance.create(':memory:');
  h = await createHarness();
});

afterAll(async () => {
  db.closeSync();
  await h.dispose();
});

async function typed(selectList: string) {
  const connection = await db.connect();
  try {
    const values = readerToArrowTable(await connection.runAndReadAll(`SELECT ${selectList}`));
    const texts = await connection.runAndReadAll(
      `SELECT ${values.schema.fields.map((field) => `CAST("${field.name}" AS VARCHAR) AS "${field.name}"`).join(', ')} FROM (SELECT ${selectList})`,
    );
    return { values, texts: texts.getRowObjects() };
  } finally {
    connection.closeSync();
  }
}

/** Every cell rendered by the renderer equals DuckDB's VARCHAR cast of it. */
function expectRenderedLikeDuckDB(result: Awaited<ReturnType<typeof typed>>) {
  for (const field of result.values.schema.fields) {
    const vector = result.values.getChild(field.name);
    const kind = valueKind(field);
    result.texts.forEach((row, index) => {
      const expected = row[field.name] ?? null;
      expect(displayValue(vector?.get(index), kind), `${field.name}[${index}]`).toBe(expected === null ? null : String(expected));
    });
  }
}

describe('DECIMAL', () => {
  it('maps to Decimal128 with the same precision and scale, exactly', async () => {
    const result = await typed(
      `* FROM (VALUES
        (12.345::DECIMAL(18,3), -0.5::DECIMAL(4,1), 12345678901234567890.0123456789::DECIMAL(38,10), 7::DECIMAL(10,0)),
        (-0.001::DECIMAL(18,3), NULL, -99999999999999999999999999.9999999999::DECIMAL(38,10), -7::DECIMAL(10,0)),
        (NULL, 999.9::DECIMAL(4,1), 0::DECIMAL(38,10), 0::DECIMAL(10,0))
      ) t(d18, d4, d38, d10)`,
    );
    const field = result.values.schema.fields[0];
    expect(field && DataType.isDecimal(field.type) && [field.type.precision, field.type.scale, field.type.bitWidth]).toEqual([18, 3, 128]);
    const wide = result.values.schema.fields[2];
    expect(wide && DataType.isDecimal(wide.type) && [wide.type.precision, wide.type.scale]).toEqual([38, 10]);
    expectRenderedLikeDuckDB(result);
    const vector = result.values.getChild('d18');
    expect(filterValue(vector?.get(0), valueKind(field))).toBe(12.345);
  });
});

describe('TIME', () => {
  it('maps to Time64 microseconds since midnight', async () => {
    const result = await typed(
      `* FROM (VALUES ('00:00:00'::TIME), ('12:34:56.789'::TIME), ('23:59:59.999999'::TIME), (NULL::TIME)) t(t)`,
    );
    const field = result.values.schema.fields[0];
    expect(field && DataType.isTime(field.type) && [field.type.unit, field.type.bitWidth]).toEqual([TimeUnit.MICROSECOND, 64]);
    expect(result.values.getChild('t')?.get(1)).toBe(45_296_789_000n);
    expectRenderedLikeDuckDB(result);
  });

  it('arrives from a CSV column sniffed as TIME', async () => {
    const path = join(h.dir, 'times.csv');
    await writeFile(path, 'id,at\n1,08:15:00\n2,17:45:30.25\n3,\n');
    const { file, table } = h.register(path);
    await h.service.open(file, { parquet: 'never' });
    const page = decode((await h.service.rows(table, { offset: 0, limit: 10 })).value);
    const field = page.schema.fields.find((candidate) => candidate.name === 'at');
    expect(field && DataType.isTime(field.type)).toBe(true);
    const at = page.getChild('at');
    expect([0, 1, 2].map((i) => displayValue(at?.get(i), valueKind(field)))).toEqual(['08:15:00', '17:45:30.25', null]);
  });
});

describe('INTERVAL', () => {
  it('maps to Interval(MONTH_DAY_NANO) and renders like DuckDB', async () => {
    const result = await typed(
      `* FROM (VALUES
        (INTERVAL '14 months 3 days 4 hours 5 minutes 6.5 seconds'),
        (INTERVAL '1 day'),
        (INTERVAL '-2 years -1 day -00:00:01'),
        (INTERVAL '0 seconds'),
        (INTERVAL '36 hours'),
        (NULL::INTERVAL)
      ) t(i)`,
    );
    const field = result.values.schema.fields[0];
    expect(field && DataType.isInterval(field.type) && field.type.unit).toBe(IntervalUnit.MONTH_DAY_NANO);
    const [months, days, lo, hi] = [...(result.values.getChild('i')?.get(0) as Int32Array)];
    expect([months, days]).toEqual([14, 3]);
    expect((BigInt(hi ?? 0) << 32n) | BigInt((lo ?? 0) >>> 0)).toBe(14_706_500_000_000n);
    expectRenderedLikeDuckDB(result);
  });

  it('sends a page as text when the time part overflows 64-bit nanoseconds', async () => {
    const result = await typed(`* FROM (VALUES (INTERVAL '3000000 hours'), (INTERVAL '1 hour')) t(i)`);
    const field = result.values.schema.fields[0];
    expect(field && DataType.isUtf8(field.type)).toBe(true);
  });
});
