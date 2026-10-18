import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TableId } from '@glassgrid/core';
import { quoteLiteral } from './sql-text';
import { columnValues, createHarness, decode, writeFixtureCsv, type Harness } from './test-support';

/*
 * DuckDB runs with enable_external_access = false, an allowlist of the
 * table's own file plus the Parquet cache folder, and lock_configuration.
 * The engine never puts request text into SQL, but these tests hand the
 * query layer crafted fragments and statements directly, as a compiler bug
 * or a hostile caller with code execution in the engine's query path would.
 */

let h: Harness;
let table: TableId;
let otherTable: TableId;
let ownPath: string;
let otherPath: string;

beforeAll(async () => {
  h = await createHarness();
  ownPath = join(h.dir, 'own.csv');
  otherPath = join(h.dir, 'other.csv');
  await writeFixtureCsv(ownPath, 1000);
  await writeFile(otherPath, 'secret\nhunter2\n');
  const own = h.register(ownPath);
  const other = h.register(otherPath);
  table = own.table;
  otherTable = other.table;
  await h.service.open(own.file, { parquet: 'always' });
  await h.service.ensureParquetCache(table);
  await h.service.open(other.file, { parquet: 'never' });
});

afterAll(async () => {
  await h.dispose();
});

const permission = { code: 'query_failed', message: expect.stringMatching(/Permission Error|disabled by configuration/) as unknown };
const locked = { code: 'query_failed', message: expect.stringMatching(/configuration has been locked|Cannot change/) as unknown };

function whereFragment(sql: string) {
  return { sql, params: [] };
}

describe('external access is locked down', () => {
  it('refuses arbitrary local files through a crafted WHERE fragment', async () => {
    const fragment = whereFragment(`(SELECT count(*) FROM read_csv('/etc/passwd')) > 0`);
    await expect(h.service.rows(table, { offset: 0, limit: 10, where: fragment })).rejects.toMatchObject(permission);
    await expect(h.service.count(table, whereFragment(`length((SELECT content FROM read_text('/etc/hostname'))) > 0`))).rejects.toMatchObject(
      permission,
    );
    await expect(h.service.aggregate(table, { sql: `SELECT * FROM glob('/etc/*')`, params: [] })).rejects.toMatchObject(permission);
  });

  it('refuses another open file from this table (each table has its own allowlist)', async () => {
    await expect(h.service.aggregate(table, { sql: `SELECT * FROM read_csv(${quoteLiteral(otherPath)})`, params: [] })).rejects.toMatchObject(
      permission,
    );
    // ...while that file's own table reads it normally.
    expect(decode((await h.service.rows(otherTable, { offset: 0, limit: 10 })).value).numRows).toBe(1);
  });

  it('refuses path traversal out of the cache folder', async () => {
    const traversal = join(h.cacheDir, '..', '..', 'other.csv');
    await expect(h.service.aggregate(table, { sql: `SELECT * FROM read_csv(${quoteLiteral(traversal)})`, params: [] })).rejects.toMatchObject(
      permission,
    );
  });

  it('refuses network URLs and extension installs', async () => {
    for (const url of ['https://example.com/data.csv', 'http://169.254.169.254/latest/meta-data', 's3://bucket/key.parquet']) {
      await expect(
        h.service.aggregate(table, { sql: `SELECT * FROM read_csv(${quoteLiteral(url)})`, params: [] }),
      ).rejects.toMatchObject(permission);
    }
    await expect(h.service.countQuery(table, { sql: 'INSTALL httpfs', params: [] })).rejects.toMatchObject(permission);
    await expect(h.service.countQuery(table, { sql: 'LOAD httpfs', params: [] })).rejects.toMatchObject(permission);
  });

  it('refuses writes outside the cache folder and ATTACH', async () => {
    const target = join(h.dir, 'exfiltrated.csv');
    await expect(
      h.service.countQuery(table, { sql: `COPY (SELECT 1) TO ${quoteLiteral(target)}`, params: [] }),
    ).rejects.toMatchObject(permission);
    expect(existsSync(target)).toBe(false);
    await expect(
      h.service.countQuery(table, { sql: `ATTACH ${quoteLiteral(join(h.dir, 'x.duckdb'))}`, params: [] }),
    ).rejects.toMatchObject(permission);
  });

  it('refuses to change any setting once locked', async () => {
    for (const sql of [
      'SET enable_external_access = true',
      'RESET enable_external_access',
      'SET lock_configuration = false',
      `SET allowed_directories = ['/']`,
      `SET allowed_paths = ['/etc/passwd']`,
      `SET autoinstall_known_extensions = true`,
      `PRAGMA memory_limit = '64GB'`,
    ]) {
      await expect(h.service.countQuery(table, { sql, params: [] }), sql).rejects.toMatchObject(locked);
    }
    const settings = await h.service.aggregate(table, {
      sql: `SELECT current_setting('enable_external_access') AS ext, current_setting('lock_configuration') AS locked,
              current_setting('autoinstall_known_extensions') AS install, current_setting('autoload_known_extensions') AS load`,
      params: [],
    });
    const row = decode(settings.value);
    expect([columnValues(row, 'ext')[0], columnValues(row, 'locked')[0], columnValues(row, 'install')[0], columnValues(row, 'load')[0]]).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it('still reads its own file and Parquet copy', async () => {
    const own = await h.service.aggregate(table, { sql: `SELECT count(*) AS n FROM read_csv(${quoteLiteral(ownPath)})`, params: [] });
    expect(columnValues(decode(own.value), 'n')).toEqual([1000]);
    const page = await h.service.rows(table, { offset: 990, limit: 10 });
    expect(columnValues(decode(page.value), 'id')).toEqual([991, 992, 993, 994, 995, 996, 997, 998, 999, 1000]);
  });
});
