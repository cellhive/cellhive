import { Buffer } from 'node:buffer';

import type { Readable } from 'node:stream';

export type LimitedBody =
  | { readonly ok: true; readonly body: Buffer }
  | { readonly ok: false; readonly reason: 'too_large' };

/**
 * Reads a request body of at most `limit` bytes (BACKLOG T603: `413` past
 * 1 MiB, "stop reading at once"). As soon as one byte more than `limit`
 * arrived the stream is paused and left: nothing more is pulled, so at
 * most `limit` + one chunk (≤ the 64 KiB stream buffer) is ever read. The
 * caller answers `413` with `Connection: close` so the rest of the body is
 * never consumed. Rejects when the stream fails or the client goes away
 * before the end.
 */
export function readLimitedBody(stream: Readable, limit: number): Promise<LimitedBody> {
  if (stream.readableEnded) return Promise.resolve({ ok: true, body: Buffer.alloc(0) });
  return new Promise<LimitedBody>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += buffer.length;
      if (size > limit) {
        cleanup();
        stream.pause();
        chunks.length = 0;
        resolve({ ok: false, reason: 'too_large' });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      resolve({ ok: true, body: Buffer.concat(chunks, size) });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('close', onClose);
    stream.resume();
  });
}
