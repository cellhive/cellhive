import { z } from 'zod';

import { ATTACHMENT_MAX_FILENAME_LENGTH } from './attachments.js';
import { idOf } from './ids.js';

/**
 * Images of automation emails (CONTRACTS §23.5; BACKLOG T534, ADR-32 §3,
 * ADR-33 §3). Always embedded as inline parts (`Content-Disposition:
 * inline` + `Content-ID`, HTML `<img src="cid:…">`) — never a remote URL, a
 * signed URL or `data:`. Two sources, both chosen by the author:
 *
 * - **email assets**: images uploaded for the email, files of the
 *   organization in `meta.email_assets` (migration 0035) — a signature logo
 *   (`kind = signature`, organization owners/admins:
 *   `/orgs/{orgId}/email-assets`) or an image of an automation's body
 *   (`kind = automation`, people who manage the automation:
 *   `/automations/{automationId}/email-assets`). Upload like attachments
 *   (`POST …/uploads` → `PUT` to storage → `POST …/uploads/{id}/complete`);
 *   `complete` checks the content, turns it upright, removes EXIF and other
 *   metadata and fits it in 1280 × 1280 px; the result must stay ≤ 2 MiB.
 *   Markdown `![alt](asset:att_… =width)`;
 * - **field images**: the images of an attachment field of the trigger
 *   record (`![alt](field:fld_…)`, body only), sent as their 1280 px
 *   thumbnails (T407) re-encoded as JPEG (PNG with transparency: Outlook renders
 *   no WebP), only `ready` files `run_as` may download.
 *
 * Record values never create an image (they are text nodes). At most
 * `EMAIL_MAX_INLINE_IMAGES` images in one email, counted in the attachment
 * byte budget of the organization (T532). An asset nothing references is
 * deleted by `attachments.cleanup` 24 hours after its upload.
 */

const MIB = 1024 * 1024;

/** Raster images only (never SVG): what an email image may be. */
export const EMAIL_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
export type EmailImageMimeType = (typeof EMAIL_IMAGE_MIME_TYPES)[number];
/** Largest upload before processing (a phone photo), in bytes. */
export const EMAIL_IMAGE_MAX_UPLOAD_BYTES = 10 * MIB;
/** Largest image in an email (processed asset, field thumbnail), in bytes. */
export const EMAIL_INLINE_IMAGE_MAX_BYTES = 2 * MIB;
/** Processed assets fit in a square of this many pixels (never enlarged). */
export const EMAIL_IMAGE_MAX_DIMENSION = 1280;
/** Images of one signature (a logo, a banner). */
export const EMAIL_SIGNATURE_MAX_IMAGES = 2;
/** Default of env `EMAIL_MAX_INLINE_IMAGES` (images of one email, signature included). */
export const DEFAULT_EMAIL_MAX_INLINE_IMAGES = 5;
/** Highest `EMAIL_MAX_INLINE_IMAGES` an instance may set. */
export const EMAIL_MAX_INLINE_IMAGES_CEILING = 20;
/** An asset nothing references is deleted this many hours after its upload. */
export const EMAIL_ASSET_UNUSED_TTL_HOURS = 24;

/** `signature`: organization default or sender identity signatures; `automation`: one automation's body. */
export const EMAIL_ASSET_KINDS = ['signature', 'automation'] as const;
export type EmailAssetKind = (typeof EMAIL_ASSET_KINDS)[number];

// --- Detail codes ----------------------------------------------------------------------

/**
 * Image syntax whose target is not an allowed source: a remote or `data:`
 * URL, `cid:`, another scheme, or `field:` in a signature (`params.position`).
 */
export const IMAGE_SOURCE_NOT_ALLOWED = 'IMAGE_SOURCE_NOT_ALLOWED';
/**
 * `asset:att_…` that is not a ready email asset of this signature/automation
 * (missing, of another organization, automation or kind: one code, no
 * existence leak; `params.asset_id`).
 */
export const EMAIL_IMAGE_NOT_FOUND = 'EMAIL_IMAGE_NOT_FOUND';
/** More images than allowed (`params.count`, `params.maximum`). */
export const TOO_MANY_IMAGES = 'TOO_MANY_IMAGES';
/** Deleting an asset a signature or automation still shows. */
export const EMAIL_IMAGE_IN_USE = 'EMAIL_IMAGE_IN_USE';
/** An upload that is not a readable PNG, JPEG, GIF or WebP image, or too many pixels. */
export const IMAGE_UNREADABLE = 'IMAGE_UNREADABLE';

// --- Requests and responses ------------------------------------------------------------

export const emailAssetUploadRequestSchema = z
  .strictObject({
    filename: z.string().trim().min(1).max(ATTACHMENT_MAX_FILENAME_LENGTH),
    size: z
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .meta({
        description: `Exact size in bytes (at most ${String(EMAIL_IMAGE_MAX_UPLOAD_BYTES)}); the upload URL is signed for it`,
      }),
    mime: z.string().min(3).max(255).meta({
      description: 'One of `image/png`, `image/jpeg`, `image/gif`, `image/webp` (never SVG)',
      example: 'image/png',
    }),
  })
  .meta({ id: 'EmailAssetUploadRequest' });
export type EmailAssetUploadRequest = z.infer<typeof emailAssetUploadRequestSchema>;

/** A ready email image. */
export const emailAssetSchema = z
  .object({
    id: idOf('att'),
    kind: z.enum(EMAIL_ASSET_KINDS),
    name: z.string(),
    mime: z.enum(EMAIL_IMAGE_MIME_TYPES).meta({ description: 'Type after processing' }),
    size: z.int().min(1).meta({ description: 'Bytes after processing (≤ 2 MiB)' }),
    width: z.int().min(1).max(EMAIL_IMAGE_MAX_DIMENSION),
    height: z.int().min(1).max(EMAIL_IMAGE_MAX_DIMENSION),
    markdown: z.string().meta({
      description:
        'What to insert in the Markdown: `![name](asset:att_… =width)` (`]` and `\\` of the ' +
        'name escaped as `\\]`, `\\\\`)',
    }),
    url: z.string().meta({
      description:
        'Where the editor previews it (`302` to a signed URL valid 60 s, for the same people ' +
        'who may upload it)',
    }),
  })
  .meta({ id: 'EmailAsset' });
export type EmailAssetDto = z.infer<typeof emailAssetSchema>;

/** Where organization owners/admins read a signature image. */
export function orgEmailAssetUrl(organizationId: string, assetId: string): string {
  return `/api/v1/orgs/${encodeURIComponent(organizationId)}/email-assets/${encodeURIComponent(assetId)}`;
}

/** Where people who manage an automation read an image of its body. */
export function automationEmailAssetUrl(automationId: string, assetId: string): string {
  return `/api/v1/automations/${encodeURIComponent(automationId)}/email-assets/${encodeURIComponent(assetId)}`;
}

/** An image of the email preview: its Content-ID and a signed URL for the viewer only. */
export const emailPreviewImageSchema = z
  .object({
    cid: z.string().meta({ description: 'Content-ID referenced by `src="cid:…"` in `html`' }),
    url: z.string().meta({
      description:
        'Signed URL valid 60 s, for the person previewing only (never sent): replace ' +
        '`cid:` sources with it to show the image in the sandboxed preview',
    }),
  })
  .meta({ id: 'EmailPreviewImage' });
export type EmailPreviewImageDto = z.infer<typeof emailPreviewImageSchema>;
