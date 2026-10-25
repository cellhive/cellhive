import { FIELD_TYPE_REGISTRY, formatComputedText, type LocaleContext } from '@cellhive/field-types';

import { linkRefsOf, linkText, pastedLinkValue } from '../lib/links/values';

import type { GridField } from './types';

/**
 * The json write value of pasted text (sent with `typecast=true`): the text
 * itself, or for a link cell its comma-separated titles as a list (the
 * server reads one string as one title, CONTRACTS §2; T413).
 */
export function pastedWriteValue(field: GridField, text: string): unknown {
  if (text === '') return null;
  return field.link !== undefined ? pastedLinkValue(text) : text;
}

/**
 * Kind of a copied cell: a pasted json value is reused only by a cell of
 * the same kind. Links of different tables are different kinds (their ids
 * would not exist in the other table, T413).
 */
export function clipboardKindOf(field: GridField): string {
  return field.link === undefined ? field.field.type : `link:${field.link.link_table}`;
}

/**
 * Clipboard of the grid (FRONTEND §6.3): tab-separated text as Excel and
 * Google Sheets write and read it, an HTML table beside it, and the text of
 * a cell as `cell_format=text` shows it. Pure functions; `GridView` wires
 * the `copy` / `cut` / `paste` events.
 */

/** A rectangle of cell texts, row by row. */
export type CellMatrix = readonly (readonly string[])[];

/** What a copy puts on the clipboard. */
export interface ClipboardContent {
  readonly text: string;
  readonly html: string;
}

const QUOTE = '"';

function isLineBreak(char: string | undefined): boolean {
  return char === '\n' || char === '\r';
}

function isCellEnd(char: string | undefined): boolean {
  return char === undefined || char === '\t' || isLineBreak(char);
}

/**
 * Reads a quoted cell starting at `start` (the opening quote). Returns the
 * value and the index after the closing quote, or `null` when the quotes do
 * not close right before a tab, a line break or the end (then the cell is
 * plain text that happens to start with a quote).
 */
function readQuoted(text: string, start: number): { value: string; end: number } | null {
  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === QUOTE) {
      if (text[index + 1] === QUOTE) {
        value += QUOTE;
        index += 2;
        continue;
      }
      return isCellEnd(text[index + 1]) ? { value, end: index + 1 } : null;
    }
    // Line breaks inside a cell: CRLF and CR become LF.
    if (char === '\r') {
      value += '\n';
      index += text[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    value += char;
    index += 1;
  }
  return null;
}

/**
 * Parses tab-separated text copied from Excel, Google Sheets or this grid:
 * rows end with LF, CRLF or CR (one trailing line break is ignored), cells
 * are separated by tabs, and a cell that starts with `"` is quoted when the
 * quote closes right before a tab or line break — it may then hold tabs,
 * line breaks and doubled quotes. Rows are padded to the widest one.
 */
export function parseTsv(input: string): string[][] {
  // Excel ends the copied range with a line break.
  const text = input.endsWith('\r\n')
    ? input.slice(0, -2)
    : isLineBreak(input.at(-1))
      ? input.slice(0, -1)
      : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let index = 0;
  for (;;) {
    let value: string;
    const quoted = text[index] === QUOTE ? readQuoted(text, index) : null;
    if (quoted === null) {
      let end = index;
      while (!isCellEnd(text[end])) end += 1;
      value = text.slice(index, end);
      index = end;
    } else {
      value = quoted.value;
      index = quoted.end;
    }
    row.push(value);
    const separator = text[index];
    if (separator === '\t') {
      index += 1;
      continue;
    }
    rows.push(row);
    if (separator === undefined) break;
    row = [];
    index += separator === '\r' && text[index + 1] === '\n' ? 2 : 1;
  }
  const width = rows.reduce((widest, cells) => Math.max(widest, cells.length), 0);
  return rows.map((cells) =>
    cells.length === width ? cells : [...cells, ...Array<string>(width - cells.length).fill('')],
  );
}

/** A cell as TSV: quoted (quotes doubled) when it holds a tab or line break, or starts with a quote. */
function tsvCell(value: string): string {
  if (!/[\t\n\r]/u.test(value) && !value.startsWith(QUOTE)) return value;
  return `${QUOTE}${value.replaceAll(QUOTE, QUOTE + QUOTE)}${QUOTE}`;
}

/** Writes cells as TSV that `parseTsv`, Excel and Google Sheets read back cell by cell. */
export function serializeTsv(rows: CellMatrix): string {
  return rows.map((row) => row.map(tsvCell).join('\t')).join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The same cells as an HTML table (`text/html`), which spreadsheets and documents paste as a table. */
export function toHtmlTable(rows: CellMatrix): string {
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell).replaceAll('\n', '<br>')}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<meta charset="utf-8"><table><tbody>${body}</tbody></table>`;
}

export function clipboardContent(rows: CellMatrix): ClipboardContent {
  return { text: serializeTsv(rows), html: toHtmlTable(rows) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text of a value the client has no formatter for (S4 types): titles, names, else ids. */
function fallbackText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '✓' : '';
  if (Array.isArray(value))
    return value
      .map(fallbackText)
      .filter((text) => text !== '')
      .join(', ');
  if (isObject(value)) {
    for (const key of ['title', 'name', 'email', 'id']) {
      const text = value[key];
      if (typeof text === 'string') return text;
    }
  }
  return '';
}

/**
 * What a cell shows while pasted text is being written: the text read like
 * `typecast` reads it, in the user's locale (the server reads it in the
 * base locale and its answer replaces this). `undefined` when the text
 * cannot be read here: the cell keeps its value until the server answers.
 */
export function pastedDisplay(field: GridField, text: string, locale: LocaleContext): unknown {
  const config = field.config;
  if (text.trim() === '') return config?.type === 'checkbox' ? false : null;
  if (config === null) return undefined;
  try {
    const cast = (
      FIELD_TYPE_REGISTRY[config.type] as {
        typecast: (
          input: unknown,
          options: unknown,
          ctx: LocaleContext,
        ) => { ok: boolean; value?: unknown };
      }
    ).typecast(text, config.options, locale);
    return cast.ok ? cast.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The text of a cell like `cell_format=text` (CONTRACTS §2): the formatter
 * of `field-types` in the user's locale; empty cells are empty strings.
 */
export function cellClipboardText(field: GridField, value: unknown, locale: LocaleContext): string {
  // Button (T525): its label, like `cell_format=text` and exports (CONTRACTS §2).
  if (field.button !== undefined) return field.button.label;
  if (value === null || value === undefined) return '';
  // Link (T413): readable titles only, never the id of a record the user cannot read (P20).
  if (field.link !== undefined) return linkText(linkRefsOf(value));
  // Formula / lookup (T468): `cell_format=text` by result type and style; errors, locked → ''.
  const computed = field.computed;
  if (computed !== undefined) {
    if (computed.locked || computed.error !== null) return '';
    return computed.resultType === null
      ? fallbackText(value)
      : formatComputedText(value, computed.resultType, computed.style, locale);
  }
  const config = field.config;
  if (config === null) return fallbackText(value);
  try {
    return (
      FIELD_TYPE_REGISTRY[config.type] as {
        formatText: (value: unknown, options: unknown, ctx: LocaleContext) => string;
      }
    ).formatText(value, config.options, locale);
  } catch {
    // A value the formatter does not expect (stale shape): its plain text.
    return fallbackText(value);
  }
}
