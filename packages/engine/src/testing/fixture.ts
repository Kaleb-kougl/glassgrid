/*
 * The engine fixture (`id, category, amount, created_on`; the E2E fixture's
 * shape), runtime-neutral so the browser test page can build it as a Blob
 * and Node tests as a file. Row i (0-based) has id i + 1.
 */
export const CATEGORIES = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const;

export const FIXTURE_HEADER = 'id,category,amount,created_on';

export function fixtureRow(i: number): { id: number; category: string; amount: number; createdOn: string } {
  const pad2 = (value: number) => String(value).padStart(2, '0');
  return {
    id: i + 1,
    category: CATEGORIES[i % CATEGORIES.length] ?? 'alpha',
    amount: ((i * 7919) % 1_000_000) / 100,
    createdOn: `2026-${pad2((i % 12) + 1)}-${pad2((i % 28) + 1)}`,
  };
}

export function* fixtureLines(rows: number): Generator<string> {
  for (let i = 0; i < rows; i += 1) {
    const row = fixtureRow(i);
    yield `${row.id},${row.category},${row.amount},${row.createdOn}`;
  }
}

/** The whole fixture CSV as text (fine up to a few hundred thousand rows). */
export function fixtureCsv(rows: number): string {
  return `${FIXTURE_HEADER}\n${[...fixtureLines(rows)].join('\n')}\n`;
}
