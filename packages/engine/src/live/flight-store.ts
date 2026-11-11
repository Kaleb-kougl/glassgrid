import { DEFAULT_LIVE_RETENTION_MS, FLIGHT_POINT_FIELDS, LIVE_FIX_TOLERANCE_MS, type FlightBatch, type FlightPoint } from '@glassgrid/core';
import type { DatabaseOptions, DriverParam, DriverValue, DuckConnection, DuckDatabase, DuckDriver } from '../driver';
import { toCount } from '../column-types';
import { quoteIdent, quoteLiteral } from '../sql-text';
import { newFixes, toStoredPoint, type FixIdentity } from './dedup';

/*
 * `flight_states`: the live feed's table (docs/live-flights-l2.md).
 *
 * One table per feed, in its own database created through the driver
 * (native: an instance of its own, locked down like a table's; WASM: an
 * attached in-memory database). Its columns are `FlightPoint`'s, in
 * `FLIGHT_POINT_FIELDS` order and with the fixtures' Parquet types, as
 * DuckDB reads them (`flights.manifest.json`):
 *
 * | column | type | |
 * | --- | --- | --- |
 * | ts | TIMESTAMP | whole milliseconds (the fixtures' TIMESTAMP(MILLIS) reads as TIMESTAMP) |
 * | lat, lon | DECIMAL(7,5), DECIMAL(8,5) | exact 5-decimal positions, the dedup rule's identity |
 * | altBaroFt, altGeomFt, baroRateFpm, geomRateFpm | INTEGER | |
 * | gsKt, trackDeg | DOUBLE | to 0.1 |
 * | onGround | BOOLEAN | |
 * | hex, flight, registration, typeCode, category, squawk, posType, source | VARCHAR | |
 *
 * Matching the fixture's types exactly is what lets the replay gate compare
 * `flight_states` with `read_parquet(fixture)` value for value (EXCEPT ALL
 * both ways), and the same layout means a chart over live data and one over
 * the fixture compile to the same SQL.
 *
 * **Append path: a parameterised INSERT with one bound list per column**
 * (`INSERT ... SELECT casts FROM (SELECT unnest(string_split(?, chr(31))),
 * ...)`, up to `ROWS_PER_INSERT` rows per statement), not Arrow. The
 * native binding (`@duckdb/node-api` 1.5) cannot scan or append Arrow from
 * JS; only DuckDB-WASM can (`insertArrowFromIPCStream`, outside its
 * interruptible pending-query path), so Arrow would mean two append paths
 * and a driver-interface change. Bound values need neither: they go through
 * the `run(sql, params)` both drivers already implement (WASM:
 * PREPARE/EXECUTE with typed constants), and no value ever becomes SQL
 * text. A row-wise `VALUES (?, ...), (?, ...)` statement was the first
 * cut; DuckDB binds each of its 18 x n placeholders separately, which
 * measured 6-9k rows/s on native and 3-4k on WASM (the 30-minute replay
 * took 9.8 s and 21.7 s). One VARCHAR list per column measured 440k and
 * 285k rows/s (see the notes).
 *
 * **Ingest** (one transaction per batch, batches serialised):
 *
 * 1. round to stored precision (`toStoredPoint`), drop fixes already
 *    past retention;
 * 2. delete rows older than the data clock minus the retention (first, so
 *    an expiring row never suppresses a new near-twin and then disappears
 *    with it);
 * 3. read the stored fixes that could match (ts within the batch's span
 *    plus the tolerance) and keep only new ones (`newFixes`, dedup.ts);
 * 4. insert them.
 *
 * Retention counts back from the batch's data clock (the endpoint's `now`,
 * or the replay position), not the wall clock, so a replay keeps a rolling
 * window of fixture time. `retentionMs: null` keeps everything.
 */

export const FLIGHT_STATES_TABLE = 'flight_states';

/** Rows per INSERT statement (its 18 bound values are lists of this many). */
export const ROWS_PER_INSERT = 5_000;

type Field = (typeof FLIGHT_POINT_FIELDS)[number];

const COLUMN_TYPES: Record<Field, string> = {
  ts: 'TIMESTAMP NOT NULL',
  hex: 'VARCHAR NOT NULL',
  flight: 'VARCHAR',
  registration: 'VARCHAR',
  typeCode: 'VARCHAR',
  lat: 'DECIMAL(7,5) NOT NULL',
  lon: 'DECIMAL(8,5) NOT NULL',
  altBaroFt: 'INTEGER',
  altGeomFt: 'INTEGER',
  onGround: 'BOOLEAN NOT NULL',
  gsKt: 'DOUBLE',
  trackDeg: 'DOUBLE',
  baroRateFpm: 'INTEGER',
  geomRateFpm: 'INTEGER',
  category: 'VARCHAR',
  squawk: 'VARCHAR',
  posType: 'VARCHAR',
  source: 'VARCHAR NOT NULL',
};

/** Separates the values of one column in its bound text (U+001F, which `toStoredPoint` keeps out of every text value). */
const SEPARATOR = '\u001f';

/** How a column's element of the bound lists becomes the stored value (`''` is NULL: no stored text is empty). */
function insertExpression(field: Field, index: number): string {
  const c = `c${index}`;
  const type = COLUMN_TYPES[field].replace(' NOT NULL', '');
  if (field === 'ts') return `epoch_ms(CAST(${c} AS BIGINT))`;
  return type === 'VARCHAR' ? `NULLIF(${c}, '')` : `CAST(NULLIF(${c}, '') AS ${type})`;
}

/** How a column reads back as a FlightPoint value. */
function selectExpression(field: Field): string {
  const column = quoteIdent(field);
  if (field === 'ts') return `epoch_ms(${column}) AS ${column}`;
  if (field === 'lat' || field === 'lon') return `CAST(${column} AS DOUBLE) AS ${column}`;
  return column;
}

const TABLE = quoteIdent(FLIGHT_STATES_TABLE);
const SELECT_POINTS = FLIGHT_POINT_FIELDS.map(selectExpression).join(', ');

const INSERT_SQL = `INSERT INTO ${TABLE} SELECT ${FLIGHT_POINT_FIELDS.map(insertExpression).join(', ')} FROM (SELECT ${FLIGHT_POINT_FIELDS.map(
  (_, i) => `unnest(string_split(?, chr(31))) AS c${i}`,
).join(', ')})`;

/**
 * One bound VARCHAR per column: the chunk's values as text, joined by
 * SEPARATOR. Numbers use JS's shortest round-trip text, which DuckDB parses
 * back to the same DOUBLE (and DECIMAL(7,5) / INTEGER / BIGINT exactly, as
 * stored values have at most 5 decimals); booleans `true`/`false`.
 */
function columnParams(points: readonly FlightPoint[]): DriverParam[] {
  return FLIGHT_POINT_FIELDS.map((field) =>
    points
      .map((point) => {
        const value = point[field];
        return value === null ? '' : String(value);
      })
      .join(SEPARATOR),
  );
}

function num(value: DriverValue | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  throw new Error(`Expected a number from ${FLIGHT_STATES_TABLE}, got ${typeof value}`);
}

function numOrNull(value: DriverValue | undefined): number | null {
  return value === null || value === undefined ? null : num(value);
}

function textOrNull(value: DriverValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function text(value: DriverValue | undefined): string {
  if (typeof value === 'string') return value;
  throw new Error(`Expected text from ${FLIGHT_STATES_TABLE}, got ${typeof value}`);
}

/** A row of `SELECT_POINTS` as a FlightPoint. */
export function pointFromRow(row: readonly DriverValue[]): FlightPoint {
  const at = (field: Field) => row[FLIGHT_POINT_FIELDS.indexOf(field)];
  return {
    ts: num(at('ts')),
    hex: text(at('hex')),
    flight: textOrNull(at('flight')),
    registration: textOrNull(at('registration')),
    typeCode: textOrNull(at('typeCode')),
    lat: num(at('lat')),
    lon: num(at('lon')),
    altBaroFt: numOrNull(at('altBaroFt')),
    altGeomFt: numOrNull(at('altGeomFt')),
    onGround: at('onGround') === true,
    gsKt: numOrNull(at('gsKt')),
    trackDeg: numOrNull(at('trackDeg')),
    baroRateFpm: numOrNull(at('baroRateFpm')),
    geomRateFpm: numOrNull(at('geomRateFpm')),
    category: textOrNull(at('category')),
    squawk: textOrNull(at('squawk')),
    posType: textOrNull(at('posType')),
    source: at('source') === 'live' ? 'live' : 'archive',
  };
}

/** SELECT list that reads `flight_states` (or a table of the same layout) as FlightPoint rows; see `pointFromRow`. */
export const FLIGHT_POINT_SELECT = SELECT_POINTS;

export interface FlightStoreOptions {
  /** Files the database may read (a replay's fixture). */
  allowedPaths?: readonly string[];
  /** Spill folder (native); one per store. */
  tempDirectory: string;
  memoryLimitBytes: number;
  /** Rolling retention behind the data clock; null keeps everything. Default 60 minutes. */
  retentionMs?: number | null;
  /** Re-reported live fix tolerance (default LIVE_FIX_TOLERANCE_MS). */
  toleranceMs?: number;
}

/** What `loadParquet` reports besides an ingest's counts: the loaded fixes' time range. */
export interface LoadResult extends IngestResult {
  /** First and last fix time (epoch ms); null for an empty file. */
  firstTs: number | null;
  lastTs: number | null;
}

export interface IngestResult {
  /** Fixes in the batch. */
  received: number;
  /** New rows kept. */
  inserted: number;
  /** Rows removed by retention. */
  expired: number;
  /** Rows in the table afterwards. */
  rowCount: number;
}

export class FlightStore {
  private queue: Promise<unknown> = Promise.resolve();
  private rows = 0;
  private closed = false;

  private constructor(
    readonly db: DuckDatabase,
    private readonly connection: DuckConnection,
    readonly retentionMs: number | null,
    readonly toleranceMs: number,
  ) {}

  static async create(driver: DuckDriver, options: FlightStoreOptions): Promise<FlightStore> {
    const database: DatabaseOptions = {
      allowedPaths: options.allowedPaths ?? [],
      allowedDirectories: [],
      tempDirectory: options.tempDirectory,
      memoryLimitBytes: options.memoryLimitBytes,
    };
    const db = await driver.createDatabase(database);
    try {
      const connection = await db.connect();
      const columns = FLIGHT_POINT_FIELDS.map((field) => `${quoteIdent(field)} ${COLUMN_TYPES[field]}`).join(', ');
      await connection.run(`CREATE TABLE ${TABLE} (${columns})`);
      const retention = options.retentionMs === undefined ? DEFAULT_LIVE_RETENTION_MS : options.retentionMs;
      return new FlightStore(db, connection, retention, options.toleranceMs ?? LIVE_FIX_TOLERANCE_MS);
    } catch (error) {
      await db.close().catch(() => undefined);
      throw error;
    }
  }

  /** Rows in `flight_states` after the last ingest. */
  get rowCount(): number {
    return this.rows;
  }

  /** Append a batch (dedup and retention as above). Batches run one at a time, in call order. */
  ingest(batch: FlightBatch): Promise<IngestResult> {
    return this.serial(() => this.doIngest(batch));
  }

  /**
   * Loads a whole fixture Parquet file (milestone L4, an `archive` source;
   * docs/live-flights-l4.md): one transaction, `INSERT ... SELECT` straight
   * from `read_parquet`, ordered by (ts, hex) so the map's time-window scans
   * prune by DuckDB's zone maps. The fixtures are archive rows, unique per
   * (hex, ts) and at stored precision (L2's replay gate), so no dedup is
   * needed; the store must be empty and keep everything (retention null).
   * The path must be one of the store's `allowedPaths`.
   */
  loadParquet(path: string): Promise<LoadResult> {
    return this.serial(() => this.doLoadParquet(path));
  }

  /** Every row as FlightPoints, ordered by (hex, ts). For tests and small tables. */
  points(): Promise<FlightPoint[]> {
    return this.serial(async () => (await this.connection.query(`SELECT ${SELECT_POINTS} FROM ${TABLE} ORDER BY hex, ts`)).rows.map(pointFromRow));
  }

  /** A new connection to the store's database (e.g. for a replay's fixture reader). The caller closes it. */
  connect(): Promise<DuckConnection> {
    return this.db.connect();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue.catch(() => undefined);
    this.connection.close();
    await this.db.close();
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      if (this.closed) throw new Error(`${FLIGHT_STATES_TABLE} is closed`);
      return task();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doIngest(batch: FlightBatch): Promise<IngestResult> {
    // Whole milliseconds: the data clock may come from arithmetic (a replay position) and is bound as BIGINT.
    const cutoff = this.retentionMs === null ? null : Math.floor(batch.dataClockMs - this.retentionMs);
    const incoming = batch.points.map(toStoredPoint).filter((point) => cutoff === null || point.ts >= cutoff);
    const connection = this.connection;
    await connection.run('BEGIN TRANSACTION');
    try {
      // Retention first, so a row about to expire can never suppress its near-twin and then vanish with it.
      if (cutoff !== null) await connection.run(`DELETE FROM ${TABLE} WHERE ts < epoch_ms(CAST(? AS BIGINT))`, [BigInt(cutoff)]);
      let kept: FlightPoint[] = [];
      if (incoming.length > 0) {
        kept = newFixes(await this.candidates(incoming), incoming, this.toleranceMs);
        for (let start = 0; start < kept.length; start += ROWS_PER_INSERT) {
          await connection.run(INSERT_SQL, columnParams(kept.slice(start, start + ROWS_PER_INSERT)));
        }
      }
      const rowCount = toCount((await connection.query(`SELECT count(*) FROM ${TABLE}`)).rows[0]?.[0] ?? null);
      await connection.run('COMMIT');
      const expired = this.rows + kept.length - rowCount;
      this.rows = rowCount;
      return { received: batch.points.length, inserted: kept.length, expired, rowCount };
    } catch (error) {
      await connection.run('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  private async doLoadParquet(path: string): Promise<LoadResult> {
    if (this.retentionMs !== null) throw new Error('A whole fixture loads only into a store without retention');
    if (this.rows !== 0) throw new Error(`${FLIGHT_STATES_TABLE} must be empty to load a whole fixture`);
    const connection = this.connection;
    // A CREATE/INSERT ... FROM read_parquet cannot take the path as a bound value; it is the host's, never a request's.
    const casts = FLIGHT_POINT_FIELDS.map((field) => `CAST(${quoteIdent(field)} AS ${COLUMN_TYPES[field].replace(' NOT NULL', '')})`).join(', ');
    await connection.run('BEGIN TRANSACTION');
    try {
      await connection.run(`INSERT INTO ${TABLE} SELECT ${casts} FROM read_parquet(${quoteLiteral(path)}) ORDER BY ts, hex`);
      const row = (await connection.query(`SELECT count(*), epoch_ms(min(ts)), epoch_ms(max(ts)) FROM ${TABLE}`)).rows[0] ?? [];
      await connection.run('COMMIT');
      const rowCount = toCount(row[0] ?? null);
      this.rows = rowCount;
      return { received: rowCount, inserted: rowCount, expired: 0, rowCount, firstTs: numOrNull(row[1]), lastTs: numOrNull(row[2]) };
    } catch (error) {
      await connection.run('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  /** Stored fixes the dedup rule could match: ts within the batch's span widened by the tolerance. */
  private async candidates(batch: readonly FlightPoint[]): Promise<FixIdentity[]> {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const point of batch) {
      if (point.ts < min) min = point.ts;
      if (point.ts > max) max = point.ts;
    }
    const result = await this.connection.query(
      `SELECT hex, epoch_ms(ts), CAST(lat AS DOUBLE), CAST(lon AS DOUBLE), source FROM ${TABLE} WHERE ts BETWEEN epoch_ms(CAST(? AS BIGINT)) AND epoch_ms(CAST(? AS BIGINT))`,
      [BigInt(Math.max(0, min - this.toleranceMs)), BigInt(max + this.toleranceMs)],
    );
    return result.rows.map((row) => ({
      hex: text(row[0]),
      ts: num(row[1]),
      lat: num(row[2]),
      lon: num(row[3]),
      source: row[4] === 'live' ? 'live' : 'archive',
    }));
  }
}
