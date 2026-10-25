import { describe, expect, it } from 'vitest';

import {
  attachmentFieldType,
  attachmentIdsOf,
  attachmentOptionsSchema,
  FieldValueError,
  fileExtensionOf,
  isBlockedFileType,
  mimeAccepted,
  normalizeMimeType,
  type AttachmentRef,
} from '../src/index.js';

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
const A = 'att_AAAAAAAAAAAAAAA1';
const B = 'att_BBBBBBBBBBBBBBB2';

const files: Record<string, AttachmentRef> = {
  [A]: { id: A, name: 'hợp đồng.pdf', size: 1024, mime: 'application/pdf' },
  [B]: { id: B, name: 'ảnh.png', size: 2048, mime: 'image/png' },
};
const ctx = { resolveAttachment: (id: string) => files[id] };

const defaults = attachmentOptionsSchema.parse({});
const two = attachmentOptionsSchema.parse({ max_files: 2 });
const one = attachmentOptionsSchema.parse({ max_files: 1 });

describe('attachment options', () => {
  it('defaults: any type but executables, 100 files (BACKLOG S4 decision #6)', () => {
    expect(defaults).toEqual({
      accept: null,
      max_files: 100,
      blocked_extensions: [
        'exe',
        'msi',
        'bat',
        'cmd',
        'sh',
        'ps1',
        'app',
        'dmg',
        'jar',
        'com',
        'scr',
      ],
    });
  });

  it('lets admins edit the blocked extensions (lower case, no dot, no duplicates)', () => {
    expect(
      attachmentOptionsSchema.parse({ blocked_extensions: ['.EXE', 'js', 'js'] })
        .blocked_extensions,
    ).toEqual(['exe', 'js']);
    expect(attachmentOptionsSchema.parse({ blocked_extensions: [] }).blocked_extensions).toEqual(
      [],
    );
  });

  it('normalizes accept to lower case without duplicates', () => {
    expect(
      attachmentOptionsSchema.parse({ accept: ['Image/*', 'application/PDF', 'image/*'] }).accept,
    ).toEqual(['image/*', 'application/pdf']);
  });

  it.each([
    [{ accept: ['pdf'] }],
    [{ accept: ['*/*'] }],
    [{ accept: ['image/png; q=1'] }],
    [{ max_files: 0 }],
    [{ max_files: 101 }],
    [{ max_files: 1.5 }],
    [{ other: true }],
    [{ blocked_extensions: ['e x e'] }],
    [{ blocked_extensions: ['a'.repeat(17)] }],
    [{ blocked_extensions: null }],
  ])('rejects %j', (input) => {
    expect(attachmentOptionsSchema.safeParse(input).success).toBe(false);
  });
});

describe('MIME helpers', () => {
  it.each([
    ['image/PNG', 'image/png'],
    ['text/plain; charset=utf-8', 'text/plain'],
    [' application/pdf ', 'application/pdf'],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    ['pdf', null],
    ['', null],
    ['image/', null],
    ['a/b/c', null],
  ])('normalizeMimeType(%j) -> %j', (input, expected) => {
    expect(normalizeMimeType(input)).toBe(expected);
  });

  it.each([
    ['image/png', null, true],
    ['image/png', [], true],
    ['image/png', ['image/*'], true],
    ['image/png', ['image/png'], true],
    ['image/svg+xml', ['image/png', 'image/jpeg'], false],
    ['application/pdf', ['image/*'], false],
    ['imagex/png', ['image/*'], false],
  ] as const)('mimeAccepted(%s, %j) -> %s', (mime, accept, expected) => {
    expect(mimeAccepted(mime, accept)).toBe(expected);
  });
});

describe('blocked file types', () => {
  const blocked = defaults.blocked_extensions;

  it.each([
    ['setup.exe', 'application/octet-stream', true],
    ['SETUP.EXE', 'application/octet-stream', true],
    ['setup.exe. ', 'application/octet-stream', true],
    ['run.sh', 'text/plain', true],
    ['script.PS1', 'text/plain', true],
    ['lib.jar', 'application/zip', true],
    ['app.dmg', 'application/octet-stream', true],
    ['x.scr', 'image/png', true],
    ['cmd.com', 'text/plain', true],
    ['photo.png', 'application/x-msdownload', true],
    ['photo.png', 'application/java-archive', true],
    ['notes.txt', 'text/x-shellscript', true],
    ['report.pdf', 'application/pdf', false],
    ['exe', 'text/plain', false],
    ['archive.sh.zip', 'application/zip', false],
    ['movie.mp4', 'video/mp4', false],
  ])('isBlockedFileType(%j, %s) -> %s', (name, mime, expected) => {
    expect(isBlockedFileType(name, mime, blocked)).toBe(expected);
  });

  it('extracts extensions', () => {
    expect(fileExtensionOf('a.tar.GZ')).toBe('gz');
    expect(fileExtensionOf('README')).toBe('');
    expect(fileExtensionOf('.env')).toBe('env');
  });

  it('blocks nothing with an empty list, only the listed types otherwise', () => {
    expect(isBlockedFileType('setup.exe', 'application/x-msdownload', [])).toBe(false);
    expect(isBlockedFileType('run.sh', 'text/x-shellscript', ['exe'])).toBe(false);
    expect(isBlockedFileType('page.html', 'text/html', ['html'])).toBe(true);
  });

  it('extracts extensions', () => {
    expect(fileExtensionOf('a.tar.GZ')).toBe('gz');
    expect(fileExtensionOf('README')).toBe('');
    expect(fileExtensionOf('.env')).toBe('env');
    expect(fileExtensionOf('setup.exe . .')).toBe('exe');
  });
});

describe('attachment validate / typecast', () => {
  it.each([
    [defaults, null],
    [defaults, []],
    [defaults, [{ id: A }]],
    [defaults, [{ id: A, name: 'ignored', url: 'ignored' }]],
    [two, [{ id: A }, { id: B }]],
    [one, [{ id: A }, { id: A }]],
  ])('accepts %j / %j', (options, value) => {
    expect(attachmentFieldType.validate(value, options)).toEqual({ ok: true });
  });

  it.each([
    [defaults, 'x', 'EXPECTED_ARRAY'],
    [defaults, [A], 'EXPECTED_ATTACHMENT'],
    [defaults, [{ id: 'att_bad' }], 'EXPECTED_ATTACHMENT'],
    [defaults, [{ id: 'usr_AAAAAAAAAAAAAAA1' }], 'EXPECTED_ATTACHMENT'],
    [defaults, [{}], 'EXPECTED_ATTACHMENT'],
    [one, [{ id: A }, { id: B }], 'TOO_MANY_VALUES'],
  ])('rejects %j / %j with %s', (options, value, code) => {
    const result = attachmentFieldType.validate(value, options);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]?.code).toBe(code);
  });

  it('reports the limit of max_files', () => {
    const result = attachmentFieldType.validate([{ id: A }, { id: B }], one);
    expect(!result.ok && result.issues[0]?.params).toEqual({ max: 1 });
  });

  it.each([
    [null, null],
    ['', null],
    [A, [{ id: A }]],
    [`${A}, ${B}`, [{ id: A }, { id: B }]],
    [
      [A, { id: B }],
      [{ id: A }, { id: B }],
    ],
    [{ id: A }, [{ id: A }]],
  ])('typecast %j -> %j', (input, expected) => {
    expect(attachmentFieldType.typecast(input, defaults, vi)).toEqual({
      ok: true,
      value: expected,
      unknownOptions: [],
    });
  });

  it('typecast rejects numbers', () => {
    expect(attachmentFieldType.typecast(42, defaults, vi).ok).toBe(false);
  });
});

describe('attachment storage', () => {
  it('stores { id, name, size, mime } from the resolver, without duplicates', () => {
    expect(
      attachmentFieldType.toStorage(
        [{ id: B }, { id: A, name: 'forged.exe' }, { id: B }],
        defaults,
        ctx,
      ),
    ).toEqual([files[B], files[A]]);
  });

  it('stores an empty list as null', () => {
    expect(attachmentFieldType.toStorage([], defaults, ctx)).toBeNull();
    expect(attachmentFieldType.toStorage(null, defaults)).toBeNull();
  });

  it('refuses ids the resolver does not know (ATTACHMENT_NOT_FOUND)', () => {
    const run = () =>
      attachmentFieldType.toStorage([{ id: 'att_CCCCCCCCCCCCCCC3' }], defaults, ctx);
    expect(run).toThrow(FieldValueError);
    try {
      run();
    } catch (error) {
      expect((error as FieldValueError).issues[0]).toMatchObject({
        code: 'ATTACHMENT_NOT_FOUND',
        params: { id: 'att_CCCCCCCCCCCCCCC3' },
      });
    }
    expect(() => attachmentFieldType.toStorage([{ id: A }], defaults)).toThrow(FieldValueError);
  });

  it('reads the cache with url and thumbnail_url (CONTRACTS §2)', () => {
    expect(attachmentFieldType.fromStorage([files[A], { bad: true }], defaults)).toEqual([
      { ...files[A], url: `/api/v1/files/${A}`, thumbnail_url: null },
    ]);
    // Raster images up to 50 MB get a thumbnail endpoint (T407).
    expect(attachmentFieldType.fromStorage([files[B]], defaults)).toEqual([
      { ...files[B], url: `/api/v1/files/${B}`, thumbnail_url: `/api/v1/files/${B}/thumbnail` },
    ]);
    const huge = { ...files[B], size: 60 * 1024 * 1024 };
    expect(attachmentFieldType.fromStorage([huge], defaults)?.[0]?.thumbnail_url).toBeNull();
    const svg = { ...files[B], mime: 'image/svg+xml' };
    expect(attachmentFieldType.fromStorage([svg], defaults)?.[0]?.thumbnail_url).toBeNull();
    expect(attachmentFieldType.fromStorage([], defaults)).toBeNull();
    expect(attachmentFieldType.fromStorage('x', defaults)).toBeNull();
  });

  it('formats names separated by commas', () => {
    const value = attachmentFieldType.fromStorage([files[A], files[B]], defaults);
    expect(attachmentFieldType.formatText(value, defaults, vi)).toBe('hợp đồng.pdf, ảnh.png');
    expect(attachmentFieldType.formatText(null, defaults, vi)).toBe('');
  });

  it('is a jsonb column filtered by emptiness only', () => {
    expect(attachmentFieldType.pgType(defaults, { collation: 'und-x-icu' })).toBe('jsonb');
    expect(attachmentFieldType.filterOperators(defaults)).toEqual(['is_empty', 'is_not_empty']);
  });

  it('attachmentIdsOf lists ids once, in order', () => {
    expect(attachmentIdsOf([{ id: B }, { id: A }, { id: B }, 'x', null])).toEqual([B, A]);
    expect(attachmentIdsOf(null)).toEqual([]);
  });
});
