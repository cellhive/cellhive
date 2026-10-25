import { Transform, type Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { IMPORT_MAX_CELL_CHARS, IMPORT_MAX_COLUMNS } from '@cellhive/contracts';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

import { AppError } from '../errors/app-error.js';

import { importFileError } from './file-errors.js';

import type { ImportCell } from '@cellhive/contracts';

/**
 * Decompression limits of an XLSX file (zip bomb protection, like ADR-24
 * for `.chbase` packages). Checked on the central directory before any
 * entry is inflated, and again while inflating (declared sizes may lie:
 * `validateEntrySizes` and a byte counter stop at the declared size).
 */
export interface XlsxLimits {
  /** Most entries in the archive. */
  readonly maxEntries: number;
  /** Largest total of the declared uncompressed sizes, in bytes. */
  readonly maxTotalBytes: number;
  /**
   * Largest ratio total uncompressed / file size. Spreadsheet XML compresses
   * far better than a base package (repeated tags), hence more than the 20×
   * of ADR-24.
   */
  readonly maxRatio: number;
  /** Largest shared strings table: entries and characters (held in memory). */
  readonly maxSharedStrings: number;
  readonly maxSharedStringChars: number;
}

export const DEFAULT_XLSX_LIMITS: XlsxLimits = {
  maxEntries: 10_000,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxRatio: 100,
  maxSharedStrings: 2_000_000,
  maxSharedStringChars: 32 * 1024 * 1024,
};

/** One sheet of the workbook, in workbook order. */
export interface XlsxSheet {
  readonly name: string;
  /** Archive path of the sheet part, e.g. `xl/worksheets/sheet1.xml`. */
  readonly path: string;
}

/** A row of a sheet: `line` is the 1-based spreadsheet row number. */
export interface SheetRow {
  readonly line: number;
  readonly cells: ImportCell[];
}

const limitError = (message: string, params?: Record<string, unknown>) =>
  importFileError('ARCHIVE_LIMIT_EXCEEDED', message, params);
const invalid = (message: string) => importFileError('INVALID_FILE', message);

/** `x:row` → `row` (some writers prefix the SpreadsheetML namespace). */
function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function attribute(tag: SaxesTagPlain, name: string): string | undefined {
  const direct = tag.attributes[name];
  if (typeof direct === 'string') return direct;
  for (const [key, value] of Object.entries(tag.attributes)) {
    if (localName(key) === name && typeof value === 'string') return value;
  }
  return undefined;
}

/** `AB12` → 27 (0-based column); `undefined` when `ref` has no column letters. */
export function columnIndexOf(ref: string): number | undefined {
  let index = 0;
  let letters = 0;
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) index = index * 26 + (code - 64);
    else if (code >= 97 && code <= 122) index = index * 26 + (code - 96);
    else break;
    letters += 1;
    if (letters > 3) return undefined;
  }
  return letters === 0 ? undefined : index - 1;
}

/** Built-in number formats that show a date or time (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);
const BUILTIN_TIME_FORMATS = new Set([18, 19, 20, 21, 22, 45, 46, 47]);

/** How a number format shows a number: as is, as a date, or as a date and time. */
export type NumberFormatKind = 'number' | 'date' | 'datetime';

/** Classifies a custom number format code (quoted text, escapes and `[…]` ignored). */
export function numberFormatKind(code: string): NumberFormatKind {
  const section = code.split(';')[0] ?? '';
  const stripped = section
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?:h+|m+|s+)\]/gi, 'h')
    .replace(/\[[^\]]*\]/g, '');
  if (!/[dmyhs]/i.test(stripped)) return 'number';
  return /[hs]/i.test(stripped) ? 'datetime' : 'date';
}

const MS_PER_DAY = 86_400_000;
/** Serial of 9999-12-31, the last date a spreadsheet shows. */
const MAX_SERIAL_DATE = 2_958_465;
/** Day 0 of the 1900 date system, accounting for the 1900 leap-year bug. */
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/**
 * A serial date as ISO 8601 without zone: `YYYY-MM-DD`, or
 * `YYYY-MM-DDTHH:mm:ss` when the format shows a time or the value has one.
 */
export function serialToIso(serial: number, kind: 'date' | 'datetime', date1904: boolean): string {
  const epoch = date1904 ? EPOCH_1904 : EPOCH_1900;
  const ms = Math.round((serial * MS_PER_DAY) / 1000) * 1000 + epoch;
  const iso = new Date(ms).toISOString();
  const hasTime = ms % MS_PER_DAY !== 0;
  return kind === 'datetime' || hasTime ? iso.slice(0, 19) : iso.slice(0, 10);
}

/** Counts inflated bytes of one entry and stops past `limit`. */
function byteCounter(limit: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > limit) {
        callback(limitError('An entry of the workbook is larger than it declares.'));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Streams an XML part through `parser` (UTF-8 text, split safely between
 * chunks), pausing after each chunk: callers drain what the parser
 * produced, so a sheet is never held in memory.
 */
async function* feedXml(
  stream: Readable,
  parser: SaxesParser,
): AsyncGenerator<void, void, undefined> {
  const decoder = new StringDecoder('utf8');
  for await (const chunk of stream) {
    parser.write(decoder.write(chunk as Buffer));
    yield;
  }
  parser.write(decoder.end());
  parser.close();
  yield;
}

/** Feeds a whole XML part through `parser` (small parts: workbook, styles…). */
async function parseAll(stream: Readable, parser: SaxesParser): Promise<void> {
  const steps = feedXml(stream, parser);
  for (let step = await steps.next(); step.done !== true; step = await steps.next()) {
    // Handlers of `parser` collect what they need.
  }
}

function newParser(): SaxesParser {
  const parser = new SaxesParser({ xmlns: false, position: false });
  parser.on('error', (error) => {
    throw invalid(`The workbook XML is malformed (${error.message.slice(0, 120)}).`);
  });
  return parser;
}

interface Styles {
  /** Kind of each cell format (`s` attribute of a cell). */
  readonly kinds: NumberFormatKind[];
}

/**
 * Reads an XLSX workbook from a local file with bounded memory: the central
 * directory is checked against `XlsxLimits`; the workbook, its relationships,
 * styles and shared strings are read up front (shared strings stay in
 * memory, capped); a sheet is streamed row by row with a SAX parser.
 * Encrypted or malformed workbooks are `INVALID_FILE`.
 */
export class XlsxReader {
  private constructor(
    private readonly zip: ZipFile,
    private readonly entries: ReadonlyMap<string, Entry>,
    readonly sheets: readonly XlsxSheet[],
    private readonly date1904: boolean,
    private readonly limits: XlsxLimits,
    private sharedStrings: string[] | undefined,
    private styles: Styles | undefined,
  ) {}

  static async open(
    path: string,
    fileSize: number,
    limits: XlsxLimits = DEFAULT_XLSX_LIMITS,
  ): Promise<XlsxReader> {
    let zip: ZipFile;
    try {
      zip = await yauzl.openPromise(path, {
        lazyEntries: true,
        autoClose: false,
        validateEntrySizes: true,
        strictFileNames: false,
        decodeStrings: true,
      });
    } catch {
      throw invalid('The file is not a valid XLSX workbook.');
    }
    try {
      if (zip.entryCount > limits.maxEntries) {
        throw limitError('The workbook has too many entries.', { limit: limits.maxEntries });
      }
      const entries = new Map<string, Entry>();
      let total = 0;
      for await (const entry of zip.eachEntry()) {
        if (entry.isEncrypted()) throw invalid('Encrypted workbooks are not supported.');
        total += entry.uncompressedSize;
        if (total > limits.maxTotalBytes || total > Math.max(fileSize, 1) * limits.maxRatio) {
          throw limitError('The workbook decompresses to more than allowed.', {
            limit: Math.min(limits.maxTotalBytes, Math.max(fileSize, 1) * limits.maxRatio),
          });
        }
        entries.set(entry.fileName, entry);
      }
      const reader = new XlsxReader(zip, entries, [], false, limits, undefined, undefined);
      const { sheets, date1904 } = await reader.readWorkbook();
      return new XlsxReader(zip, entries, sheets, date1904, limits, undefined, undefined);
    } catch (error) {
      zip.close();
      if (error instanceof AppError) throw error;
      throw invalid('The file is not a valid XLSX workbook.');
    }
  }

  close(): void {
    this.zip.close();
  }

  /** Rows of `sheet`, streamed; fully empty rows are skipped. */
  async *rows(sheet: XlsxSheet): AsyncGenerator<SheetRow, void, undefined> {
    const sharedStrings = await this.loadSharedStrings();
    const styles = await this.loadStyles();
    const stream = await this.open(sheet.path);
    if (stream === undefined) throw invalid('A sheet of the workbook is missing.');
    const parser = newParser();
    const ready: SheetRow[] = [];
    let rowLine = 0;
    let cells: ImportCell[] = [];
    let cell: { column: number; type: string; style: number } | undefined;
    let nextColumn = 0;
    let text = '';
    let inValue = false;
    let inInline = false;
    let inPhonetic = false;
    let hasValue = false;
    const date1904 = this.date1904;

    const finishCell = () => {
      if (cell === undefined) return;
      const { column, type, style } = cell;
      cell = undefined;
      if (column >= IMPORT_MAX_COLUMNS) {
        throw invalid('A row of the workbook has too many columns.');
      }
      let value: ImportCell = null;
      if (hasValue) {
        switch (type) {
          case 's': {
            const shared = sharedStrings[Number.parseInt(text, 10)];
            value = shared === undefined || shared === '' ? null : shared;
            break;
          }
          case 'inlineStr':
          case 'str':
          case 'e':
            value = text === '' ? null : text.normalize('NFC');
            break;
          case 'b':
            value = text.trim() === '1';
            break;
          case 'd':
            value = text.trim() === '' ? null : text.trim();
            break;
          default: {
            const number = Number(text);
            if (text.trim() === '' || !Number.isFinite(number)) {
              value = text.trim() === '' ? null : text;
              break;
            }
            const kind = styles.kinds[style] ?? 'number';
            value =
              kind === 'number' || number < 0 || number > MAX_SERIAL_DATE
                ? number
                : serialToIso(number, kind, date1904);
          }
        }
      }
      while (cells.length < column) cells.push(null);
      cells[column] = value;
    };

    parser.on('opentag', (tag) => {
      switch (localName(tag.name)) {
        case 'row': {
          const r = Number.parseInt(attribute(tag, 'r') ?? '', 10);
          rowLine = Number.isSafeInteger(r) && r > 0 ? r : rowLine + 1;
          cells = [];
          nextColumn = 0;
          break;
        }
        case 'c': {
          const ref = attribute(tag, 'r');
          const column = (ref === undefined ? undefined : columnIndexOf(ref)) ?? nextColumn;
          nextColumn = column + 1;
          cell = {
            column,
            type: attribute(tag, 't') ?? 'n',
            style: Number.parseInt(attribute(tag, 's') ?? '0', 10) || 0,
          };
          text = '';
          hasValue = false;
          break;
        }
        case 'v':
          inValue = true;
          hasValue = true;
          break;
        case 'is':
          inInline = true;
          hasValue = true;
          break;
        case 'rPh':
          inPhonetic = true;
          break;
        default:
          break;
      }
    });
    parser.on('text', (value) => {
      if (cell === undefined || inPhonetic || !(inValue || inInline)) return;
      if (text.length + value.length > IMPORT_MAX_CELL_CHARS) {
        throw invalid('A cell of the workbook is too long.');
      }
      text += value;
    });
    parser.on('closetag', (tag) => {
      switch (localName(tag.name)) {
        case 'v':
          inValue = false;
          break;
        case 'is':
          inInline = false;
          break;
        case 'rPh':
          inPhonetic = false;
          break;
        case 'c':
          finishCell();
          break;
        case 'row':
          if (cells.some((value) => value !== null && value !== '')) {
            ready.push({ line: rowLine, cells });
          }
          cells = [];
          break;
        default:
          break;
      }
    });

    const steps = feedXml(stream, parser);
    try {
      for (let step = await steps.next(); step.done !== true; step = await steps.next()) {
        while (ready.length > 0) yield ready.shift() as SheetRow;
      }
    } finally {
      stream.destroy();
    }
  }

  private async readWorkbook(): Promise<{ sheets: XlsxSheet[]; date1904: boolean }> {
    const relationships = new Map<string, string>();
    const rels = await this.open('xl/_rels/workbook.xml.rels');
    if (rels !== undefined) {
      const parser = newParser();
      parser.on('opentag', (tag) => {
        if (localName(tag.name) !== 'Relationship') return;
        const id = attribute(tag, 'Id');
        const target = attribute(tag, 'Target');
        if (id !== undefined && target !== undefined) relationships.set(id, target);
      });
      await parseAll(rels, parser);
    }
    const workbook = await this.open('xl/workbook.xml');
    if (workbook === undefined) throw invalid('The file is not a valid XLSX workbook.');
    const sheets: XlsxSheet[] = [];
    let date1904 = false;
    const parser = newParser();
    parser.on('opentag', (tag) => {
      const name = localName(tag.name);
      if (name === 'workbookPr') {
        const flag = attribute(tag, 'date1904');
        date1904 = flag === '1' || flag === 'true';
      } else if (name === 'sheet') {
        const sheetName = attribute(tag, 'name');
        const relation = attribute(tag, 'id');
        const target = relation === undefined ? undefined : relationships.get(relation);
        if (sheetName === undefined || target === undefined) return;
        const path = resolvePartPath(target);
        if (path !== undefined && this.entries.has(path)) {
          sheets.push({ name: sheetName.normalize('NFC'), path });
        }
      }
    });
    await parseAll(workbook, parser);
    if (sheets.length === 0) throw invalid('The workbook has no sheet.');
    return { sheets, date1904 };
  }

  private async loadSharedStrings(): Promise<string[]> {
    if (this.sharedStrings !== undefined) return this.sharedStrings;
    const strings: string[] = [];
    const stream = await this.open('xl/sharedStrings.xml');
    if (stream !== undefined) {
      const parser = newParser();
      let current = '';
      let inItem = false;
      let inText = false;
      let inPhonetic = false;
      let chars = 0;
      const { maxSharedStrings, maxSharedStringChars } = this.limits;
      parser.on('opentag', (tag) => {
        const name = localName(tag.name);
        if (name === 'si') {
          inItem = true;
          current = '';
        } else if (name === 't') inText = true;
        else if (name === 'rPh') inPhonetic = true;
      });
      parser.on('text', (value) => {
        if (!inItem || !inText || inPhonetic) return;
        chars += value.length;
        if (chars > maxSharedStringChars || current.length + value.length > IMPORT_MAX_CELL_CHARS) {
          throw limitError('The shared strings of the workbook are too large.', {
            limit: maxSharedStringChars,
          });
        }
        current += value;
      });
      parser.on('closetag', (tag) => {
        const name = localName(tag.name);
        if (name === 'si') {
          inItem = false;
          if (strings.length >= maxSharedStrings) {
            throw limitError('The workbook has too many shared strings.', {
              limit: maxSharedStrings,
            });
          }
          strings.push(current.normalize('NFC'));
        } else if (name === 't') inText = false;
        else if (name === 'rPh') inPhonetic = false;
      });
      await parseAll(stream, parser);
    }
    this.sharedStrings = strings;
    return strings;
  }

  private async loadStyles(): Promise<Styles> {
    if (this.styles !== undefined) return this.styles;
    const custom = new Map<number, NumberFormatKind>();
    const formats: number[] = [];
    const stream = await this.open('xl/styles.xml');
    if (stream !== undefined) {
      const parser = newParser();
      let inCellXfs = false;
      let depth = 0;
      parser.on('opentag', (tag) => {
        const name = localName(tag.name);
        if (name === 'numFmt') {
          const id = Number.parseInt(attribute(tag, 'numFmtId') ?? '', 10);
          const code = attribute(tag, 'formatCode');
          if (Number.isSafeInteger(id) && code !== undefined)
            custom.set(id, numberFormatKind(code));
        } else if (name === 'cellXfs') {
          inCellXfs = true;
          depth = 0;
        } else if (inCellXfs) {
          depth += 1;
          if (name === 'xf' && depth === 1) {
            formats.push(Number.parseInt(attribute(tag, 'numFmtId') ?? '0', 10) || 0);
          }
        }
      });
      parser.on('closetag', (tag) => {
        if (localName(tag.name) === 'cellXfs') inCellXfs = false;
        else if (inCellXfs) depth -= 1;
      });
      await parseAll(stream, parser);
    }
    const kinds = formats.map((id): NumberFormatKind => {
      const own = custom.get(id);
      if (own !== undefined) return own;
      if (BUILTIN_TIME_FORMATS.has(id)) return 'datetime';
      return BUILTIN_DATE_FORMATS.has(id) ? 'date' : 'number';
    });
    this.styles = { kinds };
    return this.styles;
  }

  /** An inflating stream of an archive part, or `undefined` when missing. */
  private async open(path: string): Promise<Readable | undefined> {
    const entry = this.entries.get(path);
    if (entry === undefined) return undefined;
    let stream: Readable;
    try {
      stream = await this.zip.openReadStreamPromise(entry);
    } catch {
      throw invalid('The file is not a valid XLSX workbook.');
    }
    const counted = stream.pipe(byteCounter(entry.uncompressedSize));
    stream.on('error', (error: unknown) => {
      counted.destroy(
        error instanceof AppError
          ? error
          : limitError('An entry of the workbook does not match its declared size.'),
      );
    });
    return counted;
  }
}

/** `worksheets/sheet1.xml` or `/xl/worksheets/sheet1.xml` → `xl/worksheets/sheet1.xml`. */
export function resolvePartPath(target: string): string | undefined {
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.pop() === undefined) return undefined;
      continue;
    }
    parts.push(part);
  }
  const resolved = parts.join('/');
  return /^[A-Za-z0-9_./-]+$/.test(resolved) ? resolved : undefined;
}
