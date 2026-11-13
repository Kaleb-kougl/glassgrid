import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { BAY_AREA_BBOX, FLIGHT_POINT_FIELDS, FlightPointSchema } from '@glassgrid/core';
import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from './lib/common.ts';

/*
 * The committed flight fixtures (apps/web/public/samples/flights, written by
 * `globe-history`) match their manifest byte for byte, hold only in-box
 * fixes of the named day in the flight-point layout, stay a reasonable size
 * for git, and carry their ODbL notice.
 */

const DIR = path.resolve(PACKAGE_ROOT, '..', '..', 'apps', 'web', 'public', 'samples', 'flights');

interface FixtureManifest {
  recipe: string;
  licence: { id: string; notice: string };
  source: { release: string; assets: { name: string; bytes: number; sha256: string }[] };
  day: { startUtc: string; endUtc: string };
  measurements: { busiestWindow: { startUtc: string; endUtc: string }; dayInView: { peak: number; median: number } };
  files: { id: string; file: string; rows: number; bytes: number; sha256: string; distinctAircraft: number }[];
}

const manifest = JSON.parse(await readFile(path.join(DIR, 'flights.manifest.json'), 'utf8')) as FixtureManifest;

async function query(sql: string): Promise<Record<string, unknown>[]> {
  const db = await DuckDBInstance.create(':memory:');
  const conn = await db.connect();
  try {
    return (await conn.runAndReadAll(sql)).getRowObjectsJson();
  } finally {
    conn.closeSync();
    db.closeSync();
  }
}

describe('flight fixtures', () => {
  it('has the day file and the 30-minute window, each matching its manifest entry and under 20 MB', async () => {
    expect(manifest.files.map((f) => f.id)).toEqual(['day', '30min']);
    for (const entry of manifest.files) {
      const file = path.join(DIR, entry.file);
      const bytes = await readFile(file);
      expect((await stat(file)).size).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
      expect(entry.bytes).toBeLessThan(20e6);
    }
  });

  it('holds only in-box fixes of the day, in the flight-point layout, valid for FlightPointSchema', { timeout: 60_000 }, async () => {
    const { south, north, west, east } = BAY_AREA_BBOX;
    const dayStart = Date.parse(manifest.day.startUtc);
    const dayEnd = Date.parse(manifest.day.endUtc);
    for (const entry of manifest.files) {
      const src = `read_parquet('${path.join(DIR, entry.file).replaceAll("'", "''")}')`;
      const columns = await query(`DESCRIBE SELECT * FROM ${src}`);
      expect(columns.map((c) => c['column_name'])).toEqual([...FLIGHT_POINT_FIELDS]);
      const [summary] = await query(`SELECT count(*) AS n, count(DISTINCT hex) AS hexes,
        count(*) FILTER (WHERE lat < ${south} OR lat > ${north} OR lon < ${west} OR lon > ${east}) AS outside,
        min(epoch_ms(ts)) AS first, max(epoch_ms(ts)) AS last,
        count(*) FILTER (WHERE source <> 'archive') AS not_archive,
        count(*) - count(DISTINCT (hex, ts)) AS dupes FROM ${src}`);
      expect(Number(summary?.['n'])).toBe(entry.rows);
      expect(Number(summary?.['hexes'])).toBe(entry.distinctAircraft);
      expect(Number(summary?.['outside'])).toBe(0);
      expect(Number(summary?.['not_archive'])).toBe(0);
      expect(Number(summary?.['dupes'])).toBe(0);
      expect(Number(summary?.['first'])).toBeGreaterThanOrEqual(dayStart);
      expect(Number(summary?.['last'])).toBeLessThan(dayEnd);

      // Every 997th row, converted back to a FlightPoint.
      const rows = await query(`SELECT * REPLACE (CAST(epoch_ms(ts) AS DOUBLE) AS ts, CAST(lat AS DOUBLE) AS lat, CAST(lon AS DOUBLE) AS lon)
        FROM ${src} QUALIFY row_number() OVER () % 997 = 0`);
      expect(rows.length).toBeGreaterThan(10);
      for (const row of rows) expect(FlightPointSchema.safeParse(row).success).toBe(true);
    }
  });

  it('the window file covers the busiest 30 minutes plus a 60 s lead-in', async () => {
    const entry = manifest.files.find((f) => f.id === '30min');
    if (!entry) throw new Error('no 30min entry');
    const [range] = await query(`SELECT min(epoch_ms(ts)) AS first, max(epoch_ms(ts)) AS last FROM read_parquet('${path.join(DIR, entry.file)}')`);
    const start = Date.parse(manifest.measurements.busiestWindow.startUtc);
    const end = Date.parse(manifest.measurements.busiestWindow.endUtc);
    expect(end - start).toBe(30 * 60_000);
    expect(Number(range?.['first'])).toBeGreaterThanOrEqual(start - 60_000);
    expect(Number(range?.['last'])).toBeLessThan(end);
  });

  it('carries the ODbL notice, naming the release and its assets', async () => {
    expect(manifest.licence.id).toBe('ODbL-1.0');
    const notice = await readFile(path.join(DIR, manifest.licence.notice), 'utf8');
    expect(notice).toContain('© adsb.lol contributors');
    expect(notice).toContain('https://opendatacommons.org/licenses/odbl/1.0/');
    expect(notice).toContain(manifest.source.release);
    for (const asset of manifest.source.assets) expect(notice).toContain(asset.sha256);
  });
});
