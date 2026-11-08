import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  basePackageLimits,
  openBasePackage,
  packageBaseSchema,
  packageRecordSchema,
  type BasePackageLimits,
} from '../../src/base-package/index.js';
import { AppError } from '../../src/errors/app-error.js';

import {
  ATT_ID,
  buildZip,
  FIELD_ID,
  manifestFor,
  packageOf,
  scratch,
  TABLE_ID,
  validEntries,
  type BuildOptions,
  type RawEntry,
} from './zip-builder.js';

/**
 * The reader against untrusted packages (BACKLOG T1016, threat model of
 * the S9 research §2.8): every poisoned package is built here, byte by
 * byte, and must end as `422 INVALID_PACKAGE` with the right detail code —
 * never another error, never an uncaught one (vitest fails the run on an
 * uncaught exception or rejection).
 */

let dir: Awaited<ReturnType<typeof scratch>>;
let counter = 0;

beforeAll(async () => {
  dir = await scratch();
});

afterAll(async () => {
  await dir.cleanup();
});

/** Opens the package and reads every entry of it, as the first pass of an import does. */
async function readAll(bytes: Buffer, limits?: BasePackageLimits): Promise<void> {
  counter += 1;
  const path = await dir.file(`package-${String(counter)}.chbase`, bytes);
  const reader = await openBasePackage(path, limits === undefined ? {} : { limits });
  try {
    await reader.verifyAll();
    if (reader.has('schema/base.json'))
      await reader.readJson('schema/base.json', packageBaseSchema);
    for (const entry of reader.entries()) {
      if (entry.kind.kind === 'data') {
        const lines = reader.readNdjson(entry.name, packageRecordSchema);
        for (let next = await lines.next(); next.done !== true; next = await lines.next()) {
          expect(next.value.line).toBeGreaterThan(0);
        }
      }
    }
  } finally {
    reader.close();
  }
}

interface Problem {
  readonly code: string;
  readonly path: string;
  readonly params?: Record<string, unknown>;
}

async function problemOf(bytes: Buffer, limits?: BasePackageLimits): Promise<Problem> {
  try {
    await readAll(bytes, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe('INVALID_PACKAGE');
    expect(appError.status).toBe(422);
    const [first] = appError.errors ?? [];
    expect(first).toBeDefined();
    return first as Problem;
  }
  throw new Error('The package was accepted');
}

function withPackage(
  patch: (entries: (RawEntry & { name: string })[]) => (RawEntry & { name: string })[],
  options: BuildOptions & { manifest?: Record<string, unknown> } = {},
): Buffer {
  return packageOf(patch(validEntries()), options);
}

describe('a valid package', () => {
  it('opens, verifies and reads', async () => {
    await expect(readAll(withPackage((entries) => entries))).resolves.toBeUndefined();
  });
});

describe('poisoned packages (T1016)', () => {
  const unsafeNames = [
    ['zip slip: parent directory', '../escape.json'],
    ['zip slip: absolute path', '/etc/passwd'],
    ['zip slip: drive letter', 'C:/Windows/win.ini'],
    ['zip slip: backslash', 'files\\..\\..\\escape'],
  ] as const;

  it.each(unsafeNames)('%s → UNSAFE_ENTRY, never reported by name', async (_name, entry) => {
    const problem = await problemOf(
      withPackage((entries) => [...entries, { name: entry, data: Buffer.from('x') }]),
    );
    expect(problem.code).toBe('UNSAFE_ENTRY');
    expect(problem.path).toMatch(/^entries\[\d+\]$/u);
  });

  it('symlink → UNSAFE_ENTRY', async () => {
    const problem = await problemOf(
      withPackage((entries) => [
        ...entries,
        {
          name: 'files/att_symlink00000000a',
          data: Buffer.from('/etc/passwd'),
          externalAttributes: (0o120777 << 16) >>> 0,
        },
      ]),
    );
    expect(problem.code).toBe('UNSAFE_ENTRY');
  });

  it.each([
    ['a name ending in /', { name: 'schema/', data: Buffer.alloc(0), method: 0 }],
    [
      'a Unix directory mode',
      {
        name: 'files/att_directory0000000',
        data: Buffer.alloc(0),
        method: 0,
        externalAttributes: (0o040755 << 16) >>> 0,
      },
    ],
    [
      'an MS-DOS directory attribute',
      {
        name: 'files/att_directory0000001',
        data: Buffer.alloc(0),
        method: 0,
        versionMadeBy: 0x0014,
        externalAttributes: 0x10,
      },
    ],
  ] as const)('directory (%s) → UNSAFE_ENTRY', async (_name, entry) => {
    const problem = await problemOf(withPackage((entries) => [...entries, entry]));
    expect(problem.code).toBe('UNSAFE_ENTRY');
  });

  it('two names equal once NFC-normalized → DUPLICATE_ENTRY', async () => {
    const problem = await problemOf(
      withPackage((entries) => [
        ...entries,
        { name: 'files/caf\u00e9', data: Buffer.from('a') },
        { name: 'files/cafe\u0301', data: Buffer.from('b') },
      ]),
    );
    expect(problem.code).toBe('DUPLICATE_ENTRY');
    expect(problem.path).toMatch(/^entries\[\d+\]$/u);
  });

  it('the same name twice → DUPLICATE_ENTRY', async () => {
    const problem = await problemOf(
      withPackage((entries) => [...entries, { name: `files/${ATT_ID}`, data: Buffer.from('b') }]),
    );
    expect(problem.code).toBe('DUPLICATE_ENTRY');
  });

  it('an entry outside the allowlist → UNKNOWN_ENTRY', async () => {
    const problem = await problemOf(
      withPackage((entries) => [...entries, { name: 'notes.txt', data: Buffer.from('hi') }]),
    );
    expect(problem).toMatchObject({ code: 'UNKNOWN_ENTRY', path: 'notes.txt' });
  });

  it('an allowed entry the manifest does not list → UNKNOWN_ENTRY', async () => {
    const entries = validEntries();
    const extra = { name: 'schema/roles.json', data: Buffer.from('{"roles":[]}') };
    const bytes = buildZip([
      ...entries,
      extra,
      { name: 'manifest.json', data: manifestFor(entries) },
    ]);
    expect(await problemOf(bytes)).toMatchObject({
      code: 'UNKNOWN_ENTRY',
      path: 'schema/roles.json',
    });
  });

  it('100 001 entries → ARCHIVE_LIMIT_EXCEEDED (entries), before any entry is read', async () => {
    const entries: RawEntry[] = [];
    for (let index = 0; index < 100_001; index += 1) {
      entries.push({ name: `x/${String(index)}`, data: Buffer.alloc(0), method: 0 });
    }
    const problem = await problemOf(buildZip(entries));
    expect(problem).toMatchObject({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      params: { reason: 'entries', limit: 100_000 },
    });
  });

  it('an end record claiming 2^53 entries → ARCHIVE_LIMIT_EXCEEDED (entries)', async () => {
    const problem = await problemOf(
      buildZip([{ name: 'manifest.json', data: Buffer.from('{}') }], {
        zip64: true,
        entryCount: 2 ** 53,
      }),
    );
    expect(problem).toMatchObject({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      params: { reason: 'entries' },
    });
  });

  it('a file compressed past 20× → ARCHIVE_LIMIT_EXCEEDED (entry_ratio 20)', async () => {
    const bomb = Buffer.alloc(10 * 1024 * 1024);
    const problem = await problemOf(
      withPackage((entries) => [...entries, { name: 'files/att_bomb000000000000', data: bomb }]),
    );
    expect(problem).toMatchObject({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      path: 'files/att_bomb000000000000',
      params: { reason: 'entry_ratio', limit: 20 },
    });
  });

  it('a JSON entry compressed past 20× → ARCHIVE_LIMIT_EXCEEDED (entry_ratio 20)', async () => {
    const base = Buffer.from(
      JSON.stringify({
        name: 'Sales',
        description: 'x'.repeat(200_000),
        icon: null,
        settings: {},
        missing_ids: [],
      }),
    );
    expect(base.length / deflateRawSync(base).length).toBeGreaterThan(20);
    const problem = await problemOf(
      withPackage((entries) =>
        entries.map((entry) =>
          entry.name === 'schema/base.json' ? { ...entry, data: base } : entry,
        ),
      ),
    );
    expect(problem).toMatchObject({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      path: 'schema/base.json',
      params: { reason: 'entry_ratio', limit: 20 },
    });
  });

  /** `count` record lines of the same long text (ids differ), as a repetitive base exports. */
  function repeatedRecords(count: number, text: string): Buffer {
    const lines: string[] = [];
    for (let index = 0; index < count; index += 1) {
      lines.push(
        JSON.stringify({
          id: `rec_${String(index).padStart(16, '0')}`,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          created_by_email: 'an@example.com',
          updated_by_email: 'an@example.com',
          auto: index + 1,
          fields: { [FIELD_ID]: text },
        }),
      );
    }
    return Buffer.from(`${lines.join('\n')}\n`);
  }

  const withData = (data: Buffer) =>
    withPackage((entries) =>
      entries.map((entry) =>
        entry.name === `data/${TABLE_ID}.ndjson` ? { ...entry, data } : entry,
      ),
    );

  it('an NDJSON entry compressed past 200× → ARCHIVE_LIMIT_EXCEEDED (entry_ratio 200)', async () => {
    const data = repeatedRecords(400, 'x'.repeat(50_000));
    expect(data.length / deflateRawSync(data).length).toBeGreaterThan(200);
    const problem = await problemOf(withData(data));
    expect(problem).toMatchObject({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      path: `data/${TABLE_ID}.ndjson`,
      params: { reason: 'entry_ratio', limit: 200 },
    });
  });

  it('an NDJSON entry compressed about 60× (a base of repeated text) is read', async () => {
    const data = repeatedRecords(
      4_000,
      'Đơn hàng giao trong ngày, khách đã thanh toán đủ'.repeat(4),
    );
    const ratio = data.length / deflateRawSync(data).length;
    expect(ratio).toBeGreaterThan(40);
    expect(ratio).toBeLessThan(200);
    await expect(readAll(withData(data))).resolves.toBeUndefined();
  });

  it('all entries together past 4 × BASE_PACKAGE_MAX_BYTES → ARCHIVE_LIMIT_EXCEEDED (uncompressed_bytes)', async () => {
    // A cap of 10 MiB × 0.001: about 10 KiB in all, whatever the package's own size.
    const limits = basePackageLimits(10 * 1024 * 1024, { maxUncompressedFactor: 0.001 });
    const problem = await problemOf(
      withPackage((entries) => [
        ...entries,
        { name: 'files/att_large00000000000', data: randomBytes(20_000), method: 0 },
      ]),
      limits,
    );
    expect(problem).toMatchObject({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      params: { reason: 'uncompressed_bytes', limit: 10 * 1024 * 1024 * 0.001 },
    });
  });

  it('an entry inflating past its declared size → ARCHIVE_LIMIT_EXCEEDED, not read on', async () => {
    const entries = validEntries();
    const big = Buffer.from('{"x":1}'.repeat(200));
    const name = `files/${ATT_ID}`;
    const lying: (RawEntry & { name: string })[] = entries.map((entry) =>
      entry.name === name ? { name, data: big, uncompressedSize: 16 } : entry,
    );
    // The manifest describes what the package claims: the real content.
    const bytes = buildZip([
      ...lying,
      {
        name: 'manifest.json',
        data: manifestFor(
          entries.map((entry) => (entry.name === name ? { name, data: big } : entry)),
        ),
      },
    ]);
    const problem = await problemOf(bytes);
    expect(problem).toMatchObject({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      path: name,
      params: { reason: 'uncompressed_bytes', limit: 16 },
    });
  });

  it('an entry inflating short of its declared size → INVALID_ARCHIVE', async () => {
    const name = `files/${ATT_ID}`;
    const problem = await problemOf(
      withPackage((entries) =>
        entries.map((entry) =>
          entry.name === name ? { ...entry, uncompressedSize: entry.data.length + 5 } : entry,
        ),
      ),
    );
    expect(problem).toMatchObject({ code: 'INVALID_ARCHIVE', path: name });
  });

  it('a stored entry whose sizes disagree → INVALID_ARCHIVE', async () => {
    const problem = await problemOf(
      withPackage((entries) => [
        ...entries,
        {
          name: 'files/att_stored0000000000',
          data: Buffer.from('abc'),
          method: 0,
          uncompressedSize: 9,
        },
      ]),
    );
    expect(problem.code).toBe('INVALID_ARCHIVE');
  });

  it('a wrong CRC-32 → INVALID_ARCHIVE', async () => {
    const name = `files/${ATT_ID}`;
    const problem = await problemOf(
      withPackage((entries) =>
        entries.map((entry) => (entry.name === name ? { ...entry, crc32: 0x12345678 } : entry)),
      ),
    );
    expect(problem).toMatchObject({ code: 'INVALID_ARCHIVE', path: name });
  });

  it.each([
    ['traditional encryption', 0x1 | 0x800],
    ['strong encryption', 0x41 | 0x800],
  ])('an encrypted entry (%s) → UNSAFE_ENTRY', async (_name, flags) => {
    const problem = await problemOf(
      withPackage((entries) => [
        ...entries,
        { name: 'files/att_encrypted00000000', data: Buffer.from('secret'), flags },
      ]),
    );
    expect(problem.code).toBe('UNSAFE_ENTRY');
  });

  it('compression method 12 (bzip2) → UNSAFE_ENTRY', async () => {
    const problem = await problemOf(
      withPackage((entries) => [
        ...entries,
        { name: 'files/att_bzip200000000000', data: Buffer.from('BZh9'), method: 12 },
      ]),
    );
    expect(problem.code).toBe('UNSAFE_ENTRY');
  });

  it('a nested zip in a JSON entry is not opened → INVALID_ENTRY', async () => {
    const inner = buildZip([{ name: 'inner.json', data: Buffer.from('{}') }]);
    const problem = await problemOf(
      withPackage((entries) =>
        entries.map((entry) =>
          entry.name === 'schema/base.json' ? { name: entry.name, data: inner } : entry,
        ),
      ),
    );
    expect(problem).toMatchObject({ code: 'INVALID_ENTRY', path: 'schema/base.json' });
  });

  it('a nested zip bomb as a file is opaque bytes, never inflated', async () => {
    const innerBomb = buildZip([{ name: 'zeros', data: Buffer.alloc(8 * 1024 * 1024) }]);
    const name = 'files/att_nestedzip0000000';
    const entries = [...validEntries(), { name, data: innerBomb, method: 0 }];
    counter += 1;
    const path = await dir.file(`nested-${String(counter)}.chbase`, packageOf(entries));
    const reader = await openBasePackage(path);
    try {
      await reader.verifyAll();
      const chunks: Buffer[] = [];
      for await (const chunk of (await reader.open(name)) as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      expect(Buffer.concat(chunks).equals(innerBomb)).toBe(true);
      expect(innerBomb.length).toBeLessThan(64 * 1024);
    } finally {
      reader.close();
    }
  });

  it('a corrupt central directory → INVALID_ARCHIVE', async () => {
    const bytes = withPackage((entries) => entries);
    const directory = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(0xdeadbeef, directory);
    expect((await problemOf(bytes)).code).toBe('INVALID_ARCHIVE');
  });

  it.each([
    ['a central directory offset past the end', { centralDirectoryOffset: 0x7fffffff }],
    ['a ZIP64 record offset of 2^63', { zip64: true, zip64RecordOffset: 2n ** 63n }],
    ['a ZIP64 record offset of 2^64 − 1', { zip64: true, zip64RecordOffset: 2n ** 64n - 1n }],
  ] as const)('forged offsets (%s) fail the read, never the process', async (_name, options) => {
    const problem = await problemOf(withPackage((entries) => entries, options));
    expect(problem.code).toBe('INVALID_ARCHIVE');
  });

  it('a local header offset past the end → INVALID_ARCHIVE', async () => {
    const name = `files/${ATT_ID}`;
    const problem = await problemOf(
      withPackage((entries) =>
        entries.map((entry) =>
          entry.name === name ? { ...entry, localHeaderOffset: 0xfffffff0 } : entry,
        ),
      ),
    );
    expect(problem.code).toBe('INVALID_ARCHIVE');
  });

  it('two entries sharing their data → INVALID_ARCHIVE', async () => {
    const problem = await problemOf(
      withPackage((entries) => [
        ...entries,
        {
          name: 'files/att_overlap000000000',
          data: Buffer.from('file content'),
          localHeaderOffset: 0,
        },
      ]),
    );
    expect(problem.code).toBe('INVALID_ARCHIVE');
  });

  it.each([0.5, 0.9, 0.99])('a package truncated at %s → INVALID_ARCHIVE', async (share) => {
    const bytes = withPackage((entries) => entries);
    const problem = await problemOf(bytes.subarray(0, Math.floor(bytes.length * share)));
    expect(problem.code).toBe('INVALID_ARCHIVE');
  });

  it.each([
    ['an empty file', Buffer.alloc(0)],
    ['random bytes', Buffer.from('this is not a zip file at all, just text')],
  ])('%s → INVALID_ARCHIVE', async (_name, bytes) => {
    expect((await problemOf(bytes)).code).toBe('INVALID_ARCHIVE');
  });
});

describe('the manifest', () => {
  it('missing → MISSING_ENTRY', async () => {
    const problem = await problemOf(buildZip(validEntries()));
    expect(problem).toMatchObject({ code: 'MISSING_ENTRY', path: 'manifest.json' });
  });

  it.each([
    ['format_version 2', { format_version: 2 }],
    ['another format', { format: 'airtable-base' }],
  ])('%s → UNSUPPORTED_FORMAT_VERSION', async (_name, manifest) => {
    const problem = await problemOf(withPackage((entries) => entries, { manifest }));
    expect(problem.code).toBe('UNSUPPORTED_FORMAT_VERSION');
  });

  it('a modified entry → CHECKSUM_MISMATCH', async () => {
    const entries = validEntries();
    const name = `data/${TABLE_ID}.ndjson`;
    const manifest = manifestFor(entries);
    const tampered = entries.map((entry) =>
      entry.name === name
        ? { name, data: Buffer.from(entry.data.toString().replace('hello', 'HELLO')) }
        : entry,
    );
    const bytes = buildZip([...tampered, { name: 'manifest.json', data: manifest }]);
    expect(await problemOf(bytes)).toMatchObject({ code: 'CHECKSUM_MISMATCH', path: name });
  });

  it('a listed entry the package lacks → MISSING_ENTRY', async () => {
    const entries = validEntries();
    const bytes = buildZip([
      ...entries.slice(1),
      { name: 'manifest.json', data: manifestFor(entries) },
    ]);
    expect(await problemOf(bytes)).toMatchObject({
      code: 'MISSING_ENTRY',
      path: 'manifest.json#/checksums/schema~1base.json',
    });
  });

  it('an unknown key → INVALID_ENTRY with its pointer', async () => {
    const problem = await problemOf(withPackage((entries) => entries, { manifest: { extra: 1 } }));
    expect(problem).toMatchObject({ code: 'INVALID_ENTRY', path: 'manifest.json#/extra' });
  });
});

describe('JSON and NDJSON caps', () => {
  const base = (text: string) =>
    withPackage((entries) =>
      entries.map((entry) =>
        entry.name === 'schema/base.json' ? { name: entry.name, data: Buffer.from(text) } : entry,
      ),
    );

  it('nesting deeper than 64 → ARCHIVE_LIMIT_EXCEEDED (json_depth)', async () => {
    const deep = `{"name":"x","description":null,"icon":null,"missing_ids":[],"settings":${'['.repeat(70)}${']'.repeat(70)}}`;
    expect(await problemOf(base(deep))).toMatchObject({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      path: 'schema/base.json',
      params: { reason: 'json_depth', limit: 64 },
    });
  });

  it('brackets inside strings do not count as nesting', async () => {
    const text = JSON.stringify({
      name: '['.repeat(500),
      description: null,
      icon: null,
      settings: { note: '{"a":'.repeat(100) },
      missing_ids: [],
    });
    await expect(readAll(base(text))).resolves.toBeUndefined();
  });

  it('a "__proto__" key → INVALID_ENTRY', async () => {
    const text =
      '{"name":"x","description":null,"icon":null,"missing_ids":[],"settings":{"\\u005f_proto__":{"admin":true}}}';
    expect(await problemOf(base(text))).toMatchObject({
      code: 'INVALID_ENTRY',
      path: 'schema/base.json',
    });
  });

  it('not UTF-8 → INVALID_ENTRY', async () => {
    const problem = await problemOf(
      withPackage((entries) =>
        entries.map((entry) =>
          entry.name === 'schema/base.json'
            ? { name: entry.name, data: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) }
            : entry,
        ),
      ),
    );
    expect(problem.code).toBe('INVALID_ENTRY');
  });

  it('a JSON entry over the cap → ARCHIVE_LIMIT_EXCEEDED (json_entry_bytes) at open', async () => {
    const limits = basePackageLimits(undefined, { maxJsonEntryBytes: 64 });
    expect(
      await problemOf(
        withPackage((entries) => entries),
        limits,
      ),
    ).toMatchObject({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      params: { reason: 'json_entry_bytes', limit: 64 },
    });
  });

  it('an NDJSON line over the cap → ARCHIVE_LIMIT_EXCEEDED (ndjson_line_bytes)', async () => {
    const limits = basePackageLimits(undefined, { maxNdjsonLineBytes: 32 });
    expect(
      await problemOf(
        withPackage((entries) => entries),
        limits,
      ),
    ).toMatchObject({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      path: `data/${TABLE_ID}.ndjson:1`,
      params: { reason: 'ndjson_line_bytes', limit: 32 },
    });
  });

  it('a package over BASE_PACKAGE_MAX_BYTES → ARCHIVE_LIMIT_EXCEEDED (package_bytes)', async () => {
    const limits = basePackageLimits(100);
    expect(
      await problemOf(
        withPackage((entries) => entries),
        limits,
      ),
    ).toMatchObject({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
      params: { reason: 'package_bytes', limit: 100 },
    });
  });

  it('a line that is not a record → INVALID_ENTRY with the line and pointer', async () => {
    const name = `data/${TABLE_ID}.ndjson`;
    const line = JSON.stringify({ id: 'rec_0123456789abcdef', fields: {}, extra: true });
    const problem = await problemOf(
      withPackage((entries) =>
        entries.map((entry) =>
          entry.name === name ? { name, data: Buffer.from(`${line}\n`) } : entry,
        ),
      ),
    );
    expect(problem.code).toBe('INVALID_ENTRY');
    expect(problem.path.startsWith(`${name}:1#/`)).toBe(true);
  });

  it('a blank line → INVALID_ENTRY', async () => {
    const name = `data/${TABLE_ID}.ndjson`;
    const problem = await problemOf(
      withPackage((entries) =>
        entries.map((entry) =>
          entry.name === name
            ? { name, data: Buffer.concat([entry.data, Buffer.from('\n')]) }
            : entry,
        ),
      ),
    );
    expect(problem).toMatchObject({ code: 'INVALID_ENTRY', path: `${name}:2` });
  });

  it('reads lines split across inflated chunks, last newline optional', async () => {
    const name = `data/${TABLE_ID}.ndjson`;
    const record = (index: number) =>
      JSON.stringify({
        id: `rec_${String(index).padStart(16, '0')}`,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        created_by_email: null,
        updated_by_email: null,
        auto: index + 1,
        fields: { fld_0123456789abcdef: randomBytes(index % 97).toString('base64') },
      });
    const lines = Array.from({ length: 5000 }, (_value, index) => record(index));
    const data = Buffer.from(lines.join('\n'));
    const entries = validEntries().map((entry) => (entry.name === name ? { name, data } : entry));
    counter += 1;
    const path = await dir.file(`lines-${String(counter)}.chbase`, packageOf(entries));
    const reader = await openBasePackage(path);
    try {
      let count = 0;
      for await (const { line, value } of reader.readNdjson(name, packageRecordSchema)) {
        count += 1;
        expect(line).toBe(count);
        expect(value.auto).toBe(count);
      }
      expect(count).toBe(5000);
    } finally {
      reader.close();
    }
  });
});

describe('reading', () => {
  it('a raw deflate stream that is not deflate → INVALID_ARCHIVE', async () => {
    const name = `files/${ATT_ID}`;
    const problem = await problemOf(
      withPackage((entries) =>
        entries.map((entry) =>
          entry.name === name
            ? { ...entry, rawData: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) }
            : entry,
        ),
      ),
    );
    expect(problem).toMatchObject({ code: 'INVALID_ARCHIVE', path: name });
  });

  it('closing twice and reading after close fail cleanly', async () => {
    counter += 1;
    const path = await dir.file(
      `close-${String(counter)}.chbase`,
      withPackage((entries) => entries),
    );
    const reader = await openBasePackage(path);
    reader.close();
    reader.close();
    await expect(reader.open(`files/${ATT_ID}`)).rejects.toMatchObject({ code: 'INVALID_PACKAGE' });
  });

  it('an entry the package does not have → MISSING_ENTRY', async () => {
    counter += 1;
    const path = await dir.file(
      `missing-${String(counter)}.chbase`,
      withPackage((entries) => entries),
    );
    const reader = await openBasePackage(path);
    try {
      await expect(reader.readJson('schema/roles.json', packageBaseSchema)).rejects.toMatchObject({
        code: 'INVALID_PACKAGE',
        errors: [{ code: 'MISSING_ENTRY', path: 'schema/roles.json' }],
      });
    } finally {
      reader.close();
    }
  });

  it('stored and deflated entries alike', async () => {
    const data = deflateRawSync(Buffer.from('x'));
    expect(data.length).toBeGreaterThan(0);
    await expect(
      readAll(
        withPackage((entries) =>
          entries.map((entry) =>
            entry.name.startsWith('files/') ? { ...entry, method: 0 } : entry,
          ),
        ),
      ),
    ).resolves.toBeUndefined();
  });
});
