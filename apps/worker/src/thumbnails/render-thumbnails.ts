import { Buffer } from 'node:buffer';

import {
  ATTACHMENT_THUMBNAIL_MAX_INPUT_BYTES,
  ATTACHMENT_THUMBNAIL_MAX_PIXELS,
} from '@cellhive/contracts';
import sharp from 'sharp';

import type { Readable } from 'node:stream';

/** Input formats rendered (by content, whatever the declared type): the raster images of CONTRACTS §20. */
const RASTER_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'gif', 'webp']);
/** WebP quality of the thumbnails. */
const WEBP_QUALITY = 80;
/** A render taking longer is abandoned (libvips `timeout`). */
const RENDER_TIMEOUT_SECONDS = 30;

// No operation cache (every image is read once), few libvips threads per render.
sharp.cache(false);
sharp.concurrency(2);

export interface RenderedThumbnail {
  readonly size: number;
  readonly data: Buffer;
}

/** Why an image gets no thumbnail: skipped for good, the attachment stays usable. */
export type ThumbnailSkipReason = 'too_large' | 'too_many_pixels' | 'unsupported' | 'unreadable';

export type ThumbnailRender =
  | { readonly ok: true; readonly thumbnails: readonly RenderedThumbnail[] }
  | { readonly ok: false; readonly reason: ThumbnailSkipReason };

/**
 * Reads at most `limit` bytes of `stream`; `null` when it holds more (the
 * stream is destroyed then, the rest never read).
 */
export async function readAtMost(stream: Readable, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > limit) {
      stream.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

const INPUT_OPTIONS = {
  limitInputPixels: ATTACHMENT_THUMBNAIL_MAX_PIXELS,
  failOn: 'error',
  sequentialRead: true,
  animated: false,
} as const;

/**
 * WebP thumbnails of a raster image (BACKLOG T407), one per size, each
 * fitted inside `size` × `size` pixels (never enlarged), oriented by EXIF,
 * without metadata; the first frame of an animation. Guards against
 * decompression bombs before any pixel is decoded: the dimensions in the
 * header must stay within `ATTACHMENT_THUMBNAIL_MAX_PIXELS` (and libvips
 * enforces the same `limitInputPixels` while decoding). The format comes
 * from the content, never from the declared MIME type: only PNG, JPEG, GIF
 * and WebP are rendered (never SVG, PDF or another format libvips reads).
 */
export async function renderThumbnails(
  input: Buffer,
  sizes: readonly number[],
): Promise<ThumbnailRender> {
  if (input.length > ATTACHMENT_THUMBNAIL_MAX_INPUT_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  let failure: unknown;
  const metadata = await sharp(input, INPUT_OPTIONS)
    .metadata()
    .catch((error: unknown) => {
      failure = error;
      return null;
    });
  if (metadata === null) return { ok: false, reason: skipReasonOf(failure) };
  if (!RASTER_FORMATS.has(metadata.format)) return { ok: false, reason: 'unsupported' };
  const width = metadata.width;
  const height = metadata.pageHeight ?? metadata.height;
  if (width < 1 || height < 1 || width * height > ATTACHMENT_THUMBNAIL_MAX_PIXELS) {
    return { ok: false, reason: 'too_many_pixels' };
  }
  try {
    const thumbnails: RenderedThumbnail[] = [];
    for (const size of sizes) {
      const data = await sharp(input, INPUT_OPTIONS)
        .timeout({ seconds: RENDER_TIMEOUT_SECONDS })
        .autoOrient()
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      thumbnails.push({ size, data });
    }
    return { ok: true, thumbnails };
  } catch (error) {
    return { ok: false, reason: skipReasonOf(error) };
  }
}

/** libvips refuses images over `limitInputPixels` with "Input image exceeds pixel limit". */
function skipReasonOf(error: unknown): ThumbnailSkipReason {
  const message = error instanceof Error ? error.message : '';
  return /pixel limit/iu.test(message) ? 'too_many_pixels' : 'unreadable';
}
