/*
 * Cross-filter cubes kept by the engine (see packages/core/src/sql/cube.ts
 * for what a cube is). A cube is a small DuckDB table in the brushed table's
 * own instance, named after a digest of its build query, and kept LRU.
 */

/** A cube with more cells than this is dropped after its build and the view keeps querying the table. */
export const MAX_CUBE_ROWS = 1_000_000;
/** Cubes are skipped without a build when the profile estimates more cells than this. */
export const MAX_CUBE_ESTIMATE = 4_000_000;
export const MAX_CUBES = 48;
/** Total cells across all cubes; the least recently used cubes go first. */
export const MAX_CUBE_TOTAL_ROWS = 6_000_000;
/** Builds remembered as too large (so they are not retried on every brush). */
const MAX_TOO_LARGE = 256;

export interface CubeRef {
  /** Quoted table name inside the table's DuckDB instance. */
  readonly name: string;
  readonly tableId: string;
  readonly rows: number;
}

export interface CubeStoreStats {
  cubes: number;
  rows: number;
  hits: number;
  builds: number;
  tooLarge: number;
}

export class CubeStore {
  private readonly cubes = new Map<string, CubeRef>();
  private readonly tooLarge = new Map<string, number>();
  private rows = 0;
  private hits = 0;
  private builds = 0;

  constructor(
    private readonly maxCubes = MAX_CUBES,
    private readonly maxRows = MAX_CUBE_TOTAL_ROWS,
  ) {}

  /** The ready cube for `key`, marked as recently used. */
  get(key: string): CubeRef | undefined {
    const cube = this.cubes.get(key);
    if (!cube) return undefined;
    this.hits += 1;
    this.cubes.delete(key);
    this.cubes.set(key, cube);
    return cube;
  }

  /** Rows of a build that turned out too large, if it did. */
  tooLargeRows(key: string): number | undefined {
    return this.tooLarge.get(key);
  }

  markTooLarge(key: string, rows: number): void {
    this.tooLarge.set(key, rows);
    for (const oldest of this.tooLarge.keys()) {
      if (this.tooLarge.size <= MAX_TOO_LARGE) break;
      this.tooLarge.delete(oldest);
    }
  }

  /** Registers a built cube; returns the cubes evicted to make room (their tables should be dropped). */
  add(key: string, cube: CubeRef): CubeRef[] {
    this.builds += 1;
    const previous = this.cubes.get(key);
    if (previous) {
      this.cubes.delete(key);
      this.rows -= previous.rows;
    }
    this.cubes.set(key, cube);
    this.rows += cube.rows;
    const evicted: CubeRef[] = [];
    for (const [oldestKey, oldest] of this.cubes) {
      if (this.cubes.size <= this.maxCubes && this.rows <= this.maxRows) break;
      if (oldestKey === key) continue;
      this.cubes.delete(oldestKey);
      this.rows -= oldest.rows;
      evicted.push(oldest);
    }
    return evicted;
  }

  /** Forgets every cube of a table (or all); returns them so their tables can be dropped. */
  remove(tableId?: string): CubeRef[] {
    const removed: CubeRef[] = [];
    for (const [key, cube] of this.cubes) {
      if (tableId !== undefined && cube.tableId !== tableId) continue;
      this.cubes.delete(key);
      this.rows -= cube.rows;
      removed.push(cube);
    }
    if (tableId === undefined) this.tooLarge.clear();
    else for (const key of this.tooLarge.keys()) if (key.startsWith(`${tableId}\u0000`)) this.tooLarge.delete(key);
    return removed;
  }

  stats(): CubeStoreStats {
    return { cubes: this.cubes.size, rows: this.rows, hits: this.hits, builds: this.builds, tooLarge: this.tooLarge.size };
  }
}
