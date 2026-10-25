/** Byte order mark: spreadsheet apps then read UTF-8 (Vietnamese) text correctly. */
export const UTF8_BOM = String.fromCharCode(0xfeff);

/** Line break of every CSV file written by the server (RFC 4180). */
export const CSV_LINE_BREAK = '\r\n';

/** First characters a spreadsheet runs as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * `'` before formula-like text, as `csvCell` adds it: text that already
 * starts like that (`'=x`) gets one more `'`, so that `unescapeCsvInjection`
 * dropping exactly one gives it back unchanged.
 */
const QUOTED_FORMULA_START = /^'+[=+\-@\t\r]/;

/**
 * A plain number: an optional leading `-`, digits, optionally grouped or
 * split by `.`/`,` (`-1`, `-1.500.000`, `-1,5`). Nothing else — no spaces,
 * letters, currency symbols or operators — so it is never run as a formula.
 */
const PLAIN_NUMBER = /^-?\d+(?:[.,]\d+)*$/;

/**
 * One CSV cell (RFC 4180). Text a spreadsheet would run as a formula
 * (`=`, `+`, `-`, `@`, tab, carriage return first) gets a leading `'`
 * (CSV injection, OWASP), except a plain number such as `-1.500` (T321: a
 * negative number is not a formula); so does text that already starts with
 * `'` and then such a character (`'=x` → `''=x`); cells with `"`, `,`, CR
 * or LF are quoted. Import strips that one `'` again (`unescapeCsvInjection`).
 */
export function csvCell(value: string | null): string {
  if (value === null) return '';
  const escape =
    (FORMULA_START.test(value) && !PLAIN_NUMBER.test(value)) || QUOTED_FORMULA_START.test(value);
  const safe = escape ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** One CSV line of `cells`, without the line break. */
export function csvLine(cells: readonly (string | null)[]): string {
  return cells.map(csvCell).join(',');
}

/**
 * The text of an imported cell without the `'` that `csvCell` (or a
 * spreadsheet app) puts before formula-like text: one leading `'` is dropped
 * when the text then goes on with `'`s and `=`, `+`, `-`, `@`, tab or
 * carriage return, so files exported by Cellhive import back unchanged
 * (T321, also `'=x` exported as `''=x`). Other text is kept as is.
 */
export function unescapeCsvInjection(value: string): string {
  return QUOTED_FORMULA_START.test(value) ? value.slice(1) : value;
}
