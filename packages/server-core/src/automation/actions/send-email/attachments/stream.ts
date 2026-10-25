import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';

import { sanitizeHeaderText } from '../../../../mail/address.js';

import type { PlannedAttachment } from './plan.js';
import type { InlineImageFile } from '../../../../mail/images/inline-images.js';
import type { MailAttachment } from '../../../../mail/mailer.js';
import type { StorageDriver } from '../../../../storage/storage-driver.js';

/**
 * Files of a `send_email` step as message parts (BACKLOG T532): each one a
 * stream that opens the storage object only when nodemailer starts writing
 * that part, and passes chunks through with back-pressure — a file is never
 * held whole in memory, and a message that is refused before `DATA` opens
 * nothing. A missing object or more bytes than `meta.attachments.size`
 * (the limits were checked on it) fails the stream with a fixed message:
 * nodemailer gives up the message, the step is retried like any temporary
 * failure and reads the files again. Errors never carry the key or the
 * file name.
 */

/** Read failure of an attachment (no key, no file name). */
export class AttachmentReadError extends Error {
  override readonly name = 'AttachmentReadError';
  readonly code = 'EATTACHMENT';
}

class StorageObjectStream extends Readable {
  private source: Readable | null = null;
  private opening = false;
  private bytesRead = 0;

  constructor(
    private readonly open: () => Promise<Readable | null>,
    private readonly expected: number,
  ) {
    super();
  }

  override _read(): void {
    if (this.source !== null) {
      this.source.resume();
      return;
    }
    if (this.opening) return;
    this.opening = true;
    this.open().then(
      (source) => {
        if (this.destroyed) {
          source?.destroy();
          return;
        }
        if (source === null) {
          this.destroy(new AttachmentReadError('An attachment is missing from storage.'));
          return;
        }
        this.source = source;
        source.on('data', (chunk: Buffer) => {
          this.bytesRead += chunk.length;
          if (this.bytesRead > this.expected) {
            this.destroy(new AttachmentReadError('An attachment is larger than recorded.'));
            return;
          }
          if (!this.push(chunk)) source.pause();
        });
        source.once('end', () => {
          this.push(null);
        });
        source.once('error', () => {
          this.destroy(new AttachmentReadError('An attachment could not be read.'));
        });
      },
      () => {
        this.destroy(new AttachmentReadError('An attachment could not be read.'));
      },
    );
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.source?.destroy();
    this.source = null;
    callback(error);
  }
}

/**
 * The message parts of `files`: name without control characters (encoded
 * per RFC 2231 by nodemailer), the MIME type sniffed at upload, the content
 * streamed from `storage`. Destroy the contents when the message is not
 * sent (`destroyAttachmentParts`).
 */
export function attachmentParts(
  storage: StorageDriver,
  files: readonly PlannedAttachment[],
): MailAttachment[] {
  return files.map((file) => ({
    filename: sanitizeHeaderText(file.filename) || 'file',
    contentType: file.mime,
    content: new StorageObjectStream(() => storage.getStream(file.objectKey), file.size),
  }));
}

/**
 * The inline image parts of an email (BACKLOG T534): each file once, with
 * its Content-ID, streamed from `storage` like attachments (the size was
 * checked against the limits before; a different object fails the send and
 * the step is retried).
 */
export function inlineImageParts(
  storage: StorageDriver,
  files: readonly InlineImageFile[],
): MailAttachment[] {
  return files.map((file) => ({
    filename: sanitizeHeaderText(file.filename) || 'image',
    contentType: file.mime,
    cid: file.cid,
    content:
      file.content === undefined
        ? new StorageObjectStream(() => storage.getStream(file.objectKey), file.size)
        : Readable.from([Buffer.from(file.content)]),
  }));
}

/** Releases the storage streams of parts (opened or not). */
export function destroyAttachmentParts(parts: readonly MailAttachment[]): void {
  for (const part of parts) part.content.destroy();
}
