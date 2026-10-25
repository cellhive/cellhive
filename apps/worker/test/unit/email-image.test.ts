import { Buffer } from 'node:buffer';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { processEmailImage, transcodeEmailImage } from '../../src/thumbnails/email-image.js';

import { pngBomb } from './png-bomb.js';

/** `processEmailImage` (BACKLOG T534): orientation, size, metadata, formats, bombs. */
describe('processEmailImage', () => {
  it('fits a photo in 1280 px, upright, without EXIF', async () => {
    // 3000 × 2000 stored sideways (EXIF orientation 6 = rotate 90° clockwise), with GPS-like metadata.
    const input = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#3b82f6' },
    })
      .withMetadata({
        orientation: 6,
        exif: { IFD0: { Copyright: 'secret owner', ImageDescription: 'home address' } },
      })
      .jpeg()
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const result = await processEmailImage(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.mime).toBe('image/jpeg');
    // Turned upright: portrait.
    expect([result.image.width, result.image.height]).toEqual([853, 1280]);
    const meta = await sharp(result.image.data).metadata();
    expect([meta.width, meta.height]).toEqual([853, 1280]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(result.image.data.includes(Buffer.from('secret owner'))).toBe(false);
  });

  it('keeps small images, PNG and WebP as they are typed; GIF becomes PNG', async () => {
    const png = await sharp({
      create: { width: 120, height: 40, channels: 4, background: '#ff000080' },
    })
      .png()
      .toBuffer();
    const kept = await processEmailImage(png);
    expect(kept.ok && [kept.image.mime, kept.image.width, kept.image.height]).toEqual([
      'image/png',
      120,
      40,
    ]);
    const webp = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } })
      .webp()
      .toBuffer();
    expect((await processEmailImage(webp)).ok && 'webp').toBe('webp');
    const gif = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#0f0' } })
      .gif()
      .toBuffer();
    const fromGif = await processEmailImage(gif);
    expect(fromGif.ok && fromGif.image.mime).toBe('image/png');
    expect(fromGif.ok && (await sharp(fromGif.image.data).metadata()).format).toBe('png');
  });

  it('re-encodes field thumbnails (WebP) as JPEG, or PNG with transparency', async () => {
    const opaque = await sharp({
      create: { width: 1280, height: 853, channels: 3, background: '#3b82f6' },
    })
      .webp({ quality: 80 })
      .toBuffer();
    const jpeg = await transcodeEmailImage(opaque);
    expect(jpeg?.mime).toBe('image/jpeg');
    const jpegMeta = await sharp(jpeg?.data).metadata();
    expect([jpegMeta.format, jpegMeta.width, jpegMeta.height]).toEqual(['jpeg', 1280, 853]);
    expect(jpegMeta.exif).toBeUndefined();

    const transparent = await sharp({
      create: { width: 200, height: 100, channels: 4, background: '#ff000080' },
    })
      .webp()
      .toBuffer();
    const png = await transcodeEmailImage(transparent);
    expect(png?.mime).toBe('image/png');
    expect((await sharp(png?.data).metadata()).format).toBe('png');

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
    expect(await transcodeEmailImage(svg)).toBeNull();
    expect(await transcodeEmailImage(pngBomb(30_000, 30_000))).toBeNull();
  });

  it('refuses SVG, garbage and decompression bombs', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    expect(await processEmailImage(svg)).toEqual({ ok: false, reason: 'unreadable' });
    expect(await processEmailImage(Buffer.from('not an image'))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    expect(await processEmailImage(pngBomb(30_000, 30_000))).toEqual({
      ok: false,
      reason: 'too_many_pixels',
    });
  });
});
