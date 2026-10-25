import { Buffer } from 'node:buffer';

import { MAX_FORM_SUBMISSION_BYTES } from '@cellhive/contracts';
import { AppError } from '@cellhive/server-core/errors';

import type { FastifyRequest } from 'fastify';

/**
 * `413 PAYLOAD_TOO_LARGE` for a submission body over
 * `MAX_FORM_SUBMISSION_BYTES` (256 KiB), well below the generic 10 MiB
 * JSON limit: by `Content-Length` when sent, else by the size of the parsed
 * body.
 */
export function assertFormBodySize(request: FastifyRequest): void {
  const header = Number(request.headers['content-length']);
  const size = Number.isFinite(header)
    ? header
    : Buffer.byteLength(JSON.stringify(request.body ?? null), 'utf8');
  if (size > MAX_FORM_SUBMISSION_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', {
      detail: `A form submission is at most ${String(MAX_FORM_SUBMISSION_BYTES)} bytes.`,
    });
  }
}
