export const DEFAULT_E2E_ROWS = 1_000_000;

/** Rows in the generated fixture; override with GLASSGRID_E2E_ROWS (e.g. 10000000). */
export function e2eRowCount(): number {
  const raw = process.env['GLASSGRID_E2E_ROWS'];
  if (raw === undefined || raw === '') return DEFAULT_E2E_ROWS;
  const rows = Number(raw.replaceAll('_', ''));
  if (!Number.isSafeInteger(rows) || rows < 1) {
    throw new Error(`GLASSGRID_E2E_ROWS must be a positive integer, got "${raw}"`);
  }
  return rows;
}
