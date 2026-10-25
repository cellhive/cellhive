import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Test files for the import E2E (T318): a Windows-1258 encoder for the
 * Vietnamese letters (Node has no such encoder, only decoders) and a
 * minimal XLSX writer (inline strings and numbers, one sheet).
 */

/** Precomposed letters of Windows-1258 that carry a vowel modifier (or đ). */
const CP1258_LETTERS: Readonly<Record<string, number>> = {
  Â: 0xc2,
  Ă: 0xc3,
  Ê: 0xca,
  Ô: 0xd4,
  Ơ: 0xd5,
  Ư: 0xdd,
  Đ: 0xd0,
  â: 0xe2,
  ă: 0xe3,
  ê: 0xea,
  ô: 0xf4,
  ơ: 0xf5,
  ư: 0xfd,
  đ: 0xf0,
};

/** Tone marks, written as combining characters after the letter. */
const CP1258_TONES: Readonly<Record<string, number>> = {
  '\u0300': 0xcc, // grave
  '\u0301': 0xec, // acute
  '\u0303': 0xde, // tilde
  '\u0309': 0xd2, // hook above
  '\u0323': 0xf2, // dot below
};

/** Circumflex, breve and horn stay with their letter (precomposed in 1258). */
const MODIFIERS = new Set(['\u0302', '\u0306', '\u031b']);

/** Vietnamese text as Windows-1258 bytes, tones as combining marks (as Windows writes them). */
export function encodeCp1258(text: string): Buffer {
  const bytes: number[] = [];
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const [base = '', ...marks] = Array.from(char.normalize('NFD'));
    const letter = (base + marks.filter((mark) => MODIFIERS.has(mark)).join('')).normalize('NFC');
    const letterCode = letter.codePointAt(0) ?? 0;
    if (letter.length === 1 && letterCode < 0x80) bytes.push(letterCode);
    else if (CP1258_LETTERS[letter] !== undefined) bytes.push(CP1258_LETTERS[letter]);
    else throw new Error(`No Windows-1258 byte for ${letter}`);
    for (const mark of marks) {
      if (MODIFIERS.has(mark)) continue;
      const tone = CP1258_TONES[mark];
      if (tone === undefined)
        throw new Error(`No Windows-1258 tone for U+${mark.codePointAt(0)?.toString(16) ?? ''}`);
      bytes.push(tone);
    }
  }
  return Buffer.from(bytes);
}

interface ZipEntry {
  readonly name: string;
  readonly data: string;
}

/** A minimal zip archive (deflate, no zip64). */
function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data, 'utf8');
    const compressed = deflateRawSync(data);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const escapeXml = (text: string) =>
  text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');

function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/** A one-sheet XLSX workbook: strings inline, numbers as numbers. */
export function buildXlsx(
  sheet: string,
  rows: readonly (readonly (string | number | null)[])[],
): Buffer {
  const body = rows
    .map((cells, r) => {
      const xml = cells
        .map((cell, c) => {
          const ref = `${columnName(c)}${String(r + 1)}`;
          if (cell === null) return '';
          if (typeof cell === 'number') return `<c r="${ref}"><v>${String(cell)}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`;
        })
        .join('');
      return `<row r="${String(r + 1)}">${xml}</row>`;
    })
    .join('');
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return buildZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    {
      name: 'xl/workbook.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${main}" xmlns:r="${relationships}">` +
        `<sheets><sheet name="${escapeXml(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${relationships}/worksheet" Target="worksheets/sheet1.xml"/>` +
        '</Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${main}"><sheetData>${body}</sheetData></worksheet>`,
    },
  ]);
}
