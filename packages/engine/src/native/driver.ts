import {
  DuckDBDecimalValue,
  DuckDBInstance,
  DuckDBListValue,
  DuckDBStructValue,
  version as duckdbVersion,
  type DuckDBConnection,
  type DuckDBValue,
} from '@duckdb/node-api';
import type { DatabaseOptions, DriverParam, DriverResult, DriverValue, DuckConnection, DuckDatabase, DuckDriver } from '../driver';
import { readerToArrowIPC } from './arrow';
import { nodeFiles } from './files';
import { createSandboxedInstance, defaultMemoryLimitBytes, removeTempDirectory } from './sandbox';

/*
 * The native driver: `@duckdb/node-api` (DuckDB 1.5.x, N-API) in Node or
 * Electron's utility process. One DuckDB instance per table, locked down at
 * creation (sandbox.ts); spills to a private folder; `interrupt()` stops a
 * statement within milliseconds; progress from `connection.progress`.
 */

function toDriverValue(value: DuckDBValue): DriverValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
    return value;
  }
  if (value instanceof DuckDBDecimalValue) return value.toDouble();
  if (value instanceof DuckDBListValue) return value.items.map(toDriverValue);
  if (value instanceof DuckDBStructValue) {
    return Object.fromEntries(Object.entries(value.entries).map(([key, entry]) => [key, toDriverValue(entry)]));
  }
  return String(value);
}

function bindable(params: readonly DriverParam[] | undefined): DriverParam[] | undefined {
  return params && params.length > 0 ? [...params] : undefined;
}

class NativeConnection implements DuckConnection {
  constructor(private readonly connection: DuckDBConnection) {}

  async run(sql: string, params?: readonly DriverParam[]): Promise<void> {
    await this.connection.run(sql, bindable(params));
  }

  async query(sql: string, params?: readonly DriverParam[]): Promise<DriverResult> {
    const reader = await this.connection.runAndReadAll(sql, bindable(params));
    return { columns: reader.columnNames(), rows: reader.getRows().map((row) => row.map(toDriverValue)) };
  }

  async arrow(sql: string, params?: readonly DriverParam[]): Promise<Uint8Array> {
    return readerToArrowIPC(await this.connection.runAndReadAll(sql, bindable(params)));
  }

  interrupt(): void {
    this.connection.interrupt();
  }

  async enableProgress(): Promise<void> {
    await this.connection.run('PRAGMA enable_progress_bar');
    await this.connection.run('PRAGMA disable_print_progress_bar');
  }

  progress(): number | null {
    const percentage = this.connection.progress.percentage;
    return percentage < 0 ? null : percentage;
  }

  close(): void {
    this.connection.closeSync();
  }
}

class NativeDatabase implements DuckDatabase {
  constructor(
    private readonly instance: DuckDBInstance,
    private readonly tempDirectory: string,
  ) {}

  async connect(): Promise<DuckConnection> {
    return new NativeConnection(await this.instance.connect());
  }

  async close(): Promise<void> {
    this.instance.closeSync();
    await removeTempDirectory(this.tempDirectory);
  }
}

export class NativeDriver implements DuckDriver {
  readonly name = 'native';
  readonly capabilities = {
    interrupt: 'immediate',
    progress: true,
    parquet: true,
    isolatedInstances: true,
    spill: true,
  } as const;
  readonly files = nodeFiles;

  async start(): Promise<string> {
    const probe = await DuckDBInstance.create(':memory:', { autoinstall_known_extensions: 'false' });
    probe.closeSync();
    return duckdbVersion();
  }

  async createDatabase(options: DatabaseOptions): Promise<DuckDatabase> {
    return new NativeDatabase(await createSandboxedInstance(options), options.tempDirectory);
  }

  defaultMemoryLimitBytes(): number {
    return defaultMemoryLimitBytes();
  }

  removeTempDirectory(path: string): Promise<void> {
    return removeTempDirectory(path);
  }

  close(): void {
    // Instances belong to tables; QueryService closes them.
  }
}

export function createNativeDriver(): NativeDriver {
  return new NativeDriver();
}
