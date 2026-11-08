import { requestMetaOf } from '../../common/auth/request-meta.js';

import type { AiRequestMeta } from './ai-access.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The reason a request's signal is aborted with when its client went away:
 * an `aborted` error with `ECONNABORTED`, which the problem filter treats
 * as a cancelled request (logged at `info`, no `INTERNAL`).
 */
function clientClosed(): Error {
  return Object.assign(new Error('aborted'), { code: 'ECONNABORTED' });
}

/**
 * A signal aborted once the client closes `reply` before it was sent (the
 * pattern of `sendExport`): an AI request passes it to its provider calls,
 * so a person who gave up does not keep a call — and its concurrency slots —
 * running for up to 90 s.
 */
export function clientAbortSignal(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  if (reply.raw.destroyed) {
    abort.abort(clientClosed());
    return abort.signal;
  }
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) abort.abort(clientClosed());
  });
  return abort.signal;
}

/** {@link requestMetaOf} of an AI route, with {@link clientAbortSignal}. */
export function aiRequestMetaOf(request: FastifyRequest, reply: FastifyReply): AiRequestMeta {
  return { ...requestMetaOf(request), signal: clientAbortSignal(reply) };
}
