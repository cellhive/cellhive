import { createWriteStream } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { FILE_REQUIRED } from '@cellhive/contracts';
import { AppError } from '@cellhive/server-core/errors';
import busboy from 'busboy';

import type { Readable } from 'node:stream';

/** A file received from a `multipart/form-data` body, spooled to disk. */
export interface ReceivedFile {
  readonly path: string;
  /** Client file name: base name only, NFC, at most 255 characters. */
  readonly filename: string;
  readonly size: number;
}

const MAX_FILENAME = 255;

/** A client file name made safe for display (never used in paths or storage keys). */
export function safeFilename(name: string | undefined): string {
  const base = basename((name ?? '').replace(/\\/g, '/'))
    .normalize('NFC')
    // Control characters would break logs and headers.
    .replace(/\p{Cc}/gu, '')
    .trim();
  return (base === '' ? 'upload' : base).slice(0, MAX_FILENAME);
}

const tooLarge = (maxBytes: number) =>
  new AppError('PAYLOAD_TOO_LARGE', {
    detail: `The file is larger than ${String(maxBytes / 1024 / 1024)} MB.`,
  });

/**
 * Reads the `file` part of a `multipart/form-data` body into `dir/upload`
 * as it arrives (never the whole file in memory). Other parts are drained
 * and ignored. Not multipart → `415`; more than `maxBytes` → `413`
 * (reading stops); no `file` part → `422 FILE_REQUIRED`.
 */
export async function receiveMultipartFile(
  body: Readable,
  contentType: string | undefined,
  dir: string,
  maxBytes: number,
): Promise<ReceivedFile> {
  if (contentType === undefined || !/^multipart\/form-data\b/i.test(contentType)) {
    body.resume();
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
      detail: 'Send the file as multipart/form-data.',
    });
  }
  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: { 'content-type': contentType },
      limits: { files: 1, fileSize: maxBytes, fields: 20, parts: 30, fieldSize: 1024 },
    });
  } catch {
    body.resume();
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
      detail: 'The multipart/form-data body has no boundary.',
    });
  }
  const path = join(dir, 'upload');
  return new Promise<ReceivedFile>((resolve, reject) => {
    let received: Promise<ReceivedFile> | undefined;
    let failed = false;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      body.unpipe(parser);
      body.resume();
      reject(error instanceof Error ? error : new Error('upload failed'));
    };
    parser.on('file', (name, stream, info) => {
      if (name !== 'file' || received !== undefined) {
        stream.resume();
        return;
      }
      let size = 0;
      let truncated = false;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
      });
      stream.on('limit', () => {
        truncated = true;
        fail(tooLarge(maxBytes));
      });
      received = pipeline(stream, createWriteStream(path, { flags: 'wx', mode: 0o600 })).then(
        () => {
          if (truncated) throw tooLarge(maxBytes);
          return { path, filename: safeFilename(info.filename), size };
        },
      );
      received.catch(fail);
    });
    parser.on('error', () => {
      fail(
        new AppError('VALIDATION_FAILED', {
          detail: 'The multipart/form-data body is malformed.',
          errors: [{ path: 'file', code: 'INVALID_FILE', message: 'Malformed multipart body' }],
        }),
      );
    });
    parser.on('close', () => {
      if (failed) return;
      if (received === undefined) {
        fail(
          new AppError('VALIDATION_FAILED', {
            detail: 'The request has no file.',
            errors: [{ path: 'file', code: FILE_REQUIRED, message: 'A `file` part is required' }],
          }),
        );
        return;
      }
      received.then(resolve, fail);
    });
    body.on('error', fail);
    body.pipe(parser);
  });
}
