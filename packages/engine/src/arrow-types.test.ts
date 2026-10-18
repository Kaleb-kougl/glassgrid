import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DataType, IntervalUnit, TimeUnit, tableFromIPC } from 'apache-arrow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filterValue, formatValue, valueKind } from '@glassgrid/ui/format';
import type { DriverValue, DuckDatabase } from './driver';
import { createHarness, decode, isWasm, testDriver, type Harness } from './test-support';

/*
 * DECIMAL -> Arrow Decimal128, TIME -> Time64, INTERVAL -> Interval
 * (MONTH_DAY_NANO), and the renderer's formatting of each, checked against
 * DuckDB's own text rendering of the same values. Runs through the driver
 * (`connection.arrow`), so the same expectations hold for the native
 * driver's Arrow builder and for DuckDB-WASM's own Arrow export.
 */

let db: DuckDatabase;
let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  db = await (await testDriver()).createDatabase({
    allowedPaths: [],
    allowedDirectories: [h.cacheDir],
    tempDirectory: join(h.dir, 'arrow-tmp'),
    memoryLimitBytes: 256 * 1024 * 1024,
  });
});

afterAll(async () => {
  await db.close();
  await h.dispose();
});

async function typed(selectList: string) {
  const connection = await db.connect();
  try {
    const values = tableFromIPC(await connection.arrow(`SELECT ${selectList}`));
    const texts = await connection.query(
      `SELECT ${values.schema.fields.map((field) => `CAST("${field.name}" AS VARCHAR) AS "${field.name}"`).join(', ')} FROM (SELECT ${selectList})`,
    );
    const rows = texts.rows.map((row): Record<string, DriverValue> => Object.fromEntries(texts.columns.map((name, i) => [name, row[i] ?? null])));
    return { values, texts: rows };
  } finally {
    connection.close();
  }
}

/** Every cell rendered by the renderer equals DuckDB's VARCHAR cast of it. */
function expectRenderedLikeDuckDB(result: Awaited<ReturnType<typeof typed>>) {
  for (const field of result.values.schema.fields) {
    const vector = result.values.getChild(field.name);
    const kind = valueKind(field);
    result.texts.forEach((row, index) => {
      const expected = row[field.name] ?? null;
      expect(formatValue(vector?.get(index), kind), `${field.name}[${index}]`).toBe(expected === null ? null : expected);
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
    expect([0, 1, 2].map((i) => formatValue(at?.get(i), valueKind(field)))).toEqual(['08:15:00', '17:45:30.25', null]);
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

  // DuckDB-WASM's own Arrow export does the conversion (and its overflow handling) itself.
  it.skipIf(isWasm)('sends a page as text when the time part overflows 64-bit nanoseconds', async () => {
    const result = await typed(`* FROM (VALUES (INTERVAL '3000000 hours'), (INTERVAL '1 hour')) t(i)`);
    const field = result.values.schema.fields[0];
    expect(field && DataType.isUtf8(field.type)).toBe(true);
  });
});

describe('types Arrow JS cannot show', () => {
  it('travel as DuckDB text (HUGEINT, UUID, BLOB) on every driver', async () => {
    const result = await typed(
      `* FROM (VALUES
        (170141183460469231731687303715884105727::HUGEINT, '6a2b3e0c-6f1e-4c2a-9d6e-0a1b2c3d4e5f'::UUID, '\\xAA\\x00AB'::BLOB),
        (-1::HUGEINT, NULL::UUID, NULL::BLOB)
      ) t(h, u, b)`,
    );
    for (const field of result.values.schema.fields) expect(DataType.isUtf8(field.type), field.name).toBe(true);
    result.texts.forEach((row, index) => {
      for (const name of ['h', 'u', 'b']) expect(result.values.getChild(name)?.get(index) ?? null, `${name}[${index}]`).toBe(row[name] ?? null);
    });
  });

  it('travel as text when nested (LIST, STRUCT)', async () => {
    const result = await typed(`[1, 2, NULL] AS l, {'a': 1, 'b': 'x'} AS s`);
    for (const field of result.values.schema.fields) expect(DataType.isUtf8(field.type), field.name).toBe(true);
    expect(result.values.getChild('l')?.get(0)).toBe(result.texts[0]?.['l']);
  });
});
