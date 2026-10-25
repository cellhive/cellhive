import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { redactedPathOf, sanitizeClientRequestId } from '../../src/common/http/request-hooks.js';
import { createRootLogger } from '../../src/common/logging/root-logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { lines, stream };
}

describe('root logger', () => {
  it('writes JSON with a string level, ISO time and redacted credentials', () => {
    const { lines, stream } = capture();
    const logger = createRootLogger('info', stream);
    logger.info(
      {
        req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1', accept: '*/*' } },
        headers: { 'set-cookie': 'sid=2', 'x-csrf-token': 'csrf' },
      },
      'hello',
    );
    const entry = JSON.parse(lines.join('')) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'info',
      msg: 'hello',
      service: 'cellhive-api',
      req: { headers: { authorization: '[REDACTED]', cookie: '[REDACTED]', accept: '*/*' } },
      headers: { 'set-cookie': '[REDACTED]', 'x-csrf-token': '[REDACTED]' },
    });
    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('QA S5c: never logs the data a PostgreSQL error quotes (detail, hint, where), even as a cause', () => {
    const { lines, stream } = capture();
    const pgError = Object.assign(new Error('new row violates check constraint "x"'), {
      code: '23514',
      detail: 'Failing row contains (whr_1, canary-row-value).',
      hint: 'canary-hint',
      where: 'canary-where',
      table: 'incoming_webhook_requests',
    });
    const wrapped = Object.assign(new Error('wrapped'), { cause: pgError });
    const logger = createRootLogger('info', stream);
    logger.error({ err: pgError }, 'direct');
    logger.error({ err: wrapped }, 'as a cause');
    const raw = lines.join('');
    expect(raw).not.toContain('canary');
    const first = JSON.parse(lines[0] ?? '{}') as { err: Record<string, unknown> };
    expect(first.err).toMatchObject({ code: '23514', table: 'incoming_webhook_requests' });
    expect(first.err['message']).toBe('new row violates check constraint "x"');
  });

  it('honours the level', () => {
    const { lines, stream } = capture();
    createRootLogger('warn', stream).info({}, 'dropped');
    expect(lines).toEqual([]);
  });
});

describe('sanitizeClientRequestId', () => {
  const cases: { input: string | string[] | undefined; expected: string | undefined }[] = [
    { input: undefined, expected: undefined },
    { input: '', expected: undefined },
    { input: 'abc-123', expected: 'abc-123' },
    { input: ['first', 'second'], expected: 'first' },
    { input: 'with space\r\ninjected', expected: 'withspaceinjected' },
    { input: 'x'.repeat(500), expected: 'x'.repeat(128) },
    { input: 'ünïcode', expected: 'ncode' },
  ];
  it.each(cases)('$input → $expected', ({ input, expected }) => {
    expect(sanitizeClientRequestId(input)).toBe(expected);
  });
});

describe('redactedPathOf', () => {
  const token = 'Abc_def-0123456789abcdefghijklmnopqrstuvwxy';
  const cases: { url: string; route: string | undefined; expected: string }[] = [
    {
      url: `/api/v1/invitations/${token}`,
      route: '/api/v1/invitations/:token',
      expected: '/api/v1/invitations/[REDACTED]',
    },
    {
      url: `/api/v1/invitations/${token}/accept?x=1`,
      route: '/api/v1/invitations/:token/accept',
      expected: '/api/v1/invitations/[REDACTED]/accept',
    },
    // Even a short (malformed) token is hidden when the route names it.
    {
      url: '/api/v1/auth/password-reset/short',
      route: '/api/v1/auth/password-reset/:token',
      expected: '/api/v1/auth/password-reset/[REDACTED]',
    },
    // Unmatched routes: token-like segments are hidden.
    {
      url: `/api/v1/invitations/${token}/nope`,
      route: undefined,
      expected: '/api/v1/invitations/[REDACTED]/nope',
    },
    {
      url: '/api/v1/orgs/org_0123456789abcdef/members/usr_0123456789abcdef',
      route: '/api/v1/orgs/:orgId/members/:userId',
      expected: '/api/v1/orgs/org_0123456789abcdef/members/usr_0123456789abcdef',
    },
    { url: '/healthz?token=x', route: '/healthz', expected: '/healthz' },
    // T406: storage keys of signed local URLs are never logged.
    {
      url: '/api/v1/storage/local/org_0123456789abcdef/att_0123456789abcdef?exp=1&sig=x',
      route: '/api/v1/storage/local/*',
      expected: '/api/v1/storage/local/[REDACTED]',
    },
  ];
  it.each(cases)('$url → $expected', ({ url, route, expected }) => {
    expect(redactedPathOf(url, route)).toBe(expected);
  });
});
