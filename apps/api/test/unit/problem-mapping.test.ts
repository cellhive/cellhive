import { AppError } from '@cellhive/server-core/errors';
import {
  BadRequestException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { isAbortError, resolveProblem } from '../../src/common/errors/problem-mapping.js';

function fastifyError(code: string, statusCode: number): Error {
  return Object.assign(new Error(`${code} message`), { code, statusCode, name: 'FastifyError' });
}

describe('resolveProblem', () => {
  const cases: { name: string; error: unknown; code: string; unexpected: boolean }[] = [
    {
      name: 'AppError 4xx',
      error: new AppError('NAME_CONFLICT'),
      code: 'NAME_CONFLICT',
      unexpected: false,
    },
    {
      name: 'AppError 5xx',
      error: new AppError('DEPENDENCY_UNAVAILABLE'),
      code: 'DEPENDENCY_UNAVAILABLE',
      unexpected: true,
    },
    { name: 'Nest 404', error: new NotFoundException(), code: 'NOT_FOUND', unexpected: false },
    {
      name: 'value too long for a unique B-tree index',
      error: Object.assign(
        new Error('index row size 6016 exceeds btree version 4 maximum 2704 for index "t_c_uniq"'),
        { code: '54000' },
      ),
      code: 'INVALID_CELL_VALUE',
      unexpected: false,
    },
    {
      name: 'another program limit',
      error: Object.assign(new Error('target lists can have at most 1664 entries'), {
        code: '54000',
      }),
      code: 'INTERNAL',
      unexpected: true,
    },
    {
      name: 'Nest 413',
      error: new PayloadTooLargeException(),
      code: 'PAYLOAD_TOO_LARGE',
      unexpected: false,
    },
    {
      name: 'Nest 400',
      error: new BadRequestException(),
      code: 'VALIDATION_FAILED',
      unexpected: false,
    },
    {
      name: 'Nest 418',
      error: new HttpException('teapot', 418),
      code: 'INTERNAL',
      unexpected: true,
    },
    {
      name: 'invalid JSON',
      error: fastifyError('FST_ERR_CTP_INVALID_JSON_BODY', 400),
      code: 'MALFORMED_JSON',
      unexpected: false,
    },
    {
      name: 'empty JSON',
      error: fastifyError('FST_ERR_CTP_EMPTY_JSON_BODY', 400),
      code: 'MALFORMED_JSON',
      unexpected: false,
    },
    {
      name: 'unsupported media type',
      error: fastifyError('FST_ERR_CTP_INVALID_MEDIA_TYPE', 415),
      code: 'UNSUPPORTED_MEDIA_TYPE',
      unexpected: false,
    },
    {
      name: 'body too large',
      error: fastifyError('FST_ERR_CTP_BODY_TOO_LARGE', 413),
      code: 'PAYLOAD_TOO_LARGE',
      unexpected: false,
    },
    {
      name: 'other Fastify 404',
      error: fastifyError('FST_ERR_NOT_FOUND', 404),
      code: 'NOT_FOUND',
      unexpected: false,
    },
    {
      name: 'aborted body stream',
      error: Object.assign(new Error('aborted'), { statusCode: 400 }),
      code: 'MALFORMED_JSON',
      unexpected: false,
    },
    {
      name: 'PostgreSQL statement timeout',
      error: Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      }),
      code: 'QUERY_TIMEOUT',
      unexpected: true,
    },
    {
      name: 'PostgreSQL cancel by user request',
      error: Object.assign(new Error('canceling statement due to user request'), {
        code: '57014',
      }),
      code: 'INTERNAL',
      unexpected: true,
    },
    { name: 'plain Error', error: new Error('boom'), code: 'INTERNAL', unexpected: true },
    { name: 'thrown string', error: 'boom', code: 'INTERNAL', unexpected: true },
    { name: 'null', error: null, code: 'INTERNAL', unexpected: true },
    {
      name: 'error claiming status 500',
      error: Object.assign(new Error('x'), { statusCode: 500 }),
      code: 'INTERNAL',
      unexpected: true,
    },
  ];

  it.each(cases)('$name → $code', ({ error, code, unexpected }) => {
    const resolved = resolveProblem(error);
    expect(resolved.code).toBe(code);
    expect(resolved.unexpected).toBe(unexpected);
  });

  it('carries Retry-After of an AppError', () => {
    expect(resolveProblem(new AppError('RATE_LIMITED', { retryAfterSeconds: 30 }))).toEqual({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 30,
      unexpected: false,
    });
  });

  it('keeps detail and errors of an AppError only', () => {
    const errors = [{ path: 'name', code: 'REQUIRED', message: 'Required' }];
    expect(resolveProblem(new AppError('VALIDATION_FAILED', { detail: 'd', errors }))).toEqual({
      code: 'VALIDATION_FAILED',
      detail: 'd',
      errors,
      unexpected: false,
    });
    expect(resolveProblem(new Error('secret message'))).toEqual({
      code: 'INTERNAL',
      unexpected: true,
    });
    expect(
      JSON.stringify(resolveProblem(new NotFoundException('Cannot GET /secret'))),
    ).not.toContain('secret');
  });

  it('treats a body read cut by the client (cancelled upload) as an abort, not INTERNAL', () => {
    const reset = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    const premature = Object.assign(new Error('Premature close'), {
      code: 'ERR_STREAM_PREMATURE_CLOSE',
    });
    for (const error of [reset, premature, new Error('aborted')]) {
      expect(isAbortError(error)).toBe(true);
      expect(resolveProblem(error, { clientGone: true })).toMatchObject({
        clientAborted: true,
        unexpected: false,
      });
    }
    // The same code on an outgoing connection while the client is still there is ours.
    expect(resolveProblem(reset, { clientGone: false })).toEqual({
      code: 'INTERNAL',
      unexpected: true,
    });
    expect(resolveProblem(reset)).toMatchObject({ code: 'INTERNAL' });
    // Other failures of a request whose client left keep their mapping.
    expect(resolveProblem(new AppError('NOT_FOUND'), { clientGone: true })).toEqual({
      code: 'NOT_FOUND',
      unexpected: false,
    });
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
