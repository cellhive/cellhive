import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { sampleFiles } from '../../src/seed/sample-attachments.js';

/** Width, height and the distinct RGB colors of an 8-bit RGB PNG (filter 0 rows). */
function decode(bytes: Buffer): { width: number; height: number; colors: number } {
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  let offset = 8;
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect([body[8], body[9]]).toEqual([8, 2]);
    }
    if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const colors = new Set<number>();
  const stride = width * 3 + 1;
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * stride]).toBe(0);
    for (let x = 0; x < width; x += 1) {
      const at = y * stride + 1 + x * 3;
      colors.add(((raw[at] ?? 0) << 16) | ((raw[at + 1] ?? 0) << 8) | (raw[at + 2] ?? 0));
    }
  }
  return { width, height, colors: colors.size };
}

describe('sample files of the demo seed (T421b: visible images)', () => {
  it('draws real pictures: a gradient of many colors, not a 1×1 black pixel', () => {
    const images = sampleFiles().filter((file) => file.mime === 'image/png');
    expect(images).toHaveLength(2);
    for (const image of images) {
      const { width, height, colors } = decode(image.bytes);
      expect(width).toBeGreaterThanOrEqual(256);
      expect(height).toBeGreaterThanOrEqual(160);
      expect(colors).toBeGreaterThan(100);
    }
    // Two different pictures.
    expect(images[0]?.bytes.equals(images[1]?.bytes ?? Buffer.alloc(0))).toBe(false);
  });
});
