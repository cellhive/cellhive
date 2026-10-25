import { isId, newId, PROBLEM_CONTENT_TYPE, type Id } from '@cellhive/contracts';
import { buildProblem } from '@cellhive/server-core/errors';
import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';

import { resolveProblem } from './problem-mapping.js';

import type { AppLogger } from '../logging/app-logger.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Whether the client closed the connection of `request` (its socket is gone). */
function clientGone(request: FastifyRequest, reply: FastifyReply): boolean {
  const raw = request.raw as FastifyRequest['raw'] | undefined;
  return (
    raw?.socket.destroyed === true ||
    (raw as { aborted?: boolean } | undefined)?.aborted === true ||
    reply.raw.destroyed
  );
}

/**
 * Global exception filter: every error leaves the API as
 * `application/problem+json` (RFC 9457, CONTRACTS §6). Also receives Fastify
 * errors (body parsing, size limit) and unknown routes, which Nest forwards
 * to global filters.
 */
@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const requestId: Id<'req'> = isId('req', request.id) ? request.id : newId('req');
    const resolved = resolveProblem(exception, { clientGone: clientGone(request, reply) });
    const log = request.log as FastifyRequest['log'] | undefined;

    if (resolved.clientAborted === true) {
      // A cancelled upload (the browser aborted its PUT): expected, no stack.
      (log ?? this.logger.pino).info(
        { code: (exception as { code?: unknown } | null)?.code },
        'request aborted by the client',
      );
      reply.raw.destroy();
      return;
    }
    if (resolved.unexpected) {
      // The stack stays in the logs; the client only sees `INTERNAL`.
      (log ?? this.logger.pino).error({ err: exception, code: resolved.code }, 'request failed');
    } else {
      (log ?? this.logger.pino).debug({ code: resolved.code }, 'request rejected');
    }

    if (reply.sent) {
      // Headers are already out (e.g. a streamed download failed midway).
      reply.raw.destroy();
      return;
    }

    const problem = buildProblem(resolved.code, requestId, {
      detail: resolved.detail,
      errors: resolved.errors,
    });
    if (resolved.retryAfterSeconds !== undefined) {
      void reply.header('retry-after', String(resolved.retryAfterSeconds));
    }
    void reply
      .status(problem.status)
      .header('content-type', `${PROBLEM_CONTENT_TYPE}; charset=utf-8`)
      .send(JSON.stringify(problem));
  }
}
