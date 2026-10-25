import { IMPORT_DELIMITERS, IMPORT_MAX_CELL_CHARS, IMPORT_MAX_COLUMNS } from '@cellhive/contracts';

import { importFileError } from './file-errors.js';

import type { ImportDelimiter } from '@cellhive/contracts';

const QUOTE = '"';

/** Parser states. */
const State = {
  /** At the start of a cell. */
  CellStart: 0,
  /** Inside an unquoted cell. */
  Unquoted: 1,
  /** Inside a quoted cell. */
  Quoted: 2,
  /** Just after a quote inside a quoted cell: `""` or the closing quote. */
  QuoteInQuoted: 3,
} as const;
type State = (typeof State)[keyof typeof State];

export interface CsvParserOptions {
  readonly delimiter: ImportDelimiter;
  /** Longest cell in characters (default `IMPORT_MAX_CELL_CHARS`). */
  readonly maxCellChars?: number;
  /** Most cells in one record (default `IMPORT_MAX_COLUMNS`). */
  readonly maxColumns?: number;
}

/**
 * Streaming RFC 4180 parser: text arrives in chunks of any size (`push`),
 * complete records come out through the callback, and `end` flushes the
 * last record. Accepts `\n`, `\r\n` and `\r` line ends, quoted cells with
 * `""` escapes and line breaks, and is lenient like spreadsheet apps: a
 * quote inside an unquoted cell, or text after a closing quote, is kept as
 * text. Cells are normalised to NFC. A cell longer than `maxCellChars` or a
 * record with more than `maxColumns` cells is `422 INVALID_FILE` (bounded
 * memory for any input).
 */
export class CsvParser {
  private readonly delimiter: string;
  private readonly maxCellChars: number;
  private readonly maxColumns: number;
  private state: State = State.CellStart;
  private cell = '';
  private cells: string[] = [];
  /** A `\r` ended the last chunk: skip a `\n` at the start of the next one. */
  private skipLineFeed = false;
  /** Whether the current record has any character (an empty line has none). */
  private recordStarted = false;

  constructor(options: CsvParserOptions) {
    this.delimiter = options.delimiter;
    this.maxCellChars = options.maxCellChars ?? IMPORT_MAX_CELL_CHARS;
    this.maxColumns = options.maxColumns ?? IMPORT_MAX_COLUMNS;
  }

  /** Parses `text`; calls `onRecord` for every record it completes. */
  push(text: string, onRecord: (cells: string[]) => void): void {
    const length = text.length;
    let index = 0;
    if (this.skipLineFeed && length > 0) {
      this.skipLineFeed = false;
      if (text.charCodeAt(0) === 10) index = 1;
    }
    while (index < length) {
      switch (this.state) {
        case State.CellStart:
        case State.Unquoted: {
          if (this.state === State.CellStart && text[index] === QUOTE) {
            this.state = State.Quoted;
            this.recordStarted = true;
            index += 1;
            break;
          }
          // Copy the run of ordinary characters in one slice.
          let end = index;
          while (end < length) {
            const char = text[end];
            if (char === this.delimiter || char === '\n' || char === '\r') break;
            end += 1;
          }
          if (end > index) {
            this.append(text.slice(index, end));
            this.recordStarted = true;
            this.state = State.Unquoted;
          }
          if (end >= length) {
            index = end;
            break;
          }
          index = this.separator(text, end, onRecord);
          break;
        }
        case State.Quoted: {
          const quote = text.indexOf(QUOTE, index);
          if (quote === -1) {
            this.append(text.slice(index));
            index = length;
            break;
          }
          this.append(text.slice(index, quote));
          this.state = State.QuoteInQuoted;
          index = quote + 1;
          break;
        }
        case State.QuoteInQuoted: {
          const char = text[index];
          if (char === QUOTE) {
            this.append(QUOTE);
            this.state = State.Quoted;
            index += 1;
          } else if (char === this.delimiter || char === '\n' || char === '\r') {
            index = this.separator(text, index, onRecord);
          } else {
            // Text after the closing quote: keep it (lenient).
            this.state = State.Unquoted;
          }
          break;
        }
      }
    }
  }

  /** Ends the input: flushes the last record (a file need not end with a line break). */
  end(onRecord: (cells: string[]) => void): void {
    if (this.recordStarted || this.cells.length > 0) this.endRecord(onRecord);
    this.state = State.CellStart;
    this.skipLineFeed = false;
  }

  /** Handles the delimiter or line break at `index`; returns the next index. */
  private separator(text: string, index: number, onRecord: (cells: string[]) => void): number {
    const char = text[index];
    if (char === this.delimiter) {
      this.endCell();
      this.recordStarted = true;
      return index + 1;
    }
    this.endRecord(onRecord);
    if (char === '\r') {
      if (index + 1 >= text.length) {
        this.skipLineFeed = true;
        return index + 1;
      }
      if (text.charCodeAt(index + 1) === 10) return index + 2;
    }
    return index + 1;
  }

  private append(part: string): void {
    if (this.cell.length + part.length > this.maxCellChars) {
      throw importFileError('INVALID_FILE', 'A cell of the file is too long.', {
        limit: this.maxCellChars,
      });
    }
    this.cell += part;
  }

  private endCell(): void {
    if (this.cells.length >= this.maxColumns) {
      throw importFileError('INVALID_FILE', 'A row of the file has too many columns.', {
        limit: this.maxColumns,
      });
    }
    this.cells.push(this.cell.normalize('NFC'));
    this.cell = '';
    this.state = State.CellStart;
  }

  private endRecord(onRecord: (cells: string[]) => void): void {
    const empty = !this.recordStarted && this.cells.length === 0;
    this.endCell();
    const cells = this.cells;
    this.cells = [];
    this.recordStarted = false;
    // An empty line is still a record: callers count lines, then skip it.
    onRecord(empty ? [] : cells);
  }
}

/** Parses a whole string (tests, samples). */
export function parseCsv(text: string, delimiter: ImportDelimiter): string[][] {
  const parser = new CsvParser({ delimiter });
  const records: string[][] = [];
  const collect = (cells: string[]) => {
    records.push(cells);
  };
  parser.push(text, collect);
  parser.end(collect);
  return records;
}

/**
 * Picks the delimiter of a CSV sample (the start of the file): for each
 * candidate the sample's records (at most 50, the last possibly cut one
 * dropped) are parsed; the winner splits the most records into the same
 * number (> 1) of cells. Ties keep the order `,` `;` tab `|`; a sample that
 * no candidate splits is `,`.
 */
export function detectDelimiter(sample: string): ImportDelimiter {
  const cut = Math.max(sample.lastIndexOf('\n'), sample.lastIndexOf('\r'));
  const text = cut > 0 ? sample.slice(0, cut) : sample;
  let best: { delimiter: ImportDelimiter; score: number } = { delimiter: ',', score: 0 };
  for (const delimiter of IMPORT_DELIMITERS) {
    let records: string[][];
    try {
      records = parseCsv(text, delimiter)
        .filter((cells) => cells.length > 0)
        .slice(0, 50);
    } catch {
      continue;
    }
    const counts = new Map<number, number>();
    for (const cells of records) counts.set(cells.length, (counts.get(cells.length) ?? 0) + 1);
    let score = 0;
    for (const [width, count] of counts) {
      if (width > 1) score = Math.max(score, count * 1000 + width);
    }
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}
