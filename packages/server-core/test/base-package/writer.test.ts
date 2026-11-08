import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';

import {
  ATTACHMENTS_ENTRY,
  basePackageLimits,
  BasePackageWriter,
  dataEntry,
  fileEntry,
  isAlreadyCompressed,
  linksEntry,
  openBasePackage,
  packageAttachmentsSchema,
  packageBaseSchema,
  packageLinkSchema,
  packageRecordSchema,
  packageTablesSchema,
  SCHEMA_ENTRIES,
  type BasePackageManifestInput,
} from '../../src/base-package/index.js';
import { AppError } from '../../src/errors/app-error.js';

import { scratch, ZERO_COUNTS } from './zip-builder.js';

/** Writer → reader, without a database (BACKLOG T1016). */

let dir: Awaited<ReturnType<typeof scratch>>;
let counter = 0;

beforeAll(async () => {
  dir = await scratch();
});

afterAll(async () => {
  await dir.cleanup();
});

const nextPath = () => {
  counter += 1;
  return dir.path(`written-${String(counter)}.chbase`);
};

const id = <P extends string>(prefix: P, label: string): `${P}_${string}` =>
  `${prefix}_${label.padEnd(16, '0')}`;
const TABLE = id('tbl', 'RoundTrip');
const FIELD = id('fld', 'RoundTrip');
const LINK = id('fld', 'RoundTripLink');
const PHOTO = id('att', 'RoundTripPhoto');
const NOTE = id('att', 'RoundTripNote');

const MANIFEST: BasePackageManifestInput = {
  app_version: '0.1.0',
  exported_at: '2026-11-08T10:00:00.000Z',
  exported_by_email: 'owner@example.com',
  base: { id: id('bse', 'RoundTrip'), name: 'Sales' },
  counts: { ...ZERO_COUNTS, tables: 1, fields: 1, records: 1000, links: 3, attachments: 2 },
  skipped: { personal_views: 2 },
};

function record(index: number) {
  return {
    id: `rec_${String(index).padStart(16, '0')}`,
    created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-01-02T03:04:05.000Z',
    created_by_email: index % 3 === 0 ? null : 'an@example.com',
    updated_by_email: null,
    auto: index + 1,
    fields: { [FIELD]: randomBytes(12).toString('hex') },
  };
}

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function* rows(count: number) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
    yield record(index);
  }
}

async function centralDirectory(path: string) {
  const zip = await yauzl.openPromise(path);
  const entries: { name: string; method: number; compressed: number; size: number }[] = [];
  for await (const entry of zip.eachEntry()) {
    entries.push({
      name: entry.fileName,
      method: entry.compressionMethod,
      compressed: entry.compressedSize,
      size: entry.uncompressedSize,
    });
  }
  zip.close();
  return entries;
}

describe('BasePackageWriter → openBasePackage', () => {
  it('round-trips every kind of entry, checksums computed while writing', async () => {
    const path = nextPath();
    const photo = randomBytes(40_000);
    const note = Buffer.from('plain text note, compressible '.repeat(200));
    const records = Array.from({ length: 1000 }, (_value, index) => record(index));
    const base = { name: 'Sales', description: null, icon: null, settings: {}, missing_ids: [] };
    const tables = { tables: [] };
    const files = {
      files: [
        {
          id: PHOTO,
          kind: 'cell',
          filename: 'photo.jpg',
          mime: 'image/jpeg',
          size: photo.length,
          sha256: sha(photo),
          table_id: TABLE,
          field_id: FIELD,
          record_id: 'rec_0000000000000001',
        },
        {
          id: NOTE,
          kind: 'cell',
          filename: 'note.txt',
          mime: 'text/plain',
          size: note.length,
          sha256: sha(note),
          table_id: TABLE,
          field_id: FIELD,
          record_id: 'rec_0000000000000002',
        },
      ],
    };
    const links = [
      { a: 'rec_0000000000000001', b: 'rec_0000000000000002', position: 0 },
      { a: 'rec_0000000000000001', b: 'rec_0000000000000003', position: 1 },
      { a: 'rec_0000000000000004', b: 'rec_0000000000000002', position: 0 },
    ];

    const writer = await BasePackageWriter.create(path, {
      mtime: new Date('2026-11-08T10:00:00Z'),
    });
    await writer.addJson(SCHEMA_ENTRIES.base, base);
    await writer.addJson(SCHEMA_ENTRIES.tables, tables);
    const data = await writer.addNdjson(dataEntry(TABLE), rows(1000));
    expect(data.lines).toBe(1000);
    const junction = await writer.addNdjson(linksEntry(LINK), links);
    expect(junction.lines).toBe(3);
    await writer.addJson(ATTACHMENTS_ENTRY, files);
    const photoEntry = await writer.addFile(fileEntry(PHOTO), Readable.from([photo]), {
      compress: !isAlreadyCompressed('image/jpeg'),
      size: photo.length,
    });
    expect(photoEntry).toMatchObject({ sha256: sha(photo), size: photo.length });
    await writer.addFile(
      fileEntry(NOTE),
      Readable.from([note.subarray(0, 100), note.subarray(100)]),
      {
        compress: !isAlreadyCompressed('text/plain'),
      },
    );
    const finished = await writer.finish(MANIFEST);

    const bytes = await readFile(path);
    expect(finished.bytes).toBe(bytes.length);
    expect(Object.keys(finished.checksums).sort()).toEqual(
      [
        SCHEMA_ENTRIES.base,
        SCHEMA_ENTRIES.tables,
        dataEntry(TABLE),
        linksEntry(LINK),
        ATTACHMENTS_ENTRY,
        fileEntry(PHOTO),
        fileEntry(NOTE),
      ].sort(),
    );

    // Manifest last; JPEG stored as is, text deflated.
    const listing = await centralDirectory(path);
    expect(listing.at(-1)?.name).toBe('manifest.json');
    const stored = listing.find((entry) => entry.name === fileEntry(PHOTO));
    expect(stored).toMatchObject({ method: 0, compressed: photo.length, size: photo.length });
    const deflated = listing.find((entry) => entry.name === fileEntry(NOTE));
    expect(deflated?.method).toBe(8);
    expect(deflated?.compressed).toBeLessThan(note.length / 5);

    const reader = await openBasePackage(path);
    try {
      expect(reader.manifest).toMatchObject({
        format: 'cellhive-base',
        format_version: 1,
        ...MANIFEST,
        checksums: finished.checksums,
      });
      await reader.verifyAll();
      expect(await reader.readJson(SCHEMA_ENTRIES.base, packageBaseSchema)).toEqual(base);
      expect(await reader.readJson(SCHEMA_ENTRIES.tables, packageTablesSchema)).toEqual(tables);
      expect(await reader.readAttachments()).toEqual(packageAttachmentsSchema.parse(files));
      const read: unknown[] = [];
      for await (const { value } of reader.readNdjson(dataEntry(TABLE), packageRecordSchema)) {
        read.push(value);
      }
      expect(read).toHaveLength(1000);
      expect(read.slice(0, 3)).toEqual(
        records.slice(0, 3).map((item, index) => ({
          ...item,
          fields: (read[index] as { fields: unknown }).fields,
        })),
      );
      const readLinks: unknown[] = [];
      for await (const { value } of reader.readNdjson(linksEntry(LINK), packageLinkSchema)) {
        readLinks.push(value);
      }
      expect(readLinks).toEqual(links);
      const chunks: Buffer[] = [];
      for await (const chunk of (await reader.open(fileEntry(PHOTO))) as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      expect(Buffer.concat(chunks).equals(photo)).toBe(true);
    } finally {
      reader.close();
    }
  });

  it('writes the same bytes for the same input (fixed mtime)', async () => {
    const write = async () => {
      const path = nextPath();
      const writer = await BasePackageWriter.create(path, {
        mtime: new Date('2026-11-08T10:00:00Z'),
      });
      await writer.addJson(SCHEMA_ENTRIES.base, {
        name: 'x',
        description: null,
        icon: null,
        settings: {},
        missing_ids: [],
      });
      await writer.addNdjson(dataEntry(TABLE), [{ a: 1 }, { b: 2 }]);
      await writer.finish(MANIFEST);
      return readFile(path);
    };
    const [first, second] = await Promise.all([write(), write()]);
    expect(first.equals(second)).toBe(true);
  });

  it('fails with PACKAGE_TOO_LARGE past BASE_PACKAGE_MAX_BYTES', async () => {
    const path = nextPath();
    const writer = await BasePackageWriter.create(path, { limits: basePackageLimits(1024 * 1024) });
    const error = await writer
      .addFile(fileEntry(PHOTO), Readable.from([randomBytes(2 * 1024 * 1024)]), { compress: false })
      .then(() => writer.finish(MANIFEST))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ code: 'PACKAGE_TOO_LARGE', params: { limit: 1024 * 1024 } }],
    });
    await expect(writer.addJson(SCHEMA_ENTRIES.base, {})).rejects.toBe(error);
  });

  it('refuses an NDJSON line, a JSON entry or nesting over the caps', async () => {
    const limits = basePackageLimits(undefined, {
      maxNdjsonLineBytes: 20,
      maxJsonEntryBytes: 30,
      maxJsonDepth: 3,
    });
    const line = await BasePackageWriter.create(nextPath(), { limits });
    await expect(
      line.addNdjson(dataEntry(TABLE), [{ ok: 1 }, { long: 'x'.repeat(40) }]),
    ).rejects.toMatchObject({
      errors: [
        {
          code: 'ARCHIVE_LIMIT_EXCEEDED',
          path: `${dataEntry(TABLE)}:2`,
          params: { reason: 'ndjson_line_bytes' },
        },
      ],
    });
    line.abort();
    const json = await BasePackageWriter.create(nextPath(), { limits });
    await expect(json.addJson(SCHEMA_ENTRIES.base, { text: 'y'.repeat(40) })).rejects.toMatchObject(
      {
        errors: [{ params: { reason: 'json_entry_bytes' } }],
      },
    );
    await expect(
      json.addJson(SCHEMA_ENTRIES.roles, { a: { b: { c: { d: 1 } } } }),
    ).rejects.toMatchObject({
      errors: [{ params: { reason: 'json_depth', limit: 3 } }],
    });
    json.abort();
  });

  it('refuses a package compressing past the ratio the reader allows', async () => {
    const writer = await BasePackageWriter.create(nextPath(), {
      limits: basePackageLimits(undefined, { maxCompressionRatio: 2 }),
    });
    await writer.addNdjson(
      dataEntry(TABLE),
      Array.from({ length: 2000 }, () => ({ same: 'row' })),
    );
    await expect(writer.finish(MANIFEST)).rejects.toMatchObject({
      code: 'INVALID_PACKAGE',
      errors: [{ code: 'ARCHIVE_LIMIT_EXCEEDED', params: { reason: 'uncompressed_bytes' } }],
    });
  });

  it('refuses more entries than a package may hold', async () => {
    const writer = await BasePackageWriter.create(nextPath(), {
      limits: basePackageLimits(undefined, { maxEntries: 2 }),
    });
    await writer.addJson(SCHEMA_ENTRIES.base, {});
    await expect(writer.addJson(SCHEMA_ENTRIES.tables, {})).rejects.toMatchObject({
      errors: [{ code: 'ARCHIVE_LIMIT_EXCEEDED', params: { reason: 'entries', limit: 2 } }],
    });
    writer.abort();
  });

  it('refuses names outside the allowlist, kinds in the wrong method, twice the same entry', async () => {
    const writer = await BasePackageWriter.create(nextPath());
    await expect(writer.addJson('notes.json', {})).rejects.toThrow(/Not a JSON entry/u);
    await expect(writer.addJson('manifest.json', {})).rejects.toThrow(/Not a JSON entry/u);
    await expect(writer.addNdjson(SCHEMA_ENTRIES.base, [])).rejects.toThrow(/Not an NDJSON entry/u);
    await expect(
      writer.addFile(dataEntry(TABLE), Readable.from([]), { compress: true }),
    ).rejects.toThrow(/Not a file entry/u);
    await writer.addJson(SCHEMA_ENTRIES.base, {});
    await expect(writer.addJson(SCHEMA_ENTRIES.base, {})).rejects.toThrow(/written twice/u);
    writer.abort();
  });

  it('fails when a file is not the size its metadata says, or its source fails', async () => {
    const sized = await BasePackageWriter.create(nextPath());
    await expect(
      sized.addFile(fileEntry(PHOTO), Readable.from([Buffer.from('abc')]), {
        compress: true,
        size: 4,
      }),
    ).rejects.toThrow(/size differs/u);
    const broken = await BasePackageWriter.create(nextPath());
    const source = new Readable({
      read() {
        this.destroy(new Error('storage went away'));
      },
    });
    await expect(broken.addFile(fileEntry(PHOTO), source, { compress: true })).rejects.toThrow(
      /storage went away/u,
    );
  });

  it('never overwrites an existing file', async () => {
    const path = nextPath();
    await writeFile(path, 'keep me');
    await expect(BasePackageWriter.create(path)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe('keep me');
  });
});

describe('isAlreadyCompressed', () => {
  it.each([
    ['image/jpeg', true],
    ['image/png', true],
    ['IMAGE/WEBP; charset=x', true],
    ['application/pdf', true],
    ['application/zip', true],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', true],
    ['video/mp4', true],
    ['audio/mpeg', true],
    ['audio/wav', false],
    ['text/plain', false],
    ['image/svg+xml', false],
    ['application/json', false],
    ['image/bmp', false],
  ])('%s → %s', (mime, expected) => {
    expect(isAlreadyCompressed(mime)).toBe(expected);
  });
});
