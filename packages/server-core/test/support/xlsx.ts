import { constants, crc32, deflateRawSync } from 'node:zlib';

/** One file of a test zip archive. */
export interface ZipEntryInput {
  readonly name: string;
  readonly data: Buffer | string | DeflatedData;
  /** Uncompressed size written in the headers (default: the real one); lie to test limits. */
  readonly declaredSize?: number;
}

/** Entry data already compressed (raw deflate), with its real size and CRC-32. */
export interface DeflatedData {
  readonly deflated: Buffer;
  readonly size: number;
  readonly crc: number;
}

/**
 * `head + chunk × times + tail`, compressed without inflating it in memory
 * or deflating every copy: `chunk` is deflated once, full-flushed (a fresh
 * dictionary, so the blocks stand alone), and its blocks repeated. A 200 MB
 * zip bomb then costs milliseconds to build instead of seconds of CPU that
 * timed out on a loaded machine (T319).
 */
export function deflatedRepeat(
  head: Buffer,
  chunk: Buffer,
  times: number,
  tail: Buffer,
): DeflatedData {
  const full = { finishFlush: constants.Z_FULL_FLUSH };
  const blocks = deflateRawSync(chunk, full);
  let crc = crc32(head);
  for (let index = 0; index < times; index += 1) crc = crc32(chunk, crc);
  crc = crc32(tail, crc);
  return {
    deflated: Buffer.concat([
      deflateRawSync(head, full),
      ...Array.from({ length: times }, () => blocks),
      deflateRawSync(tail),
    ]),
    size: head.length + chunk.length * times + tail.length,
    crc,
  };
}

function entryData(data: ZipEntryInput['data']): DeflatedData {
  if (typeof data === 'object' && 'deflated' in data) return data;
  const raw = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return { deflated: deflateRawSync(raw), size: raw.length, crc: crc32(raw) };
}

/**
 * A minimal zip writer for tests (deflate, no zip64, no data descriptors),
 * enough for `yauzl` and spreadsheet readers.
 */
export function buildZip(entries: readonly ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const { deflated: compressed, size: realSize, crc } = entryData(entry.data);
    const name = Buffer.from(entry.name, 'utf8');
    const size = entry.declaredSize ?? realSize;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}

/** A cell of a test sheet. */
export type XlsxTestCell =
  | string
  | number
  | boolean
  | null
  | { readonly date: number }
  | { readonly datetime: number }
  | { readonly inline: string }
  | { readonly formula: string; readonly value: string };

export interface XlsxTestSheet {
  readonly name: string;
  readonly rows: readonly (readonly XlsxTestCell[])[];
}

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/**
 * An XLSX workbook as Excel writes it: shared strings for text, style 1 =
 * built-in date format 14, style 2 = custom `dd/mm/yyyy hh:mm`, booleans
 * `t="b"`, inline strings and string formulas.
 */
export function sheetXml(rows: readonly (readonly XlsxTestCell[])[], strings: string[]): string {
  const index = new Map(strings.map((value, position) => [value, position]));
  const shared = (value: string) => {
    let position = index.get(value);
    if (position === undefined) {
      position = strings.length;
      strings.push(value);
      index.set(value, position);
    }
    return position;
  };
  const body = rows
    .map((cells, r) => {
      const xml = cells
        .map((cell, c) => {
          const ref = `${columnName(c)}${String(r + 1)}`;
          if (cell === null) return '';
          if (typeof cell === 'string')
            return `<c r="${ref}" t="s"><v>${String(shared(cell))}</v></c>`;
          if (typeof cell === 'number') return `<c r="${ref}"><v>${String(cell)}</v></c>`;
          if (typeof cell === 'boolean')
            return `<c r="${ref}" t="b"><v>${cell ? '1' : '0'}</v></c>`;
          if ('date' in cell) return `<c r="${ref}" s="1"><v>${String(cell.date)}</v></c>`;
          if ('datetime' in cell) return `<c r="${ref}" s="2"><v>${String(cell.datetime)}</v></c>`;
          if ('inline' in cell) {
            return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell.inline)}</t></is></c>`;
          }
          return `<c r="${ref}" t="str"><f>${escapeXml(cell.formula)}</f><v>${escapeXml(cell.value)}</v></c>`;
        })
        .join('');
      return `<row r="${String(r + 1)}">${xml}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

export function buildXlsx(
  sheets: readonly XlsxTestSheet[],
  options: { readonly date1904?: boolean; readonly extra?: readonly ZipEntryInput[] } = {},
): Buffer {
  const strings: string[] = [];
  const sheetParts = sheets.map((sheet) => sheetXml(sheet.rows, strings));
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<workbookPr${options.date1904 === true ? ' date1904="1"' : ''}/><sheets>` +
    sheets
      .map(
        (sheet, i) =>
          `<sheet name="${escapeXml(sheet.name)}" sheetId="${String(i + 1)}" r:id="rId${String(i + 1)}"/>`,
      )
      .join('') +
    '</sheets></workbook>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${String(i + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(i + 1)}.xml"/>`,
      )
      .join('') +
    '</Relationships>';
  const shared =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${String(strings.length)}">` +
    strings.map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join('') +
    '</sst>';
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm"/></numFmts>' +
    '<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>' +
    '<cellXfs count="3"><xf numFmtId="0" xfId="0"/><xf numFmtId="14" xfId="0"/>' +
    '<xf numFmtId="164" xfId="0"/></cellXfs></styleSheet>';
  return buildZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/sharedStrings.xml', data: shared },
    { name: 'xl/styles.xml', data: styles },
    ...sheetParts.map((data, i) => ({ name: `xl/worksheets/sheet${String(i + 1)}.xml`, data })),
    ...(options.extra ?? []),
  ]);
}
