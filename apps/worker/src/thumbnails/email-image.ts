import {
  ATTACHMENT_THUMBNAIL_MAX_PIXELS,
  EMAIL_IMAGE_MAX_DIMENSION,
  EMAIL_IMAGE_MAX_UPLOAD_BYTES,
  type EmailImageMimeType,
} from '@cellhive/contracts';
import sharp from 'sharp';

import type { Buffer } from 'node:buffer';

/** A processing taking longer is abandoned (libvips `timeout`). */
const PROCESS_TIMEOUT_SECONDS = 20;

/** Output type by input format: GIF becomes PNG (first frame), the others keep theirs. */
const OUTPUT: Readonly<Record<string, EmailImageMimeType>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/png',
};

const INPUT_OPTIONS = {
  limitInputPixels: ATTACHMENT_THUMBNAIL_MAX_PIXELS,
  failOn: 'error',
  sequentialRead: true,
  animated: false,
} as const;

export interface ProcessedEmailImage {
  readonly data: Buffer;
  readonly mime: EmailImageMimeType;
  readonly width: number;
  readonly height: number;
}

export type EmailImageProcessing =
  | { readonly ok: true; readonly image: ProcessedEmailImage }
  | { readonly ok: false; readonly reason: 'too_large' | 'too_many_pixels' | 'unreadable' };

/** Processes an uploaded email image (see `processEmailImage`). */
export type EmailImageProcessor = (input: Buffer) => Promise<EmailImageProcessing>;

/**
 * An uploaded email image (BACKLOG T534) made safe to embed: the format
 * comes from the content (PNG, JPEG, GIF, WebP only — never SVG or any
 * other format libvips reads), decompression bombs are refused before any
 * pixel is decoded, the image is turned upright by its EXIF orientation,
 * fitted inside `EMAIL_IMAGE_MAX_DIMENSION` px (never enlarged) and
 * re-encoded **without metadata** (EXIF, GPS, ICC, XMP are dropped — sharp
 * keeps none unless asked). Animated GIFs keep their first frame, as PNG.
 * The caller checks the result against `EMAIL_INLINE_IMAGE_MAX_BYTES`.
 */
export async function processEmailImage(input: Buffer): Promise<EmailImageProcessing> {
  if (input.length > EMAIL_IMAGE_MAX_UPLOAD_BYTES) return { ok: false, reason: 'too_large' };
  let failure: unknown;
  const metadata = await sharp(input, INPUT_OPTIONS)
    .metadata()
    .catch((error: unknown) => {
      failure = error;
      return null;
    });
  if (metadata === null) return { ok: false, reason: failureReason(failure) };
  const output = OUTPUT[metadata.format];
  if (output === undefined) return { ok: false, reason: 'unreadable' };
  const width = metadata.width;
  const height = metadata.pageHeight ?? metadata.height;
  if (width < 1 || height < 1 || width * height > ATTACHMENT_THUMBNAIL_MAX_PIXELS) {
    return { ok: false, reason: 'too_many_pixels' };
  }
  try {
    let pipeline = sharp(input, INPUT_OPTIONS)
      .timeout({ seconds: PROCESS_TIMEOUT_SECONDS })
      .autoOrient()
      .resize(EMAIL_IMAGE_MAX_DIMENSION, EMAIL_IMAGE_MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    pipeline =
      output === 'image/jpeg'
        ? pipeline.jpeg({ quality: 85, mozjpeg: true })
        : output === 'image/webp'
          ? pipeline.webp({ quality: 85 })
          : pipeline.png({ compressionLevel: 9 });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { ok: true, image: { data, mime: output, width: info.width, height: info.height } };
  } catch (error) {
    return { ok: false, reason: failureReason(error) };
  }
}

/** A field image ready for an email: JPEG, or PNG when it has transparency. */
export interface TranscodedEmailImage {
  readonly data: Buffer;
  readonly mime: 'image/jpeg' | 'image/png';
}

/** Re-encodes a field image for email clients (see `transcodeEmailImage`). */
export type EmailImageTranscoder = (input: Buffer) => Promise<TranscodedEmailImage | null>;

/**
 * A field image (the 1280 px WebP thumbnail of T407) in a format every
 * email client shows (BACKLOG T534): Outlook for Windows renders no WebP.
 * Same guarded pipeline as `processEmailImage` (raster formats by content,
 * pixel limit, timeout, upright, no metadata, never enlarged): JPEG, or PNG
 * when the image has an alpha channel. `null` when it cannot be read.
 */
export async function transcodeEmailImage(input: Buffer): Promise<TranscodedEmailImage | null> {
  if (input.length > EMAIL_IMAGE_MAX_UPLOAD_BYTES) return null;
  const metadata = await sharp(input, INPUT_OPTIONS)
    .metadata()
    .catch(() => null);
  if (metadata === null || OUTPUT[metadata.format] === undefined) return null;
  const width = metadata.width;
  const height = metadata.pageHeight ?? metadata.height;
  if (width < 1 || height < 1 || width * height > ATTACHMENT_THUMBNAIL_MAX_PIXELS) return null;
  try {
    const pipeline = sharp(input, INPUT_OPTIONS)
      .timeout({ seconds: PROCESS_TIMEOUT_SECONDS })
      .autoOrient()
      .resize(EMAIL_IMAGE_MAX_DIMENSION, EMAIL_IMAGE_MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    if (metadata.hasAlpha) {
      return { data: await pipeline.png({ compressionLevel: 9 }).toBuffer(), mime: 'image/png' };
    }
    return {
      data: await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer(),
      mime: 'image/jpeg',
    };
  } catch {
    return null;
  }
}

/** libvips refuses images over `limitInputPixels` with "Input image exceeds pixel limit". */
function failureReason(error: unknown): 'too_many_pixels' | 'unreadable' {
  const message = error instanceof Error ? error.message : '';
  return /pixel limit/iu.test(message) ? 'too_many_pixels' : 'unreadable';
}
