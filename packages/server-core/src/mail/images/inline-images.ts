import {
  MAX_IMAGE_WIDTH,
  type HtmlImage,
  type ImageNode,
  type ImageResolver,
} from '@cellhive/markdown';

/**
 * Inline images of one automation email (BACKLOG T534, ADR-32 §3): the
 * files the `image` nodes of the body and the signature stand for, each
 * sent once as an inline part (`Content-Disposition: inline`,
 * `Content-ID: <att_…@cellhive>`) and referenced by `<img src="cid:…">`.
 * Never a URL. Which files a node gets is decided by the caller (assets of
 * the right kind, field images `run_as` may download); this module only
 * keeps them in order, without duplicates, and answers the renderer.
 */

/** Domain part of the Content-IDs (they never leave the message). */
export const INLINE_IMAGE_CID_DOMAIN = 'cellhive';
/** Width of the body column of the 600 px layout (24 px padding on each side). */
export const EMAIL_CONTENT_WIDTH = 552;

/** The Content-ID of a file's inline part (`att_…@cellhive`). */
export function inlineImageCid(fileId: string): string {
  return `${fileId}@${INLINE_IMAGE_CID_DOMAIN}`;
}

/** Where an image node is: the body template or the signature. */
export type InlineImagePart = 'body' | 'signature';

/** A file sent as an inline image. */
export interface InlineImageFile {
  /** Email asset or attachment id. */
  readonly fileId: string;
  readonly cid: string;
  /** Storage key of the bytes sent (processed asset, or the 1280 px thumbnail of a field file). */
  readonly objectKey: string;
  readonly size: number;
  readonly mime: string;
  /** Name of the part (no path; never logged). */
  readonly filename: string;
  /** Natural width when known. */
  readonly width: number | null;
  /**
   * The bytes to send when they were re-encoded in memory (field images:
   * JPEG/PNG from the WebP thumbnail); absent → streamed from `objectKey`.
   */
  readonly content?: Uint8Array;
}

/**
 * Re-encodes a field image (a WebP thumbnail) into a format every email
 * client shows — JPEG, or PNG with transparency (Outlook for Windows renders
 * no WebP). Provided by the worker (`transcodeEmailImage`, sharp); `null`
 * when the image cannot be read.
 */
export type InlineImageTranscoder = (
  input: Buffer,
) => Promise<{ readonly data: Buffer; readonly mime: string } | null>;

/** Why an image of the email is left out (step warning, never a file name). */
export interface InlineImageSkip {
  readonly code: 'inline_image_skipped';
  /** The attachment field, for a field image. */
  readonly field_id?: string;
}

const keyOf = (part: InlineImagePart, node: ImageNode): string =>
  `${part}|${node.source}:${node.id}`;

/** The inline images of one email, ready for the renderer and the message. */
export class InlineImageSet {
  private readonly byNode = new Map<string, readonly InlineImageFile[]>();
  private readonly unique = new Map<string, InlineImageFile>();
  private readonly skips: InlineImageSkip[] = [];
  private skippedCount = 0;

  /** The files `node` of `part` stands for (none: the image is left out). */
  set(part: InlineImagePart, node: ImageNode, files: readonly InlineImageFile[]): void {
    this.byNode.set(keyOf(part, node), files);
    for (const file of files) if (!this.unique.has(file.fileId)) this.unique.set(file.fileId, file);
  }

  /** An image left out: counted, and one warning per field (or one for assets). */
  skip(count: number, fieldId?: string): void {
    if (count <= 0) return;
    this.skippedCount += count;
    if (!this.skips.some((skip) => skip.field_id === fieldId)) {
      this.skips.push(
        fieldId === undefined
          ? { code: 'inline_image_skipped' }
          : { code: 'inline_image_skipped', field_id: fieldId },
      );
    }
  }

  /** Every file once, in the order the email first shows it. */
  get files(): readonly InlineImageFile[] {
    return [...this.unique.values()];
  }

  /** Bytes of the files (they count toward the attachment byte limit, T532). */
  get bytes(): number {
    return this.files.reduce((total, file) => total + file.size, 0);
  }

  get skipped(): number {
    return this.skippedCount;
  }

  get warnings(): readonly InlineImageSkip[] {
    return this.skips;
  }

  /** The renderer's images of `part`: each file as `cid:` with the node's alt text and width. */
  resolver(part: InlineImagePart): ImageResolver {
    return (node: ImageNode): readonly HtmlImage[] =>
      (this.byNode.get(keyOf(part, node)) ?? []).map((file) => ({
        cid: file.cid,
        alt: node.alt,
        width:
          node.width ??
          (file.width === null ? null : Math.min(file.width, EMAIL_CONTENT_WIDTH, MAX_IMAGE_WIDTH)),
      }));
  }
}
