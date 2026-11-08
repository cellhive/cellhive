import { Readable } from 'node:stream';

import {
  EMAIL_IMAGE_MAX_DIMENSION,
  EMAIL_IMAGE_MIME_TYPES,
  EMAIL_INLINE_IMAGE_MAX_BYTES,
  FORM_COVER_MAX_BYTES,
  FORM_COVER_MIME_TYPES,
  type Id,
} from '@cellhive/contracts';
import { normalizeMimeType } from '@cellhive/field-types';

import { SNIFF_BYTES, contentContradictsType } from '../../records/attachments/content-sniff.js';
import { sanitizeFilename } from '../../storage/content-disposition.js';
import { packageProblem } from '../errors.js';

import { reportSkippedFile } from './report.js';

import type { ImportFileDecision } from './files.js';
import type { BaseImportContext } from './pipeline.js';
import type { PlannedFile } from './plan.js';
import type { ImportedView } from './views.js';
import type { BasePackageReader } from '../reader.js';

/**
 * Form covers and email images of a `.chbase` import (T1019, ADR-24
 * amendment §1): files of their own (`meta.form_covers`,
 * `meta.email_assets`), not cell values. Each is checked the way its upload
 * is accepted — a raster image (PNG, JPEG, GIF, WebP) whose first bytes are
 * of its type, within its cap (`FORM_COVER_MAX_BYTES`,
 * `EMAIL_INLINE_IMAGE_MAX_BYTES`) — and stored under the id the import gave
 * it in `{org}/{att}`, its row first (a purge always knows it). One that
 * does not pass is left out and listed in `files_skipped`: the form shows
 * no cover, the email step names an image that is not there (turning the
 * automation on says so). An email image the package gives no pixel size
 * (1…1280) is `INVALID_ENTRY`: an export always writes it.
 */

/** A form cover or email image accepted, read into memory (both are small). */
export interface AcceptedImage {
  readonly file: PlannedFile;
  readonly filename: string;
  readonly mime: string;
  readonly content: Buffer;
}

/** The check of one cover or email image (like `checkImportedFile` for cells). */
export function checkImportedImage(input: {
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly head: Uint8Array;
  readonly maxBytes: number;
  readonly types: readonly string[];
}): ImportFileDecision {
  const filename = sanitizeFilename(input.filename).slice(0, 255);
  const mime = normalizeMimeType(input.mime) ?? 'application/octet-stream';
  if (!input.types.includes(mime)) return { ok: false, reason: 'blocked_file_type', filename };
  if (input.size > input.maxBytes) return { ok: false, reason: 'file_too_large', filename };
  if (input.head.length === 0 || contentContradictsType(mime, input.head)) {
    return { ok: false, reason: 'content_mismatch', filename };
  }
  return { ok: true, filename, mime };
}

/** The whole content of an entry (checked against the manifest by the reader). */
async function contentOf(reader: BasePackageReader, entry: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of (await reader.open(entry)) as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Checks the files of one kind; those that pass are read, the others reported. */
async function accepted(
  context: BaseImportContext,
  files: readonly PlannedFile[],
  maxBytes: number,
  types: readonly string[],
): Promise<AcceptedImage[]> {
  const out: AcceptedImage[] = [];
  for (const file of files) {
    await context.target.checkpoint();
    // Over the cap: the content is never read.
    const content =
      file.size > maxBytes ? Buffer.alloc(0) : await contentOf(context.reader, file.entry);
    const decision = checkImportedImage({
      filename: file.source.filename,
      mime: file.source.mime,
      size: file.size,
      head: content.subarray(0, SNIFF_BYTES),
      maxBytes,
      types,
    });
    if (!decision.ok) {
      reportSkippedFile(context.report, decision.filename, decision.reason);
      continue;
    }
    out.push({ file, filename: decision.filename, mime: decision.mime, content });
  }
  return out;
}

/** The covers of the package that pass their check, by their id in the new base. */
export async function checkFormCovers(
  context: BaseImportContext,
): Promise<ReadonlyMap<string, AcceptedImage>> {
  const covers = await accepted(
    context,
    context.plan.deferred.formCovers,
    FORM_COVER_MAX_BYTES,
    FORM_COVER_MIME_TYPES,
  );
  return new Map(covers.map((cover) => [cover.file.id as string, cover]));
}

/** Stores the accepted covers named by a form view the import created (new ids). */
export async function storeFormCovers(
  context: BaseImportContext,
  covers: ReadonlyMap<string, AcceptedImage>,
  views: ReadonlyMap<string, ImportedView>,
  tick: () => Promise<void>,
): Promise<void> {
  const { plan, baseId, target, report } = context;
  for (const [viewId, view] of views) {
    const cover = view.coverId === null ? undefined : covers.get(view.coverId);
    if (cover === undefined || cover.file.source.kind !== 'form_cover') continue;
    if (plan.ids.resolve(cover.file.source.view_id) !== viewId) continue;
    await target.checkpoint();
    await target.storeFormCover(
      baseId,
      {
        id: cover.file.id,
        tableId: view.tableId,
        viewId: viewId as Id<'viw'>,
        filename: cover.filename,
        mime: cover.mime,
        size: cover.file.size,
        sha256: cover.file.sha256,
      },
      Readable.from([cover.content]),
    );
    report.attachments += 1;
    await tick();
  }
}

/** Stores the accepted email images of the automations the import created (new ids). */
export async function storeEmailAssets(
  context: BaseImportContext,
  automations: ReadonlySet<string>,
  tick: () => Promise<void>,
): Promise<void> {
  const { plan, baseId, target, report } = context;
  for (const file of plan.deferred.emailAssets) {
    const source = file.source;
    if (source.kind !== 'email_asset') continue;
    const valid = (value: number | null) =>
      value !== null && value >= 1 && value <= EMAIL_IMAGE_MAX_DIMENSION;
    if (!valid(source.width) || !valid(source.height)) {
      throw packageProblem(
        'INVALID_ENTRY',
        file.location.at(valid(source.width) ? 'height' : 'width').toString(),
        'An email image has no valid size in pixels.',
      );
    }
  }
  const images = await accepted(
    context,
    plan.deferred.emailAssets,
    EMAIL_INLINE_IMAGE_MAX_BYTES,
    EMAIL_IMAGE_MIME_TYPES,
  );
  for (const image of images) {
    const source = image.file.source;
    if (source.kind !== 'email_asset') continue;
    const automationId = plan.ids.resolve(source.automation_id);
    if (automationId === null || !automations.has(automationId)) continue;
    await target.checkpoint();
    await target.storeEmailAsset(
      baseId,
      {
        id: image.file.id,
        automationId: automationId as Id<'aut'>,
        filename: image.filename,
        mime: image.mime,
        size: image.file.size,
        sha256: image.file.sha256,
        width: source.width ?? 1,
        height: source.height ?? 1,
      },
      Readable.from([image.content]),
    );
    report.attachments += 1;
    await tick();
  }
}
