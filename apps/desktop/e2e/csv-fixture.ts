import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

const CATEGORIES = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const;
const ROWS_PER_CHUNK = 50_000;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Write a deterministic CSV with a header and `rows` data rows. Mixed column
 * types (int, text, double, date) keep DuckDB's header sniffing unambiguous.
 * Returns the file size in bytes.
 */
export async function writeFixtureCsv(path: string, rows: number): Promise<number> {
  const out = createWriteStream(path, { encoding: 'utf8' });
  out.write('id,category,amount,created_on\n');

  for (let start = 0; start < rows; start += ROWS_PER_CHUNK) {
    const end = Math.min(rows, start + ROWS_PER_CHUNK);
    let chunk = '';
    for (let i = start; i < end; i += 1) {
      const category = CATEGORIES[i % CATEGORIES.length];
      const amount = ((i * 7919) % 1_000_000) / 100;
      const month = (i % 12) + 1;
      const day = (i % 28) + 1;
      chunk += `${i + 1},${category},${amount},2026-${pad2(month)}-${pad2(day)}\n`;
    }
    if (!out.write(chunk)) await once(out, 'drain');
  }

  out.end();
  await finished(out);
  return (await stat(path)).size;
}
