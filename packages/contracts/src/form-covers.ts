import { z } from 'zod';

import { ATTACHMENT_MAX_FILENAME_LENGTH } from './attachments.js';
import { idOf } from './ids.js';

/**
 * Cover images of forms (`config.form.cover_attachment_id`, CONTRACTS §15,
 * §17; BACKLOG T419). A cover is a file of its own, not a cell value: it
 * lives in `meta.form_covers` (migration 0019), is uploaded for one form
 * view (`POST /views/{viewId}/form-cover/uploads` → `PUT` to storage →
 * `…/complete`), becomes the cover once the view config names it, and is
 * read through the view (`GET /views/{viewId}/form-cover/{attachmentId}`)
 * or through the form's share link (`GET /shares/{token}/form-cover/{attachmentId}`).
 * A cover no form view names is deleted by `attachments.cleanup` 24 hours
 * after its upload.
 */

/** Largest cover image, in bytes. */
export const FORM_COVER_MAX_BYTES = 5 * 1024 * 1024;
/** Cover images are raster images served inline (never SVG or HTML). */
export const FORM_COVER_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
/** A cover no form view names is deleted this many hours after its upload. */
export const FORM_COVER_UNUSED_TTL_HOURS = 24;

export const formCoverUploadRequestSchema = z
  .strictObject({
    filename: z.string().trim().min(1).max(ATTACHMENT_MAX_FILENAME_LENGTH),
    size: z
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .meta({ description: 'Exact size in bytes; the upload URL is signed for it' }),
    mime: z.string().min(3).max(255).meta({
      description: 'One of `image/png`, `image/jpeg`, `image/gif`, `image/webp`',
      example: 'image/jpeg',
    }),
  })
  .meta({ id: 'FormCoverUploadRequest' });
export type FormCoverUploadRequest = z.infer<typeof formCoverUploadRequestSchema>;

/** A finished cover upload. */
export const formCoverSchema = z
  .object({
    id: idOf('att'),
    name: z.string(),
    size: z.int().min(0),
    mime: z.string(),
    url: z.string().meta({
      description: '`/api/v1/views/{viewId}/form-cover/{id}`: checks the view, then `302`',
    }),
  })
  .meta({ id: 'FormCover' });
export type FormCoverDto = z.infer<typeof formCoverSchema>;

/** Where members read the cover of a form view. */
export function formCoverUrl(viewId: string, attachmentId: string): string {
  return `/api/v1/views/${encodeURIComponent(viewId)}/form-cover/${encodeURIComponent(attachmentId)}`;
}

/** Where people with the form's share link read its cover. */
export function sharedFormCoverUrl(token: string, attachmentId: string): string {
  return `/api/v1/shares/${encodeURIComponent(token)}/form-cover/${encodeURIComponent(attachmentId)}`;
}
