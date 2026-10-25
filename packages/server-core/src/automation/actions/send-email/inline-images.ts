import { Buffer } from 'node:buffer';

import {
  ATTACHMENT_THUMBNAIL_SIZES,
  EMAIL_IMAGE_MIME_TYPES,
  EMAIL_INLINE_IMAGE_MAX_BYTES,
  type Id,
} from '@cellhive/contracts';

import { EmailAssetsRepository } from '../../../mail/images/email-assets.repository.js';
import {
  inlineImageCid,
  InlineImageSet,
  type InlineImageFile,
  type InlineImageTranscoder,
} from '../../../mail/images/inline-images.js';
import {
  AttachmentsRepository,
  attachmentThumbnailKey,
} from '../../../records/attachments/attachments.repository.js';

import { ATTACHMENT_FIELD_TYPE } from './attachments/resolve.js';

import type { Db } from '../../../db/create-db.js';
import type { OrgScope } from '../../../db/repository.js';
import type { AttachmentRow, EmailAssetRow } from '../../../db/schema.js';
import type { AutomationEmailImages } from '../../../mail/automation-email/compose.js';
import type { StorageDriver } from '../../../storage/storage-driver.js';
import type { AutomationValidationContext } from '../../definition/validate.js';
import type { AutomationValueEvaluator } from '../../values/evaluator.js';
import type { ImageNode } from '@cellhive/markdown';
import type { Readable } from 'node:stream';

/**
 * The inline images of one `send_email` step (BACKLOG T534, ADR-32 §3):
 *
 * - `asset:` of the body → a ready email asset of **this automation**;
 *   `asset:` of the signature → a ready **signature** asset of the
 *   organization. Anything else (deleted, other organization, other
 *   automation) is left out with an `inline_image_skipped` warning;
 * - `field:` of the body → the image files (PNG, JPEG, GIF, WebP) of that
 *   attachment field of the trigger record, read as the person the email is
 *   rendered as (`run_as` now, or the editor in a preview): they must read
 *   the record and the field and download its files
 *   (`file_download_fields`) — like attachments (T532) — and only `ready`
 *   files with a `ready` 1280 px thumbnail (T407) are sent: the WebP
 *   thumbnail re-encoded to JPEG (PNG with transparency) by the injected
 *   transcoder — Outlook for Windows renders no WebP — at most
 *   `EMAIL_INLINE_IMAGE_MAX_BYTES` each. Other files of the cell (PDF…) are
 *   not images and are ignored; images left out are counted with one
 *   warning per field. Never an error: the step fails only on the limits
 *   (`too_many_attachments`/`attachments_too_large`).
 *
 * Only thumbnails of field images are read (≤ 2 MiB each, kept in memory).
 */

/** Size of the thumbnail sent for a field image. */
export const FIELD_IMAGE_THUMBNAIL_SIZE = Math.max(...ATTACHMENT_THUMBNAIL_SIZES);

const IMAGE_TYPES: ReadonlySet<string> = new Set(EMAIL_IMAGE_MIME_TYPES);

export interface ResolveInlineImagesInput {
  readonly scope: OrgScope;
  readonly images: AutomationEmailImages;
  /** The automation whose body assets may be used. */
  readonly automationId: Id<'aut'>;
  /** Schema and access of the person the email is rendered as. */
  readonly schema: AutomationValidationContext;
  /** Trigger table and record (`null` without record: no field image). */
  readonly tableId: Id<'tbl'> | null;
  readonly recordId: string | null;
  /** Reads the trigger record as that person (`triggerRecordCells`). */
  readonly values: Pick<AutomationValueEvaluator, 'triggerRecordCells'>;
}

function fileIdsOf(cell: unknown): string[] {
  if (!Array.isArray(cell)) return [];
  return cell.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const id = (item as { id?: unknown }).id;
    return typeof id === 'string' ? [id] : [];
  });
}

function assetFile(row: EmailAssetRow): InlineImageFile {
  return {
    fileId: row.id,
    cid: inlineImageCid(row.id),
    objectKey: row.object_key,
    size: Number(row.size),
    mime: row.mime,
    filename: row.filename,
    width: row.width,
  };
}

export class InlineImageResolver {
  private readonly assets: EmailAssetsRepository;
  private readonly attachments: AttachmentsRepository;

  /**
   * `storage` reads the thumbnails of field images and `transcode` turns
   * them into JPEG/PNG; without either, field images are left out (warning).
   */
  constructor(
    db: Db,
    private readonly storage: Pick<StorageDriver, 'getStream'> | null,
    private readonly transcode: InlineImageTranscoder | null = null,
  ) {
    this.assets = new EmailAssetsRepository(db);
    this.attachments = new AttachmentsRepository(db);
  }

  async resolve(input: ResolveInlineImagesInput): Promise<InlineImageSet> {
    const set = new InlineImageSet();
    const { body, signature } = input.images;
    if (body.length === 0 && signature.length === 0) return set;

    const assetIds = [...body, ...signature]
      .filter((node) => node.source === 'asset')
      .map((node) => node.id);
    const rows = new Map(
      (await this.assets.getReady(input.scope, assetIds)).map((row) => [row.id as string, row]),
    );
    for (const node of signature) {
      const row = node.source === 'asset' ? rows.get(node.id) : undefined;
      if (row?.kind === 'signature') set.set('signature', node, [assetFile(row)]);
      else set.skip(1);
    }
    const fieldNodes: ImageNode[] = [];
    for (const node of body) {
      if (node.source === 'field') {
        fieldNodes.push(node);
        continue;
      }
      const row = rows.get(node.id);
      if (row?.kind === 'automation' && row.automation_id === input.automationId) {
        set.set('body', node, [assetFile(row)]);
      } else set.skip(1);
    }
    if (fieldNodes.length > 0) await this.fieldImages(input, fieldNodes, set);
    return set;
  }

  /** Images of attachment fields of the trigger record (see the class comment). */
  private async fieldImages(
    input: ResolveInlineImagesInput,
    nodes: readonly ImageNode[],
    set: InlineImageSet,
  ): Promise<void> {
    const { schema, tableId, recordId } = input;
    const table = tableId === null ? undefined : schema.access.tables[tableId];
    const allowed = (fieldId: string): boolean => {
      const field = schema.fields.find((item) => item.id === fieldId);
      return (
        table !== undefined &&
        field !== undefined &&
        field.table_id === tableId &&
        field.type === ATTACHMENT_FIELD_TYPE &&
        table.fields[field.id] !== undefined &&
        table.file_download_fields.includes(field.id)
      );
    };
    const fieldIds = [...new Set(nodes.map((node) => node.id))].filter(allowed);
    const cells =
      fieldIds.length === 0 || recordId === null
        ? null
        : await input.values.triggerRecordCells(fieldIds);
    const ids = fieldIds.flatMap((fieldId) => fileIdsOf(cells?.[fieldId]));
    const attachmentRows = new Map(
      (await this.attachments.getByIds(input.scope, ids)).map((row) => [row.id as string, row]),
    );
    const resolved = new Map<string, InlineImageFile[]>();
    for (const fieldId of new Set(nodes.map((node) => node.id))) {
      if (cells === null || !fieldIds.includes(fieldId)) {
        // Not readable/downloadable now, or no record: the field's images are left out.
        set.skip(1, fieldId);
        resolved.set(fieldId, []);
        continue;
      }
      const files: InlineImageFile[] = [];
      let skipped = 0;
      for (const id of fileIdsOf(cells[fieldId])) {
        const row = attachmentRows.get(id);
        if (row !== undefined && !IMAGE_TYPES.has(row.mime)) continue;
        const file = row === undefined ? null : await this.fieldFile(row, fieldId, recordId);
        if (file === null) skipped += 1;
        else files.push(file);
      }
      set.skip(skipped, fieldId);
      resolved.set(fieldId, files);
    }
    for (const node of nodes) set.set('body', node, resolved.get(node.id) ?? []);
  }

  /** The thumbnail of a usable image file, or `null` (not ready, no thumbnail, too large). */
  private async fieldFile(
    row: AttachmentRow,
    fieldId: string,
    recordId: string | null,
  ): Promise<InlineImageFile | null> {
    const usable =
      row.status === 'ready' &&
      row.field_id === fieldId &&
      row.record_id === recordId &&
      row.detached_at === null &&
      row.record_purged_at === null &&
      row.thumbnail_status === 'ready';
    if (!usable || this.storage === null || this.transcode === null) return null;
    const key = attachmentThumbnailKey(row.object_key, FIELD_IMAGE_THUMBNAIL_SIZE);
    const stream = await this.storage.getStream(key);
    const thumbnail =
      stream === null ? null : await readAtMost(stream, EMAIL_INLINE_IMAGE_MAX_BYTES);
    if (thumbnail === null || thumbnail.length === 0) return null;
    // WebP → JPEG/PNG: Outlook for Windows renders no WebP.
    const image = await this.transcode(thumbnail);
    if (image === null || image.data.length === 0) return null;
    if (image.data.length > EMAIL_INLINE_IMAGE_MAX_BYTES) return null;
    const extension = image.mime === 'image/png' ? 'png' : 'jpg';
    return {
      fileId: row.id,
      cid: inlineImageCid(row.id),
      // The preview shows the thumbnail itself; the email sends `content`.
      objectKey: key,
      size: image.data.length,
      mime: image.mime,
      filename: `${row.id}.${extension}`,
      width: null,
      content: image.data,
    };
  }
}

/** At most `limit` bytes of `stream`; `null` when it holds more (the rest is never read). */
async function readAtMost(stream: Readable, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += bytes.length;
    if (total > limit) {
      stream.destroy();
      return null;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}
