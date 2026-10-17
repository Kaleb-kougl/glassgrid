import { ColumnTypeSchema, type CompileColumn } from '../spec/column.js';
import { CompileError } from './errors.js';

const MAX_LISTED = 25;

/** Name lookup over the engine-supplied column list, with user-facing errors. */
export class ColumnIndex {
  private readonly byName = new Map<string, CompileColumn>();

  constructor(readonly columns: readonly CompileColumn[]) {
    for (const column of columns) {
      if (!ColumnTypeSchema.safeParse(column.type).success) {
        throw new CompileError('invalid_spec', `Column "${column.name}" has an unknown type ${JSON.stringify(column.type)}`);
      }
      if (!this.byName.has(column.name)) this.byName.set(column.name, column);
    }
  }

  get(name: string, path: string): CompileColumn {
    const column = this.byName.get(name);
    if (column) return column;
    const names = this.columns.map((c) => JSON.stringify(c.name));
    const listed =
      names.length === 0
        ? 'The table has no columns.'
        : `Available columns: ${names.slice(0, MAX_LISTED).join(', ')}${names.length > MAX_LISTED ? `, and ${names.length - MAX_LISTED} more` : ''}.`;
    throw new CompileError('unknown_column', `Unknown column ${JSON.stringify(name)} at ${path}. ${listed}`, path);
  }
}
