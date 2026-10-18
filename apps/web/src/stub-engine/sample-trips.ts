import type { ColumnType } from '@glassgrid/core';

/*
 * TEMPORARY (M4 web shell, until the DuckDB-WASM client lands): the fixed
 * dataset the stub engine serves, whatever file is opened. 240 taxi-like
 * trips over March 2024, generated from a fixed seed so every load (and
 * every test) sees the same rows.
 */

/** A cell as the stub keeps it: numbers for numeric and temporal columns (epoch ms), strings, booleans, NULL. */
export type Cell = number | string | boolean | null;

export interface StubColumn {
  readonly name: string;
  readonly type: ColumnType;
  readonly values: readonly Cell[];
}

export const SAMPLE_ROWS = 240;

/** mulberry32: a tiny seeded PRNG. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, weighted: readonly (readonly [T, number])[]): T {
  let r = next() * weighted.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [value, weight] of weighted) {
    r -= weight;
    if (r <= 0) return value;
  }
  return (weighted.at(-1) as readonly [T, number])[0];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** The sample: pickup_at (timestamp), payment_type (text), trip_distance and fare_amount (float), passengers (integer). */
export function sampleTrips(rows = SAMPLE_ROWS): StubColumn[] {
  const next = random(20_240_301);
  const start = Date.UTC(2024, 2, 1);
  const span = 31 * 24 * 3_600_000;
  const pickup: Cell[] = [];
  const payment: Cell[] = [];
  const distance: Cell[] = [];
  const fare: Cell[] = [];
  const passengers: Cell[] = [];
  for (let i = 0; i < rows; i += 1) {
    // Whole minutes, roughly in order, with a daily rhythm in how dense they are.
    const at = start + Math.floor(((i + next() * 0.9) / rows) * span / 60_000) * 60_000;
    pickup.push(at);
    payment.push(pick(next, [['Credit card', 60], ['Cash', 25], ['No charge', 6], ['Dispute', 4], [null, 5]] as const));
    const miles = Math.min(30, round2(0.1 + -Math.log(1 - next()) * 2.8));
    distance.push(miles);
    fare.push(round2(3 + miles * 2.5 + next() * 4));
    passengers.push(next() < 0.04 ? null : pick(next, [[1, 70], [2, 15], [3, 6], [4, 4], [5, 3], [6, 2]] as const));
  }
  return [
    { name: 'pickup_at', type: 'timestamp', values: pickup },
    { name: 'payment_type', type: 'text', values: payment },
    { name: 'trip_distance', type: 'float', values: distance },
    { name: 'fare_amount', type: 'float', values: fare },
    { name: 'passengers', type: 'integer', values: passengers },
  ];
}

/** DuckDB's name for each logical type (what DESCRIBE would print for a fresh table). */
export const DUCKDB_TYPES: Record<ColumnType, string> = {
  integer: 'BIGINT',
  float: 'DOUBLE',
  decimal: 'DECIMAL(38,6)',
  boolean: 'BOOLEAN',
  date: 'DATE',
  timestamp: 'TIMESTAMP',
  text: 'VARCHAR',
};

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** A temporal cell as DuckDB prints it: `2024-03-01` or `2024-03-01 08:15:00`. */
export function formatTemporal(ms: number, type: 'date' | 'timestamp'): string {
  const d = new Date(ms);
  const day = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (type === 'date') return day;
  return `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function toText(value: Exclude<Cell, null>, from: ColumnType): string {
  if (typeof value === 'number' && (from === 'date' || from === 'timestamp')) return formatTemporal(value, from);
  return String(value);
}

function parseTemporalText(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?Z?$/.exec(text.trim());
  if (!match) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * `TRY_CAST(value AS to)` for the stub's cells: the converted cell, or null
 * when it does not convert (counted as a failed cast by the caller).
 */
export function castCell(value: Cell, from: ColumnType, to: ColumnType): Cell {
  if (value === null || from === to) return value;
  const text = toText(value, from);
  switch (to) {
    case 'text':
      return text;
    case 'integer': {
      if (typeof value === 'number' && (from === 'float' || from === 'decimal' || from === 'integer')) return Math.round(value);
      if (typeof value === 'boolean') return value ? 1 : 0;
      return /^\s*[-+]?\d+\s*$/.test(text) ? Number.parseInt(text, 10) : null;
    }
    case 'float':
    case 'decimal': {
      if (typeof value === 'number' && from !== 'date' && from !== 'timestamp') return value;
      if (typeof value === 'boolean') return value ? 1 : 0;
      const parsed = text.trim() === '' ? Number.NaN : Number(text);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'boolean': {
      if (typeof value === 'number' && from !== 'date' && from !== 'timestamp') return value !== 0;
      const lower = text.trim().toLowerCase();
      return ['true', 't', 'yes', 'y', '1'].includes(lower) ? true : ['false', 'f', 'no', 'n', '0'].includes(lower) ? false : null;
    }
    case 'date':
    case 'timestamp': {
      if (typeof value === 'number' && (from === 'date' || from === 'timestamp')) return to === 'date' ? Math.floor(value / 86_400_000) * 86_400_000 : value;
      if (typeof value !== 'string') return null;
      const ms = parseTemporalText(value);
      return ms === null ? null : to === 'date' ? Math.floor(ms / 86_400_000) * 86_400_000 : ms;
    }
  }
}
