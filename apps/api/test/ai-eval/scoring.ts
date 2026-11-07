/**
 * Pure scoring helpers of the manual AI eval (BACKLOG T917,
 * `test/ai-eval/README.md`): the numbers of two answers, the values of two
 * formula previews, latency percentiles. Unit-tested in
 * `test/unit/ai-eval-scoring.test.ts` so the kit cannot rot between runs.
 */

/** `p`-th percentile (nearest rank) of `values`, `null` when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

/** A number rounded to `digits` decimals (floating sums of money differ in the last bits). */
function rounded(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** A cell of widget data or a preview value, comparable: groups by value, numbers rounded. */
export function normalizeValue(value: unknown): unknown {
  if (typeof value === 'number') return rounded(value);
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value !== null && typeof value === 'object') {
    const group = value as Record<string, unknown>;
    // A group of widget data: its value identifies it (labels are for display).
    if ('value' in group) return normalizeValue(group['value']);
    return Object.fromEntries(
      Object.keys(group)
        .sort()
        .map((key) => [key, normalizeValue(group[key])]),
    );
  }
  return value;
}

/**
 * Widget data rows as comparable text: each row normalized, rows sorted unless
 * the order matters (a "top N" question).
 */
export function normalizeRows(rows: readonly unknown[], ordered = false): string[] {
  const texts = rows.map((row) => JSON.stringify(normalizeValue(row)));
  return ordered ? texts : texts.sort();
}

/** The same numbers: equal rows after normalization (CONTRACTS §29.4 data). */
export function sameRows(
  actual: readonly unknown[],
  expected: readonly unknown[],
  ordered = false,
): boolean {
  const a = normalizeRows(actual, ordered);
  const e = normalizeRows(expected, ordered);
  return a.length === e.length && a.every((row, index) => row === e[index]);
}

/** Two formula previews compute the same values on the same records (CONTRACTS §13). */
export function sameValues(
  actual: readonly { readonly id: string; readonly value: unknown }[],
  expected: readonly { readonly id: string; readonly value: unknown }[],
): boolean {
  if (actual.length !== expected.length || actual.length === 0) return false;
  const byId = new Map(
    expected.map((item) => [item.id, JSON.stringify(normalizeValue(item.value))]),
  );
  return actual.every((item) => byId.get(item.id) === JSON.stringify(normalizeValue(item.value)));
}

/** A file-name-safe form of a model name (`qwen2.5:7b-instruct` → `qwen2.5-7b-instruct`). */
export function slugOf(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'model';
}
