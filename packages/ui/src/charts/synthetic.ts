import { Bool, Table, TimestampMicrosecond, Utf8, makeData, makeVector, vectorFromArray, type Vector } from 'apache-arrow';

/*
 * Deterministic synthetic chart results, shaped exactly like the compiler's
 * output (docs/m1-compiler.md), for the gallery, tests and benchmarks.
 */

/** Small deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample (Box–Muller). */
function normal(random: () => number): number {
  const u = Math.max(1e-12, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const SERIES_NAMES = ['Credit card', 'Cash', 'No charge', 'Dispute', 'Unknown', 'Voided', 'Group ride', 'Flex', 'Other'];
const DAY_MS = 86_400_000;

function colorColumns(series: Uint8Array, count: number, withOther: boolean): Record<string, Vector> {
  const names: (string | null)[] = [];
  const other: boolean[] = [];
  for (let i = 0; i < series.length; i += 1) {
    const s = series[i] ?? 0;
    const isOther = withOther && s === count - 1;
    names.push(isOther ? null : (SERIES_NAMES[s] ?? `Series ${s}`));
    other.push(isOther);
  }
  return { color: vectorFromArray(names, new Utf8()), color_other: vectorFromArray(other, new Bool()) };
}

function timestamps(ms: Float64Array): Vector {
  const micros = new BigInt64Array(ms.length);
  for (let i = 0; i < ms.length; i += 1) micros[i] = BigInt(Math.round((ms[i] ?? 0) * 1000));
  return makeVector(makeData({ type: new TimestampMicrosecond(), length: ms.length, data: micros }));
}

export interface SyntheticLineOptions {
  /** Points per series (M4 at 1,000 px returns up to 4,000). */
  points?: number;
  series?: number;
  /** Fold the last series into "Other". */
  other?: boolean;
  /** Share of NULL measures (gaps). */
  nulls?: number;
  start?: number;
  stepMs?: number;
  seed?: number;
}

/** A line/area result: `x` TIMESTAMP, `y` DOUBLE (+ colour), rows ordered by series then x. */
export function syntheticLineTable({ points = 31, series = 1, other = false, nulls = 0, start = Date.UTC(2023, 0, 1), stepMs = DAY_MS, seed = 7 }: SyntheticLineOptions = {}): Table {
  const random = prng(seed);
  const n = points * series;
  const x = new Float64Array(n);
  const y: (number | null)[] = [];
  const s = new Uint8Array(n);
  for (let k = 0; k < series; k += 1) {
    let level = 18_000 / (k + 1);
    for (let i = 0; i < points; i += 1) {
      const row = k * points + i;
      x[row] = start + i * stepMs;
      s[row] = k;
      level = Math.max(100, level + normal(random) * level * 0.04 + Math.sin(i / 7) * level * 0.03);
      y.push(random() < nulls ? null : Math.round(level));
    }
  }
  const columns: Record<string, Vector> = { x: timestamps(x), y: vectorFromArray(y) };
  return new Table(series > 1 ? { ...columns, ...colorColumns(s, series, other) } : columns);
}

export interface SyntheticHistogramOptions {
  bins?: number;
  width?: number;
  series?: number;
  seed?: number;
}

/** A histogram result: `x`, `x_end`, `y` DOUBLE, a right-skewed distribution (like trip distance). */
export function syntheticHistogramTable({ bins = 50, width = 0.5, series = 1, seed = 11 }: SyntheticHistogramOptions = {}): Table {
  const random = prng(seed);
  const x: number[] = [];
  const xEnd: number[] = [];
  const y: number[] = [];
  const s: number[] = [];
  for (let b = 0; b < bins; b += 1) {
    const centre = (b + 0.5) * width;
    const density = Math.exp(-((Math.log(centre + 0.2) - 0.6) ** 2) / 0.5) * 160_000;
    for (let k = 0; k < series; k += 1) {
      const v = Math.round(density * (0.6 + random() * 0.4) / (k + 1));
      if (v <= 0) continue;
      x.push(b * width);
      xEnd.push((b + 1) * width);
      y.push(v);
      s.push(k);
    }
  }
  const columns: Record<string, Vector> = {
    x: makeVector(Float64Array.from(x)),
    x_end: makeVector(Float64Array.from(xEnd)),
    y: makeVector(Float64Array.from(y)),
  };
  return new Table(series > 1 ? { ...columns, ...colorColumns(Uint8Array.from(s), series, false) } : columns);
}

export interface SyntheticHeatmapOptions {
  bins?: number;
  /** Every cell non-empty (a full bins × bins grid), as a worst case. */
  dense?: boolean;
  seed?: number;
}

/** A heatmap result: `x, x_end, y, y_end` DOUBLE, `count` BIGINT, two gaussian clusters, empty cells omitted. */
export function syntheticHeatmapTable({ bins = 100, dense = false, seed = 5 }: SyntheticHeatmapOptions = {}): Table {
  const random = prng(seed);
  const x: number[] = [];
  const y: number[] = [];
  const counts: bigint[] = [];
  for (let i = 0; i < bins; i += 1) {
    for (let j = 0; j < bins; j += 1) {
      const u = i / bins;
      const v = j / bins;
      const a = Math.exp(-(((u - 0.3) ** 2) / 0.02 + ((v - 0.35) ** 2) / 0.03)) * 9000;
      const b = Math.exp(-(((u - 0.7) ** 2) / 0.01 + ((v - 0.7) ** 2) / 0.01)) * 4000;
      const c = Math.round((a + b) * (0.7 + random() * 0.6) + (dense ? 1 : 0) + (random() < 0.3 ? random() * 20 : 0));
      if (c <= 0) continue;
      x.push(i);
      y.push(j * 2);
      counts.push(BigInt(c));
    }
  }
  return new Table({
    x: makeVector(Float64Array.from(x)),
    x_end: makeVector(Float64Array.from(x, (v) => v + 1)),
    y: makeVector(Float64Array.from(y)),
    y_end: makeVector(Float64Array.from(y, (v) => v + 2)),
    count: makeVector(BigInt64Array.from(counts)),
  });
}

export interface SyntheticScatterOptions {
  points?: number;
  series?: number;
  seed?: number;
}

/** A scatter result: `x`, `y` DOUBLE (+ colour), correlated clusters per series. */
export function syntheticScatterTable({ points = 2000, series = 3, seed = 3 }: SyntheticScatterOptions = {}): Table {
  const random = prng(seed);
  const x = new Float64Array(points);
  const y = new Float64Array(points);
  const s = new Uint8Array(points);
  for (let i = 0; i < points; i += 1) {
    const k = Math.min(series - 1, Math.floor(random() ** 1.6 * series));
    s[i] = k;
    const distance = Math.abs(normal(random) * 3 + 2 + k * 2.5);
    x[i] = Math.round(distance * 100) / 100;
    y[i] = Math.round((3 + distance * 2.6 + normal(random) * (1.5 + k)) * 100) / 100;
  }
  const columns: Record<string, Vector> = { x: makeVector(x), y: makeVector(y) };
  return new Table(series > 1 ? { ...columns, ...colorColumns(s, series, false) } : columns);
}

export interface SyntheticBarOptions {
  categories?: number;
  seed?: number;
}

/** A bar result: `x` VARCHAR, `y` DOUBLE, top N by measure (descending). */
export function syntheticBarTable({ categories = 20, seed = 9 }: SyntheticBarOptions = {}): Table {
  const random = prng(seed);
  const labels: string[] = [];
  const values: number[] = [];
  let v = 2_700_000;
  for (let i = 0; i < categories; i += 1) {
    labels.push(i < SERIES_NAMES.length - 1 ? (SERIES_NAMES[i] ?? '') : `Zone ${i + 1}`);
    values.push(Math.round(v));
    v *= 0.45 + random() * 0.4;
  }
  return new Table({ x: vectorFromArray(labels, new Utf8()), y: makeVector(Float64Array.from(values)) });
}
