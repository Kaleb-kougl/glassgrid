import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DuckDatabase } from '../driver';
import { EngineFailure, isInterruptError } from '../errors';
import { quoteLiteral } from '../sql-text';
import type { WasmDriver } from './driver';
import { createNodeWasmDriver } from './node';
import { argumentLiteral, inlineArguments, isPreparable } from './params';

/*
 * The DuckDB-WASM driver on its own (in Node, with DuckDB-WASM's Node
 * runtime): its sandbox, cooperative interrupts, out-of-memory mapping and
 * argument handling. These run in every `pnpm test`, whichever driver the
 * rest of the suite uses.
 */

let dir: string;
let outside: string;
let driver: WasmDriver;
let db: DuckDatabase;
let ownPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassgrid-wasm-'));
  outside = await mkdtemp(join(tmpdir(), 'glassgrid-outside-'));
  ownPath = join(dir, 'own.csv');
  await writeFile(ownPath, 'a,b\n1,x\n2,y\n');
  await writeFile(join(outside, 'secret.csv'), 'secret\nhunter2\n');
  driver = await createNodeWasmDriver({
    allowedRoots: [dir],
    memoryLimitBytes: 128 * 1024 * 1024,
    outOfMemoryMessage: 'This file is too large for the web demo. Use the desktop app',
  });
  await driver.start();
  db = await driver.createDatabase({ allowedPaths: [ownPath], allowedDirectories: [join(dir, 'cache')], tempDirectory: join(dir, 'tmp'), memoryLimitBytes: 0 });
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function attempt(sql: string): Promise<unknown> {
  const connection = await db.connect();
  try {
    return await connection.query(sql);
  } finally {
    connection.close();
  }
}

const permission = /Permission Error|disabled by configuration|disabled through configuration/;
const locked = /configuration has been locked|Cannot change/;

describe('sandbox', () => {
  it('reads files under its roots', async () => {
    expect(await attempt(`SELECT count(*) AS n FROM read_csv(${quoteLiteral(ownPath)})`)).toMatchObject({ rows: [[2n]] });
  });

  it('refuses files outside its roots, globs, URLs and extension loading', async () => {
    for (const sql of [
      `SELECT * FROM read_csv(${quoteLiteral(join(outside, 'secret.csv'))})`,
      `SELECT * FROM read_text('/etc/hostname')`,
      `SELECT * FROM glob('/etc/*')`,
      `SELECT * FROM read_csv('https://example.com/data.csv')`,
      `SELECT * FROM read_csv('http://169.254.169.254/latest/meta-data')`,
      `LOAD httpfs`,
      `COPY (SELECT 1) TO ${quoteLiteral(join(outside, 'exfiltrated.csv'))}`,
      `ATTACH ${quoteLiteral(join(outside, 'x.duckdb'))}`,
    ]) {
      await expect(attempt(sql), sql).rejects.toThrow(permission);
    }
    expect(existsSync(join(outside, 'exfiltrated.csv'))).toBe(false);
  });

  it('refuses to change any setting once locked', async () => {
    for (const sql of [
      'SET enable_external_access = true',
      'SET lock_configuration = false',
      `SET allowed_directories = ['/']`,
      'SET autoload_known_extensions = true',
      `SET custom_extension_repository = 'https://example.com'`,
      `SET memory_limit = '3GB'`,
    ]) {
      await expect(attempt(sql), sql).rejects.toThrow(locked);
    }
    expect(
      await attempt(
        `SELECT current_setting('enable_external_access') AS ext, current_setting('lock_configuration') AS locked,
                current_setting('autoinstall_known_extensions') AS install, current_setting('autoload_known_extensions') AS load`,
      ),
    ).toMatchObject({ rows: [[false, true, false, false]] });
  });

  it('refuses tables outside its roots', async () => {
    await expect(
      driver.createDatabase({ allowedPaths: [join(outside, 'secret.csv')], allowedDirectories: [], tempDirectory: '', memoryLimitBytes: 0 }),
    ).rejects.toMatchObject({ code: 'io_failed' });
  });

  it('keeps tables apart: each table has its own database, dropped on close', async () => {
    const other = await driver.createDatabase({ allowedPaths: [ownPath], allowedDirectories: [], tempDirectory: '', memoryLimitBytes: 0 });
    const a = await other.connect();
    await a.run('CREATE TABLE only_here AS SELECT 1 AS x');
    a.close();
    await expect(attempt('SELECT * FROM only_here')).rejects.toThrow(/does not exist/);
    await other.close();
    await expect(other.connect()).rejects.toThrow(/closed/);
  });
});

describe('statements', () => {
  it('binds arguments with the native binding types', async () => {
    const connection = await db.connect();
    try {
      const result = await connection.query(
        'SELECT $1 AS s, $2 AS d, $3 AS b, $4 AS t, $5 AS n, typeof($1) AS ts, typeof($2) AS td, typeof($3) AS tb',
        ["it's", 1.7000000000000002, 12n, true, null],
      );
      expect(result.rows[0]).toEqual(["it's", 1.7000000000000002, 12n, true, null, 'VARCHAR', 'DOUBLE', 'BIGINT']);
      // CREATE TABLE ... AS cannot be prepared: its arguments are inlined as typed literals.
      await connection.run('CREATE OR REPLACE TABLE inlined AS SELECT ? AS q, $2 AS d', ["a'?$1", 2.5]);
      expect((await connection.query('SELECT q, d FROM inlined')).rows).toEqual([["a'?$1", 2.5]]);
    } finally {
      connection.close();
    }
  });

  it('interrupts a running statement at its next step', async () => {
    const connection = await db.connect();
    try {
      const started = performance.now();
      const running = connection.query('SELECT count(*) FROM range(400000000) t(i) WHERE i % 7 = 3');
      setTimeout(() => connection.interrupt(), 50);
      const error: unknown = await running.catch((caught: unknown) => caught);
      expect(isInterruptError(error)).toBe(true);
      expect(performance.now() - started).toBeLessThan(5_000);
      // The connection stays usable, and an interrupt with nothing running does not stick.
      connection.interrupt();
      expect((await connection.query('SELECT 42 AS x')).rows).toEqual([[42]]);
    } finally {
      connection.close();
    }
  });

  it('reports running out of memory as out_of_memory with the configured message', async () => {
    const error: unknown = await attempt(`SELECT list(repeat('x', 200) || i) FROM range(3000000) t(i)`).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineFailure);
    expect(error).toMatchObject({ code: 'out_of_memory', message: expect.stringMatching(/^This file is too large for the web demo/) as unknown });
    // The instance survives a DuckDB out-of-memory error.
    expect(await attempt('SELECT 1 AS one')).toMatchObject({ rows: [[1]] });
  });
});

describe('arguments', () => {
  it('render as typed literals', () => {
    expect([null, true, false, 1.5, Number.NaN, -Infinity, 7n, 2n ** 70n, "o'k"].map(argumentLiteral)).toEqual([
      'NULL',
      'TRUE',
      'FALSE',
      `CAST('1.5' AS DOUBLE)`,
      `CAST('NaN' AS DOUBLE)`,
      `CAST('-Infinity' AS DOUBLE)`,
      `CAST('7' AS BIGINT)`,
      `CAST('1180591620717411303424' AS HUGEINT)`,
      `CAST('o''k' AS VARCHAR)`,
    ]);
  });

  it('are inlined only outside literals, quoted identifiers and comments', () => {
    expect(inlineArguments(`SELECT '?', "$1", ? -- $2\n, $2 /* ? */, a$1`, [1, 'x'])).toBe(
      `SELECT '?', "$1", CAST('1' AS DOUBLE) -- $2\n, CAST('x' AS VARCHAR) /* ? */, a$1`,
    );
    expect(() => inlineArguments('SELECT ?, ?', [1])).toThrow(/More placeholders/);
    expect(isPreparable('  WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    expect(isPreparable('CREATE OR REPLACE TABLE t AS SELECT 1')).toBe(false);
  });
});
