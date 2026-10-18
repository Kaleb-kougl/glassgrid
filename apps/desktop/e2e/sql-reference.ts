import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

/*
 * An independent SQL reference for the E2E: the fixture loaded into its own
 * DuckDB (not the app's engine), queried with filters written out here by
 * hand, so a wrong compiler or cube answer cannot agree with itself.
 */

type Bound = number | string;

/** The filter shapes the app's views send (core's `Filter`, as JSON). */
export type ReferenceFilter =
  | { kind: 'range'; column: string; min?: Bound; max?: Bound; minInclusive?: boolean; maxInclusive?: boolean }
  | { kind: 'in' | 'notIn'; column: string; values: (string | number | boolean | null)[] }
  | { kind: 'isNull' | 'notNull'; column: string };

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

export class SqlReference {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
    private readonly types: ReadonlyMap<string, string>,
  ) {}

  /** Loads `csvPath` into an in-memory table (DuckDB's own type sniffing, as the app does). */
  static async open(csvPath: string): Promise<SqlReference> {
    const instance = await DuckDBInstance.create(':memory:', { threads: '2' });
    const connection = await instance.connect();
    await connection.run(`CREATE TABLE trips AS SELECT * FROM read_csv(${text(csvPath)})`);
    const described = await connection.runAndReadAll('DESCRIBE trips');
    const types = new Map(described.getRows().map((row) => [String(row[0]), String(row[1])]));
    return new SqlReference(instance, connection, types);
  }

  private literal(column: string, value: Bound | boolean | null): string {
    if (value === null) return 'NULL';
    if (typeof value === 'number' || typeof value === 'boolean') {
      const type = this.types.get(column) ?? '';
      // Epoch milliseconds on a time column.
      if (typeof value === 'number' && (type.startsWith('TIMESTAMP') || type === 'DATE')) return `make_timestamp(${Math.round(value * 1000)})`;
      return String(value);
    }
    const type = this.types.get(column) ?? '';
    if (type.startsWith('TIMESTAMP')) return `TIMESTAMP ${text(value)}`;
    if (type === 'DATE') return `CAST(${text(value)} AS TIMESTAMP)`;
    return text(value);
  }

  private predicate(filter: ReferenceFilter): string {
    const column = ident(filter.column);
    switch (filter.kind) {
      case 'range': {
        const parts: string[] = [];
        if (filter.min !== undefined) parts.push(`${column} ${filter.minInclusive === false ? '>' : '>='} ${this.literal(filter.column, filter.min)}`);
        if (filter.max !== undefined) parts.push(`${column} ${filter.maxInclusive === false ? '<' : '<='} ${this.literal(filter.column, filter.max)}`);
        return parts.join(' AND ') || 'TRUE';
      }
      case 'in': {
        const values = filter.values.filter((value) => value !== null).map((value) => this.literal(filter.column, value));
        const parts = values.length > 0 ? [`${column} IN (${values.join(', ')})`] : [];
        if (filter.values.includes(null)) parts.push(`${column} IS NULL`);
        return parts.length > 0 ? `(${parts.join(' OR ')})` : 'FALSE';
      }
      case 'notIn': {
        const values = filter.values.filter((value) => value !== null).map((value) => this.literal(filter.column, value));
        const notListed = values.length > 0 ? `(${column} IS NULL OR ${column} NOT IN (${values.join(', ')}))` : 'TRUE';
        return filter.values.includes(null) ? `(${column} IS NOT NULL AND ${notListed})` : notListed;
      }
      case 'isNull':
        return `${column} IS NULL`;
      case 'notNull':
        return `${column} IS NOT NULL`;
    }
  }

  private where(filters: readonly ReferenceFilter[]): string {
    return filters.length === 0 ? '' : ` WHERE ${filters.map((filter) => this.predicate(filter)).join(' AND ')}`;
  }

  /** Rows matching every filter. */
  async count(filters: readonly ReferenceFilter[]): Promise<number> {
    const result = await this.connection.runAndReadAll(`SELECT count(*) FROM trips${this.where(filters)}`);
    return Number(result.getRows()[0]?.[0] ?? 0);
  }

  /** Rows per value of `column` under the filters. */
  async countBy(column: string, filters: readonly ReferenceFilter[]): Promise<Map<string, number>> {
    const result = await this.connection.runAndReadAll(`SELECT ${ident(column)}, count(*) FROM trips${this.where(filters)} GROUP BY 1`);
    return new Map(result.getRows().map((row) => [String(row[0]), Number(row[1])]));
  }

  close(): void {
    this.connection.closeSync();
    this.instance.closeSync();
  }
}
