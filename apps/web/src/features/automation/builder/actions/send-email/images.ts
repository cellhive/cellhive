import { EMAIL_IMAGE_MIME_TYPES, type EmailAssetDto, type FieldDto } from '@cellhive/contracts';
import {
  collectImages,
  IMAGE_SOURCES,
  MAX_IMAGE_ALT,
  parseMarkdown,
  parseTemplate,
} from '@cellhive/markdown';

import type { EmailImageField } from '../../../../../lib/email-images/InsertImageButton';

/**
 * Pure rules of "Insert image" in the `send_email` body (T534 in the
 * editor of T522, CONTRACTS §23.5): which attachment fields may show their
 * images, the Markdown inserted for them, and how many images the body
 * already has (as the server counts them on save).
 */

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(EMAIL_IMAGE_MIME_TYPES);

/**
 * Whether an attachment field may hold images an email can show: no
 * `accept` list, or one that lets in a raster image type (`image/*` or one
 * of PNG, JPEG, GIF, WebP — never SVG).
 */
export function acceptsEmailImages(options: unknown): boolean {
  const accept = (options as { accept?: unknown } | null | undefined)?.accept;
  if (!Array.isArray(accept)) return true;
  return accept.some(
    (entry) => typeof entry === 'string' && (entry === 'image/*' || IMAGE_MIME_TYPES.has(entry)),
  );
}

/**
 * Attachment fields of the trigger table whose images the body may show:
 * image types accepted and files the editor may download (the server
 * refuses the others on save, `ATTACHMENT_FIELD_NOT_DOWNLOADABLE`).
 */
export function emailImageFields(
  fields: readonly Pick<FieldDto, 'id' | 'name' | 'type' | 'options'>[],
  canDownload: (fieldId: string) => boolean,
): EmailImageField[] {
  return fields
    .filter(
      (field) =>
        field.type === 'attachment' && acceptsEmailImages(field.options) && canDownload(field.id),
    )
    .map((field) => ({ id: field.id, name: field.name }));
}

/**
 * Alternative text of an image as the body editor inserts it (a name of a
 * field or of an uploaded file). The editor stores what is typed as
 * template source: a `\` becomes `\\` and a `{` becomes `\{`, which the
 * Markdown of the image reads back as `\` and `{` — so those need nothing
 * here. A `]` would end the alternative text, and its Markdown escape `\]`
 * cannot go through the editor (the `\` would be stored doubled): brackets
 * become parentheses. Line breaks become spaces; at most 200 characters.
 */
export function bodyImageAlt(name: string): string {
  const text = name
    .replace(/[\r\n]+/gu, ' ')
    .replace(/\[/gu, '(')
    .replace(/\]/gu, ')');
  return Array.from(text).slice(0, MAX_IMAGE_ALT).join('');
}

/** The body text of a field's images: `![name](field:fld_…)`. */
export function fieldImageText(field: EmailImageField): string {
  return `![${bodyImageAlt(field.name)}](field:${field.id})`;
}

/**
 * The body text of an uploaded image: the server's `markdown`
 * (`![name](asset:att_… =w)`) with its alternative text as the editor
 * carries it (see `bodyImageAlt`).
 */
export function assetImageText(asset: Pick<EmailAssetDto, 'markdown'>): string {
  const [block] = parseMarkdown(asset.markdown, { images: ['asset'] });
  const image = block?.type === 'paragraph' ? block.children[0] : undefined;
  if (image?.type !== 'image') return asset.markdown;
  const width = image.width === null ? '' : ` =${String(image.width)}`;
  return `![${bodyImageAlt(image.alt)}](asset:${image.id}${width})`;
}

/** Images of the body as the server counts them on save: each asset and each field once. */
export function bodyImageCount(template: string): number {
  const images = collectImages(parseTemplate(template, { images: IMAGE_SOURCES }).blocks);
  return new Set(images.map((image) => `${image.source}:${image.id}`)).size;
}
