import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  checkUploadedObject,
  contentContradictsType,
  INLINE_TYPES,
  isNativeExecutable,
} from '../../../src/records/attachments/index.js';

import type { StoredObjectInfo } from '../../../src/storage/index.js';

const bytes = (...values: (number | string)[]): Uint8Array =>
  Uint8Array.from(
    values.flatMap((value) =>
      typeof value === 'string' ? Array.from(Buffer.from(value, 'latin1')) : [value],
    ),
  );

const PNG = bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'IHDR');
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, 'JFIF');
const GIF = bytes('GIF89a', 1, 0, 1, 0);
const WEBP = bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 ');
const PDF = bytes('%PDF-1.7\n');
const ZIP = bytes('PK', 3, 4, 20, 0);
const EXE = bytes('MZ', 0x90, 0, 3, 0, 0, 0);
const ELF = bytes(0x7f, 'ELF', 2, 1, 1);
const MACHO = bytes(0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1);
const TEXT = bytes('Xin chào, Cellhive!\n');
const MP4 = bytes(0, 0, 0, 0x18, 'ftypmp42');
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f);
const MP3 = bytes('ID3', 4, 0, 0);
const ADTS = bytes(0xff, 0xf1, 0x50, 0x80);

describe('contentContradictsType', () => {
  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/webp', WEBP],
    ['application/pdf', PDF],
    ['application/zip', ZIP],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP],
    ['video/mp4', MP4],
    ['video/webm', WEBM],
    ['audio/mpeg', MP3],
    ['audio/mpeg', ADTS],
    ['audio/aac', ADTS],
    ['text/plain', TEXT],
    ['text/csv', TEXT],
    ['image/svg+xml', bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['application/octet-stream', bytes(0, 1, 2, 3)],
    ['text/plain', bytes()],
  ])('accepts %s', (mime, head) => {
    expect(contentContradictsType(mime, head)).toBe(false);
  });

  it.each([
    ['image/png', EXE, 'a Windows executable renamed .png'],
    ['image/png', JPEG, 'a JPEG declared as PNG'],
    ['image/jpeg', TEXT, 'text declared as JPEG'],
    ['application/pdf', ZIP, 'a zip declared as PDF'],
    ['image/png', bytes(), 'an empty file declared as PNG'],
    ['image/png', bytes(0x89, 'PN'), 'a truncated signature'],
    ['video/mp4', WEBM, 'a WebM declared as MP4'],
    ['audio/mpeg', TEXT, 'text declared as MP3'],
  ])('refuses %s: %s', (mime, head) => {
    expect(contentContradictsType(mime, head)).toBe(true);
  });

  it('recognizes native executables (blocked while `exe` is in blocked_extensions)', () => {
    for (const head of [EXE, ELF, MACHO]) expect(isNativeExecutable(head)).toBe(true);
    for (const head of [PNG, PDF, ZIP, TEXT, bytes()]) expect(isNativeExecutable(head)).toBe(false);
  });

  it('serves inline only raster images, audio and video (never SVG/HTML)', () => {
    for (const mime of INLINE_TYPES) {
      expect(
        mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/'),
      ).toBe(true);
      // Every inline type has a signature checked at `complete`.
      expect(contentContradictsType(mime, TEXT)).toBe(true);
    }
    expect(INLINE_TYPES.has('image/svg+xml')).toBe(false);
    expect(INLINE_TYPES.has('text/html')).toBe(false);
    expect(INLINE_TYPES.has('video/mp4')).toBe(true);
  });
});

function fakeStorage(body: Uint8Array | null, reportedSize?: number) {
  return {
    move: () => Promise.resolve(false),
    delete: () => Promise.resolve(),
    head: (): Promise<StoredObjectInfo | null> =>
      Promise.resolve(
        body === null
          ? null
          : {
              size: reportedSize ?? body.length,
              contentType: null,
              etag: null,
              lastModified: null,
            },
      ),
    getStream: () =>
      Promise.resolve(
        body === null
          ? null
          : // Several small chunks: the sniffed head spans chunk boundaries.
            Readable.from(
              Array.from({ length: Math.ceil(body.length / 3) }, (_, index) =>
                Buffer.from(body.subarray(index * 3, index * 3 + 3)),
              ),
            ),
      ),
  };
}

describe('checkUploadedObject', () => {
  it('accepts native binaries when the field does not block executables', async () => {
    const result = await checkUploadedObject(fakeStorage(EXE), 'org_x/att_y', {
      size: EXE.length,
      mime: 'application/octet-stream',
      blockNativeExecutables: false,
    });
    expect(result.ok).toBe(true);
  });

  it('returns size and SHA-256 of a valid file', async () => {
    const result = await checkUploadedObject(fakeStorage(PNG), 'org_x/att_y', {
      size: PNG.length,
      mime: 'image/png',
      blockNativeExecutables: true,
    });
    expect(result).toEqual({
      ok: true,
      size: PNG.length,
      sha256: (await import('node:crypto')).createHash('sha256').update(PNG).digest('hex'),
    });
  });

  it.each([
    [fakeStorage(null), 10, 'image/png', 'UPLOAD_INCOMPLETE'],
    [fakeStorage(PNG), PNG.length + 1, 'image/png', 'SIZE_MISMATCH'],
    [fakeStorage(PNG, PNG.length), PNG.length, 'image/png', 'ok'],
    [fakeStorage(PNG, 5), 5, 'image/png', 'SIZE_MISMATCH'],
    [fakeStorage(JPEG), JPEG.length, 'image/png', 'CONTENT_MISMATCH'],
    [fakeStorage(EXE), EXE.length, 'image/png', 'BLOCKED_FILE_TYPE'],
    [fakeStorage(ELF), ELF.length, 'application/octet-stream', 'BLOCKED_FILE_TYPE'],
  ])('%#: %s bytes as %s -> %s', async (storage, size, mime, expected) => {
    const result = await checkUploadedObject(storage, 'org_x/att_y', {
      size,
      mime,
      blockNativeExecutables: true,
    });
    expect(result.ok ? 'ok' : result.reason).toBe(expected);
  });
});
