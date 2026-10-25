import { describe, expect, it } from 'vitest';

import {
  asciiFallbackFilename,
  contentDisposition,
  encodeRfc5987,
  sanitizeFilename,
} from '../../src/storage/index.js';

describe('contentDisposition (RFC 6266 / RFC 5987)', () => {
  const cases: { filename: string; expected: string }[] = [
    {
      filename: 'report.pdf',
      expected: `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    },
    {
      filename: 'Báo cáo tháng 9.xlsx',
      expected: `attachment; filename="Bao cao thang 9.xlsx"; filename*=UTF-8''B%C3%A1o%20c%C3%A1o%20th%C3%A1ng%209.xlsx`,
    },
    {
      filename: 'Đơn hàng.csv',
      expected: `attachment; filename="Don hang.csv"; filename*=UTF-8''%C4%90%C6%A1n%20h%C3%A0ng.csv`,
    },
    {
      filename: '数据.txt',
      expected: `attachment; filename="__.txt"; filename*=UTF-8''%E6%95%B0%E6%8D%AE.txt`,
    },
    {
      filename: `a"b\\c%d'e(f)*.txt`,
      expected: `attachment; filename="a_b_c_d'e(f)*.txt"; filename*=UTF-8''a%22b_c%25d%27e%28f%29%2A.txt`,
    },
    {
      filename: 'evil\r\nSet-Cookie: x=1.txt',
      expected: `attachment; filename="evilSet-Cookie: x=1.txt"; filename*=UTF-8''evilSet-Cookie%3A%20x%3D1.txt`,
    },
    {
      filename: '../../etc/passwd',
      expected: `attachment; filename=".._.._etc_passwd"; filename*=UTF-8''.._.._etc_passwd`,
    },
    { filename: '', expected: `attachment; filename="download"; filename*=UTF-8''download` },
    { filename: '..', expected: `attachment; filename="download"; filename*=UTF-8''download` },
  ];

  it.each(cases)('$filename', ({ filename, expected }) => {
    expect(contentDisposition(filename)).toBe(expected);
  });

  it('supports inline', () => {
    expect(contentDisposition('a.png', 'inline')).toBe(
      `inline; filename="a.png"; filename*=UTF-8''a.png`,
    );
  });

  it('round-trips through decodeURIComponent', () => {
    const name = 'Nguyễn Văn Ánh (bản cuối)*.docx';
    expect(decodeURIComponent(encodeRfc5987(name))).toBe(name);
    expect(encodeRfc5987(name)).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
  });

  it('never emits header-breaking characters', () => {
    for (let code = 0; code < 0x200; code += 1) {
      const header = contentDisposition(`x${String.fromCharCode(code)}y`);
      expect(header).not.toMatch(/[\r\n\0]/);
      expect(header).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it('falls back to "download" when nothing printable remains', () => {
    expect(sanitizeFilename('\u0000\u0001')).toBe('download');
    expect(asciiFallbackFilename('   ')).toBe('download');
  });
});
