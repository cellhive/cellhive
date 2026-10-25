import { Buffer } from 'node:buffer';
import { crc32, deflateSync } from 'node:zlib';

import { attachmentHasThumbnail, type Id } from '@cellhive/contracts';
import {
  AttachmentsRepository,
  checkUploadedObject,
  enqueue,
  withTxScope,
  type Db,
  type OrgScope,
  type StorageDriver,
} from '@cellhive/server-core';

import { FILE_THUMBNAIL_MAX_ATTEMPTS } from '../modules/file/file.service.js';

import { SeedError } from './seed-error.js';

/**
 * Tiny sample files for `pnpm seed:demo` (BACKLOG T412): generated in code
 * (never checked in as binaries), so the seed stays reproducible and works
 * the same with `STORAGE_DRIVER=local` and with Garage. Real bytes (not
 * placeholders) so the same content-sniff check `FileService.complete` runs
 * on real uploads also accepts them.
 */

/** An RGB color, 0–255 per channel. */
type Rgb = readonly [number, number, number];

/** A PNG chunk: length, type, data, CRC-32 of type + data. */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A small sample picture (T421b: the 1×1 transparent pixel of T412 showed
 * as a black box on kanban covers): an 8-bit RGB PNG of a diagonal gradient
 * from `from` to `to`, with a light sun and a darker hill band so it reads as
 * a photo placeholder at thumbnail size. Encoded here (zlib + CRC-32 of
 * Node), no image library.
 */
export function samplePicture(width: number, height: number, from: Rgb, to: Rgb): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  const sun = { x: width * 0.72, y: height * 0.32, r: Math.min(width, height) * 0.16 };
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2;
      let rgb = from.map((start, i) => start + ((to[i] ?? 0) - start) * t);
      const hill = height * (0.72 + 0.08 * Math.sin((x / width) * Math.PI * 2));
      if (y > hill) rgb = rgb.map((value) => value * 0.62);
      if ((x - sun.x) ** 2 + (y - sun.y) ** 2 <= sun.r ** 2) rgb = [255, 244, 214];
      const at = y * stride + 1 + x * 3;
      raw[at] = Math.round(rgb[0] ?? 0);
      raw[at + 1] = Math.round(rgb[1] ?? 0);
      raw[at + 2] = Math.round(rgb[2] ?? 0);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function samplePdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const body = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]' +
      '/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj',
    '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    `5 0 obj<</Length ${String(stream.length)}>>stream`,
    stream,
    'endstream',
    'endobj',
    'trailer<</Root 1 0 R/Size 6>>',
    '%%EOF',
    '',
  ].join('\n');
  return Buffer.from(body, 'latin1');
}

export interface SampleFile {
  readonly filename: string;
  readonly mime: string;
  readonly bytes: Buffer;
}

/** A handful of small sample files (BACKLOG T412): two images, one PDF. */
export function sampleFiles(): readonly SampleFile[] {
  return [
    {
      filename: 'anh-hien-truong-1.png',
      mime: 'image/png',
      // Teal sky to sand: the accent family of the UI.
      bytes: samplePicture(320, 200, [15, 118, 110], [236, 214, 160]),
    },
    {
      filename: 'anh-hien-truong-2.png',
      mime: 'image/png',
      bytes: samplePicture(320, 200, [67, 56, 202], [249, 168, 112]),
    },
    {
      filename: 'bien-ban-ban-giao.pdf',
      mime: 'application/pdf',
      bytes: samplePdf('Cellhive demo'),
    },
  ];
}

export interface CreateSampleAttachmentInput {
  readonly baseId: Id<'bse'>;
  readonly tableId: Id<'tbl'>;
  readonly fieldId: Id<'fld'>;
  readonly ownerId: Id<'usr'>;
  readonly file: SampleFile;
}

/**
 * Stores one sample file through the storage driver and records it in
 * `meta.attachments` as `ready`, the same state `FileService.complete`
 * leaves a real upload in — but writing the bytes directly (`storage.put`)
 * instead of a presigned `PUT`, since the seed runs in-process. Works with
 * `STORAGE_DRIVER=local` and with Garage (S3 API): both implement `put`,
 * `head` and `getStream` the same way `checkUploadedObject` (also used by
 * real uploads) reads back.
 */
export async function createSampleAttachment(
  db: Db,
  storage: StorageDriver,
  scope: OrgScope,
  input: CreateSampleAttachmentInput,
): Promise<Id<'att'>> {
  const attachments = new AttachmentsRepository(db);
  const row = await attachments.create(scope, {
    baseId: input.baseId,
    tableId: input.tableId,
    fieldId: input.fieldId,
    createdBy: input.ownerId,
    filename: input.file.filename,
    mime: input.file.mime,
    size: input.file.bytes.length,
  });
  await storage.put(row.object_key, input.file.bytes, { contentType: input.file.mime });
  const checked = await checkUploadedObject(storage, row.object_key, {
    size: input.file.bytes.length,
    mime: input.file.mime,
    blockNativeExecutables: true,
  });
  if (!checked.ok) {
    throw new SeedError(`sample attachment ${input.file.filename} failed its own upload check`);
  }
  // T421b: images get their thumbnail job like a real upload (same transaction);
  // the worker renders it once it runs (`pnpm dev`), not during the seed itself.
  const thumbnail = attachmentHasThumbnail(input.file.mime, checked.size);
  const ready = await db.withTx(async (tx) => {
    const marked = await attachments.markReady(withTxScope(scope, tx), row.id, {
      size: checked.size,
      sha256: checked.sha256,
      thumbnailStatus: thumbnail ? 'pending' : null,
    });
    if (marked !== undefined && thumbnail) {
      await enqueue(
        tx,
        'file.thumbnail',
        { organization_id: scope.organizationId, attachment_id: marked.id },
        { maxAttempts: FILE_THUMBNAIL_MAX_ATTEMPTS, jobKey: `file.thumbnail:${marked.id}` },
      );
    }
    return marked;
  });
  if (ready === undefined) throw new SeedError(`sample attachment ${row.id} vanished`);
  return ready.id;
}
