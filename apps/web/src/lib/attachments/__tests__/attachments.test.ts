import {
  ATTACHMENT_DEFAULT_BLOCKED_EXTENSIONS,
  DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
} from '@cellhive/contracts';
import { attachmentOptionsSchema } from '@cellhive/field-types';
import { describe, expect, it } from 'vitest';

import { acceptLabels, checkFile, checkFiles, inputAccept, mimeOfFile } from '../checks';
import { formatBytes, formatProgress } from '../format';
import {
  badgeLabel,
  fileKindOf,
  imageSourceOf,
  isPreviewImage,
  kindColorIndex,
  largeThumbnailOf,
  previewModeOf,
} from '../kinds';
import { cellFilesOf, displayValueOf, moveFile, writeValueOf } from '../value';

const options = (input: Record<string, unknown> = {}) => attachmentOptionsSchema.parse(input);
const file = (name: string, type: string, size = 1000) => ({ name, type, size });

describe('file kinds (board S4 badges)', () => {
  it.each([
    ['anh.jpg', 'image/jpeg', 'image', 'JPG', true, 'image'],
    ['logo.svg', 'image/svg+xml', 'image', 'SVG', false, 'download'],
    ['huong-dan.pdf', 'application/pdf', 'pdf', 'PDF', false, 'pdf'],
    [
      'bang-gia.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'sheet',
      'XLS',
      false,
      'download',
    ],
    ['dieu-khoan.docx', 'application/octet-stream', 'doc', 'DOC', false, 'download'],
    ['driver.zip', 'application/zip', 'archive', 'ZIP', false, 'download'],
    ['video.mp4', 'video/mp4', 'video', 'MP4', false, 'video'],
    ['clip.mkv', 'video/x-matroska', 'video', 'MKV', false, 'download'],
    ['ghi-am.mp3', 'audio/mpeg', 'audio', 'MP3', false, 'audio'],
    ['ban-ve.dwg', 'application/octet-stream', 'other', 'DWG', false, 'download'],
    ['trang.html', 'text/html', 'text', 'HTML', false, 'download'],
    ['README', 'application/octet-stream', 'other', 'FILE', false, 'download'],
  ])('%s (%s) is %s, badge %s', (name, mime, kind, badge, preview, mode) => {
    expect(fileKindOf(mime, name)).toBe(kind);
    expect(badgeLabel(mime, name)).toBe(badge);
    expect(isPreviewImage(mime)).toBe(preview);
    expect(previewModeOf(mime, name)).toBe(mode);
  });

  it('draws images from their thumbnail, else the file for those who may download it (T407)', () => {
    const png = { mime: 'image/png', url: '/api/v1/files/att_1', thumbnail_url: null };
    const thumbed = { ...png, thumbnail_url: '/api/v1/files/att_1/thumbnail' };
    expect(imageSourceOf(thumbed, false)).toBe('/api/v1/files/att_1/thumbnail');
    expect(imageSourceOf(thumbed, true)).toBe('/api/v1/files/att_1/thumbnail');
    expect(imageSourceOf(png, true)).toBe('/api/v1/files/att_1');
    expect(imageSourceOf(png, false)).toBeNull();
    expect(imageSourceOf({ ...thumbed, mime: 'image/svg+xml' }, true)).toBeNull();
    expect(largeThumbnailOf(thumbed)).toBe('/api/v1/files/att_1/thumbnail?size=1280');
    expect(largeThumbnailOf(png)).toBeNull();
  });

  it('gives PDF, sheets and documents their board colors (option palette)', () => {
    expect(kindColorIndex('pdf')).toBe(4);
    expect(kindColorIndex('sheet')).toBe(2);
    expect(kindColorIndex('doc')).toBe(1);
    expect(kindColorIndex('video')).toBe(7);
  });
});

describe('client checks before an upload (CONTRACTS §20, same order as the server)', () => {
  it('reads the MIME type from the browser, else the extension', () => {
    expect(mimeOfFile({ name: 'a.PNG', type: 'image/png' })).toBe('image/png');
    expect(mimeOfFile({ name: 'photo.heic', type: '' })).toBe('image/heic');
    expect(mimeOfFile({ name: 'blob', type: '' })).toBe('application/octet-stream');
  });

  it.each([
    [file('big.mp4', 'video/mp4', DEFAULT_ATTACHMENT_MAX_FILE_BYTES + 1), {}, 'FILE_TOO_LARGE'],
    [file('setup.exe', 'application/octet-stream'), {}, 'BLOCKED_FILE_TYPE'],
    [file('run.SH.', 'text/plain'), {}, 'BLOCKED_FILE_TYPE'],
    [file('tool.bin', 'application/x-msdownload'), {}, 'BLOCKED_FILE_TYPE'],
    [file('setup.exe', 'application/octet-stream'), { blocked_extensions: [] }, null],
    [
      file('photo.heic', 'image/heic'),
      { accept: ['image/jpeg', 'image/png'] },
      'MIME_NOT_ACCEPTED',
    ],
    [file('photo.jpg', 'image/jpeg'), { accept: ['image/*'] }, null],
    [file('doc.pdf', 'application/pdf'), { accept: null }, null],
  ])('%j with %j → %s', (input, fieldOptions, code) => {
    expect(checkFile(input, options(fieldOptions))?.code ?? null).toBe(code);
  });

  it('checks the size first, with the limit as a parameter', () => {
    const issue = checkFile(
      file('setup.exe', 'application/x-msdownload', 200 * 1024 * 1024),
      options(),
    );
    expect(issue).toEqual({
      code: 'FILE_TOO_LARGE',
      params: { limit: DEFAULT_ATTACHMENT_MAX_FILE_BYTES },
    });
  });

  it('counts the files of the cell and the uploads on their way against max_files', () => {
    const checked = checkFiles(
      [
        file('a.png', 'image/png'),
        file('b.exe', 'application/octet-stream'),
        file('c.png', 'image/png'),
        file('d.png', 'image/png'),
      ],
      options({ max_files: 8 }),
      { used: 6 },
    );
    expect(checked.map((item) => item.issue?.code ?? null)).toEqual([
      null,
      'BLOCKED_FILE_TYPE',
      null,
      'TOO_MANY_VALUES',
    ]);
    expect(checked[3]?.issue?.params).toEqual({ max: 8 });
  });

  it('the default blocks executables, like the server', () => {
    expect(options().blocked_extensions).toEqual([...ATTACHMENT_DEFAULT_BLOCKED_EXTENSIONS]);
  });

  it('describes accepted types for people and for the file input', () => {
    expect(acceptLabels(['image/jpeg', 'image/png', 'image/webp'])).toEqual([
      { name: 'JPG' },
      { name: 'PNG' },
      { name: 'WEBP' },
    ]);
    expect(acceptLabels(['video/*', 'application/vnd.dwg'])).toEqual([
      { family: 'video' },
      { name: 'VND.DWG' },
    ]);
    expect(inputAccept(null)).toBeUndefined();
    expect(inputAccept(['image/jpeg'])).toBe('image/jpeg,.jpg,.jpeg');
  });
});

describe('sizes in the user language', () => {
  it.each([
    [360, 'vi', '360 B'],
    [412_000, 'vi', '402 KB'],
    [1_887_437, 'vi', '1,8 MB'],
    [1_887_437, 'en', '1.8 MB'],
    [100 * 1024 * 1024, 'vi', '100 MB'],
  ])('%i bytes in %s: %s', (bytes, locale, text) => {
    expect(formatBytes(bytes, locale)).toBe(text);
  });

  it('writes progress in the unit of the whole file (board "2,1 / 3,3 MB")', () => {
    expect(formatProgress(2.1 * 1024 * 1024, 3.3 * 1024 * 1024, 'vi')).toBe('2,1 / 3,3 MB');
    expect(formatProgress(10 * 1024 * 1024, 50 * 1024 * 1024, 'en')).toBe('10 / 50 MB');
  });
});

describe('cell values (CONTRACTS §2)', () => {
  const read = [
    {
      id: 'att_A000000000000001',
      name: 'a.png',
      size: 1,
      mime: 'IMAGE/PNG',
      url: '/x',
      thumbnail_url: null,
    },
    { id: 'att_B000000000000001', name: 'b.pdf', size: 2, mime: 'application/pdf' },
    { name: 'no id' },
  ];

  it('reads files (history values have no url) and drops malformed entries', () => {
    expect(cellFilesOf(read)).toEqual([
      {
        id: 'att_A000000000000001',
        name: 'a.png',
        size: 1,
        mime: 'image/png',
        url: '/x',
        thumbnail_url: null,
      },
      {
        id: 'att_B000000000000001',
        name: 'b.pdf',
        size: 2,
        mime: 'application/pdf',
        url: '/api/v1/files/att_B000000000000001',
        thumbnail_url: null,
      },
    ]);
    expect(cellFilesOf(null)).toEqual([]);
  });

  it('writes `[{ id }]` in order, `null` when empty', () => {
    const files = cellFilesOf(read);
    expect(writeValueOf(files)).toEqual([
      { id: 'att_A000000000000001' },
      { id: 'att_B000000000000001' },
    ]);
    expect(writeValueOf([])).toBeNull();
    expect(displayValueOf([])).toBeNull();
  });

  it.each([
    [0, 2, ['b', 'c', 'a']],
    [2, 0, ['c', 'a', 'b']],
    [1, 1, ['a', 'b', 'c']],
    [5, 0, ['a', 'b', 'c']],
  ])('moves %i to %i', (from, to, expected) => {
    expect(moveFile(['a', 'b', 'c'], from, to)).toEqual(expected);
  });
});
