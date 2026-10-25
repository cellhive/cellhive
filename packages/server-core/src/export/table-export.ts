import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';

import { writeXlsxStream } from 'hucre/xlsx';

import { CSV_LINE_BREAK, csvLine, UTF8_BOM } from './csv.js';

import type { RecordOutput, RecordStreamField, RecordStreamTarget } from '../records/types.js';
import type { TableExportFormat } from '@cellhive/contracts';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/**
 * Table export files (BACKLOG T307, CONTRACTS §18): the records of a
 * `RecordStream` (values in `cell_format=text`) as CSV or XLSX, produced
 * while they are read. Both bodies are pull-based: the next records are
 * read only when the consumer (the HTTP response) asks for more bytes, so
 * a slow client slows the database reads down instead of filling memory,
 * and destroying the body stops the reads.
 */

export const TABLE_EXPORT_CONTENT_TYPES: Readonly<Record<TableExportFormat, string>> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** The first `max` user-perceived characters of `text` (never splits a character). */
function truncate(text: string, max: number): string {
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
  return Array.from(segments, (part) => part.segment)
    .slice(0, max)
    .join('');
}

/** Excel's limit on sheet names. */
const MAX_SHEET_NAME_LENGTH = 31;
/** Longest file name offered (before the extension), in characters. */
const MAX_FILE_NAME_LENGTH = 120;

/** The text of a cell as written: text reads are strings; anything else is stringified defensively. */
function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** The cells of one record in column order; a column the record lacks is empty. */
function rowCells(fields: readonly RecordStreamField[], record: RecordOutput): (string | null)[] {
  return fields.map((field) =>
    Object.hasOwn(record.fields, field.id) ? cellText(record.fields[field.id]) : null,
  );
}

/**
 * CSV (RFC 4180, UTF-8 with BOM, CRLF): a header line of field names, then
 * one line per record. Every cell, header included, is protected against
 * CSV injection (`csvCell`).
 */
export async function* csvExportChunks(
  fields: readonly RecordStreamField[],
  records: AsyncIterable<readonly RecordOutput[]>,
): AsyncGenerator<Buffer, void, undefined> {
  yield Buffer.from(
    `${UTF8_BOM}${csvLine(fields.map((field) => field.name))}${CSV_LINE_BREAK}`,
    'utf8',
  );
  for await (const chunk of records) {
    let text = '';
    for (const record of chunk) text += `${csvLine(rowCells(fields, record))}${CSV_LINE_BREAK}`;
    if (text !== '') yield Buffer.from(text, 'utf8');
  }
}

async function* xlsxRows(
  fields: readonly RecordStreamField[],
  records: AsyncIterable<readonly RecordOutput[]>,
): AsyncGenerator<(string | null)[], void, undefined> {
  for await (const chunk of records) {
    for (const record of chunk) yield rowCells(fields, record);
  }
}

/** A sheet name Excel accepts: no `[]:*?/\`, not quoted, at most 31 characters, never empty. */
export function sheetNameOf(name: string): string {
  const cleaned = truncate(
    name.replace(/[[\]:*?/\\\p{Cc}]/gu, ' ').replace(/^'+|'+$/g, ''),
    MAX_SHEET_NAME_LENGTH,
  ).trim();
  return cleaned === '' ? 'Export' : cleaned;
}

/**
 * XLSX (one sheet named after the view or table, a header row of field
 * names, then one row per record). Written by `hucre`'s streaming writer:
 * inline strings (no shared-string table growing with the data), DEFLATE
 * through `CompressionStream`, sheets past Excel's 1 048 576 rows rolled
 * over. Every cell is a string cell, never a formula, so text starting
 * with `=` stays inert and is written unchanged.
 */
export function xlsxExportStream(
  fields: readonly RecordStreamField[],
  records: AsyncIterable<readonly RecordOutput[]>,
  sheetName: string,
): WebReadableStream<Uint8Array> {
  return writeXlsxStream(xlsxRows(fields, records), {
    name: sheetNameOf(sheetName),
    columns: fields.map((field) => ({ header: field.name })),
    freezePane: { rows: 1 },
  });
}

/** The export body as a Node stream (see the module comment for flow control). */
export function tableExportBody(
  format: TableExportFormat,
  target: RecordStreamTarget,
  fields: readonly RecordStreamField[],
  records: AsyncIterable<readonly RecordOutput[]>,
): Readable {
  if (format === 'csv')
    return Readable.from(csvExportChunks(fields, records), { objectMode: false });
  return Readable.fromWeb(
    xlsxExportStream(fields, records, target.view?.name ?? target.table.name),
  );
}

/**
 * `Content-Disposition` of an export: `<table>[ - <view>].<ext>`, with an
 * ASCII `filename` (accents removed, other characters `_`) and the UTF-8
 * name in `filename*` (RFC 6266 / 8187).
 */
export function tableExportDisposition(
  target: RecordStreamTarget,
  format: TableExportFormat,
): string {
  const base =
    target.view === null ? target.table.name : `${target.table.name} - ${target.view.name}`;
  return attachmentDisposition(base, format);
}

/**
 * `Content-Disposition: attachment` of a file named `<name>.<extension>`
 * (control characters, `/`, `\` and `"` replaced, at most 120 characters,
 * `export` when empty), with an ASCII `filename` and the UTF-8 `filename*`.
 */
export function attachmentDisposition(name: string, extension: string): string {
  const cleaned = truncate(name.replace(/[\p{Cc}/\\"]/gu, ' ').trim(), MAX_FILE_NAME_LENGTH);
  const full = `${cleaned === '' ? 'export' : cleaned}.${extension}`;
  const ascii = full
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, (letter) => (letter === 'đ' ? 'd' : 'D'))
    .replace(/[^A-Za-z0-9 ._-]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc8187(full)}`;
}

/** `encodeURIComponent` plus the characters RFC 8187 `attr-char` excludes. */
function encodeRfc8187(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
