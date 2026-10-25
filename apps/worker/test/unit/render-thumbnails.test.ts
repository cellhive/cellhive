import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { readAtMost, renderThumbnails } from '../../src/thumbnails/render-thumbnails.js';

import { pngBomb } from './png-bomb.js';

const SIZES = [256, 1280];

/** `renderThumbnails` (BACKLOG T407): sizes, formats, decompression bombs. */
describe('renderThumbnails', () => {
  it('renders WebP thumbnails fitted inside each size, never enlarged', async () => {
    const input = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#3b82f6' },
    })
      .jpeg()
      .toBuffer();
    const result = await renderThumbnails(input, SIZES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sizes = await Promise.all(
      result.thumbnails.map(async (thumbnail) => {
        const meta = await sharp(thumbnail.data).metadata();
        return [thumbnail.size, meta.format, meta.width, meta.height];
      }),
    );
    expect(sizes).toEqual([
      [256, 'webp', 256, 171],
      [1280, 'webp', 1280, 853],
    ]);

    const small = await sharp({
      create: { width: 100, height: 40, channels: 4, background: '#ff000080' },
    })
      .png()
      .toBuffer();
    const kept = await renderThumbnails(small, SIZES);
    expect(kept.ok && (await sharp(kept.thumbnails[1]?.data).metadata()).width).toBe(100);
  });

  it('renders a 20 MP photo in well under 3 seconds', async () => {
    const photo = await sharp({
      create: {
        width: 5472,
        height: 3648,
        channels: 3,
        background: '#808080',
        noise: { type: 'gaussian', mean: 128, sigma: 40 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    const started = performance.now();
    const result = await renderThumbnails(photo, SIZES);
    const elapsed = performance.now() - started;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(3_000);
  }, 30_000);

  it('skips decompression bombs before decoding them', async () => {
    const bomb = pngBomb(30_000, 30_000);
    expect(bomb.length).toBeLessThan(64 * 1024);
    const started = performance.now();
    expect(await renderThumbnails(bomb, SIZES)).toEqual({ ok: false, reason: 'too_many_pixels' });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('only renders PNG, JPEG, GIF and WebP by content (never SVG), and skips garbage', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    expect(await renderThumbnails(svg, SIZES)).toEqual({ ok: false, reason: 'unsupported' });
    expect(await renderThumbnails(Buffer.from('not an image'), SIZES)).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    // A PNG signature and header followed by nothing.
    const truncated = pngBomb(10, 10).subarray(0, 40);
    expect((await renderThumbnails(truncated, SIZES)).ok).toBe(false);

    const gif = await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#00ff00' },
    })
      .gif()
      .toBuffer();
    expect((await renderThumbnails(gif, SIZES)).ok).toBe(true);
  });

  it('reads at most the limit of a stream', async () => {
    expect(await readAtMost(Readable.from([Buffer.from('abc'), Buffer.from('de')]), 5)).toEqual(
      Buffer.from('abcde'),
    );
    const stream = Readable.from([Buffer.from('abc'), Buffer.from('def')]);
    expect(await readAtMost(stream, 5)).toBeNull();
    expect(stream.destroyed).toBe(true);
  });
});
