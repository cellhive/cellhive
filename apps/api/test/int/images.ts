import { Buffer } from 'node:buffer';
import { crc32, deflateSync } from 'node:zlib';

import { createFileThumbnailTask } from '@cellhive/worker';
import { pino } from 'pino';

import type { Id } from '@cellhive/contracts';
import type { Db, StorageDriver } from '@cellhive/server-core';

/** A real `width` × `height` grey PNG (thumbnails must decode it). */
export function realPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let row = 0; row < height; row += 1) rows[row * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Runs the worker's `file.thumbnail` job (T407) of `attachmentId` against `storage`. */
export async function renderThumbnail(
  db: Db,
  storage: StorageDriver,
  organizationId: Id<'org'>,
  attachmentId: string,
): Promise<void> {
  const task = createFileThumbnailTask({ db, storage, logger: pino({ level: 'silent' }) });
  const payload = { organization_id: organizationId, attachment_id: attachmentId as Id<'att'> };
  await task(payload, {
    job: {
      id: '1',
      task_identifier: 'file.thumbnail',
      payload,
      priority: 0,
      attempts: 1,
      max_attempts: 3,
      key: null,
      flags: null,
      job_queue_id: null,
    },
    getQueueName: () => Promise.resolve(null),
  } as unknown as Parameters<typeof task>[1]);
}
