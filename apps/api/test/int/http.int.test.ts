import { readFile } from 'node:fs/promises';

import { isId, problemDetailsSchema } from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { problemOf, startTestApp, type TestApp } from './support.js';

describe('HTTP pipeline', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp({ CORS_ORIGINS: 'https://cellhive.test,http://localhost:5173' });
  });

  afterAll(async () => {
    await t.close();
  });

  describe('request id', () => {
    it('generates req_… for every response and never echoes the client header', async () => {
      const response = await t.app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-request-id': 'client-chosen-id-42' },
      });
      expect(response.statusCode).toBe(200);
      const requestId = response.headers['x-request-id'];
      expect(isId('req', requestId)).toBe(true);
      expect(requestId).not.toBe('client-chosen-id-42');

      const second = await t.app.inject({ method: 'GET', url: '/healthz' });
      expect(second.headers['x-request-id']).not.toBe(requestId);
    });

    it('logs the server id as request_id and the client header as client_request_id', async () => {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/v1/__test/log',
        headers: { 'x-request-id': 'trace-abc' },
      });
      const requestId = response.headers['x-request-id'];
      const lines = t.logs.lines.filter((line) => line.request_id === requestId);
      const probe = lines.find((line) => line.msg === 'probe log line');
      expect(probe).toMatchObject({ request_id: requestId, client_request_id: 'trace-abc' });
      expect(lines.find((line) => line.msg === 'request completed')).toMatchObject({
        method: 'GET',
        path: '/api/v1/__test/log',
        route: '/api/v1/__test/log',
        status_code: 200,
        client_request_id: 'trace-abc',
      });
    });

    it('never logs invitation or reset tokens from the path', async () => {
      const token = 'Tok_en-0123456789abcdefghijklmnopqrstuvwxyz';
      const requests = [
        { method: 'GET' as const, url: `/api/v1/invitations/${token}` },
        { method: 'POST' as const, url: `/api/v1/invitations/${token}/accept`, payload: {} },
        {
          method: 'POST' as const,
          url: `/api/v1/auth/password-reset/${token}`,
          payload: { password: 'Some-Password-123' },
        },
        { method: 'GET' as const, url: `/api/v1/invitations/${token}/unknown-route` },
      ];
      const ids: unknown[] = [];
      for (const request of requests) {
        const response = await t.app.inject({ ...request, remoteAddress: '198.51.100.77' });
        ids.push(response.headers['x-request-id']);
      }
      expect(t.logs.raw()).not.toContain(token);
      const completed = t.logs.lines.filter(
        (line) => ids.includes(line.request_id) && line.msg === 'request completed',
      );
      expect(completed.map((line) => [line.route, line.path])).toEqual([
        ['/api/v1/invitations/:token', '/api/v1/invitations/[REDACTED]'],
        ['/api/v1/invitations/:token/accept', '/api/v1/invitations/[REDACTED]/accept'],
        ['/api/v1/auth/password-reset/:token', '/api/v1/auth/password-reset/[REDACTED]'],
        [null, '/api/v1/invitations/[REDACTED]/unknown-route'],
      ]);
    });

    it('puts the same request_id in problem documents', async () => {
      const response = await t.app.inject({ method: 'GET', url: '/api/v1/nope' });
      expect(problemOf(response.body).request_id).toBe(response.headers['x-request-id']);
    });
  });

  describe('problem+json errors', () => {
    it('422 VALIDATION_FAILED with errors[].path for an invalid body', async () => {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/__test/echo',
        payload: { records: [{ fields: { ok: 1 } }, { fields: { Amount: 'ten' } }], extra: true },
      });
      expect(response.statusCode).toBe(422);
      expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
      const problem = problemOf(response.body);
      expect(problemDetailsSchema.safeParse(problem).success).toBe(true);
      expect(problem).toMatchObject({
        type: 'https://cellhive.io/errors/VALIDATION_FAILED',
        title: 'Validation failed',
        status: 422,
        code: 'VALIDATION_FAILED',
      });
      expect(problem.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'name', code: 'REQUIRED' }),
          expect.objectContaining({ path: 'records[1].fields.Amount', code: 'EXPECTED_NUMBER' }),
          expect.objectContaining({ path: 'extra', code: 'UNRECOGNIZED_KEY' }),
        ]),
      );
      expect(response.body).not.toContain('ten');
    });

    it('passes a valid body through the pipe', async () => {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/__test/echo',
        payload: { name: 'x', records: [{ fields: { a: 1 } }] },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ received_records: 1 });
    });

    it('500 INTERNAL for an unknown error without message or stack, logged server-side', async () => {
      const response = await t.app.inject({ method: 'GET', url: '/api/v1/__test/boom' });
      expect(response.statusCode).toBe(500);
      const problem = problemOf(response.body);
      expect(Object.keys(problem).sort()).toEqual([
        'code',
        'request_id',
        'status',
        'title',
        'type',
      ]);
      expect(problem.code).toBe('INTERNAL');
      expect(response.body).not.toMatch(/hunter2|secret|\.ts|at /);

      const logged = t.logs.lines.find(
        (line) => line.request_id === response.headers['x-request-id'] && line.level === 'error',
      );
      expect(JSON.stringify(logged)).toContain('hunter2');
      expect((logged?.err as { stack?: string } | undefined)?.stack).toContain('boom');
    });

    it('AppError keeps its code and detail but never params', async () => {
      const response = await t.app.inject({ method: 'GET', url: '/api/v1/__test/app-error' });
      expect(response.statusCode).toBe(409);
      expect(problemOf(response.body)).toMatchObject({
        code: 'SETUP_COMPLETED',
        detail: 'Already set up.',
      });
      expect(response.body).not.toContain('hidden');
    });

    it('400 MALFORMED_JSON for a body that is not JSON', async () => {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/__test/echo',
        headers: { 'content-type': 'application/json' },
        payload: '{"name": ',
      });
      expect(response.statusCode).toBe(400);
      expect(problemOf(response.body)).toMatchObject({ code: 'MALFORMED_JSON', status: 400 });
    });

    it('400 MALFORMED_JSON for JSON prototype poisoning', async () => {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/__test/echo',
        headers: { 'content-type': 'application/json' },
        payload: '{"name":"x","records":[],"__proto__":{"admin":true}}',
      });
      expect(response.statusCode).toBe(400);
      expect(problemOf(response.body).code).toBe('MALFORMED_JSON');
    });

    it('415 UNSUPPORTED_MEDIA_TYPE for an unsupported Content-Type', async () => {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/__test/echo',
        headers: { 'content-type': 'application/xml' },
        payload: '<a/>',
      });
      expect(response.statusCode).toBe(415);
      const problem = problemOf(response.body);
      expect(problemDetailsSchema.safeParse(problem).success).toBe(true);
      expect(problem).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 });
    });

    it('413 PAYLOAD_TOO_LARGE for a body over the limit', async () => {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/v1/__test/echo',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'x'.repeat(11 * 1024 * 1024), records: [] }),
      });
      expect(response.statusCode).toBe(413);
      expect(problemOf(response.body)).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413 });
    });

    it('404 NOT_FOUND for an unknown route', async () => {
      const response = await t.app.inject({ method: 'DELETE', url: '/api/v1/does-not-exist' });
      expect(response.statusCode).toBe(404);
      const problem = problemOf(response.body);
      expect(problemDetailsSchema.safeParse(problem).success).toBe(true);
      expect(problem.code).toBe('NOT_FOUND');
    });

    it('serves probes outside the /api/v1 prefix only', async () => {
      expect((await t.app.inject({ method: 'GET', url: '/api/v1/healthz' })).statusCode).toBe(404);
    });
  });

  describe('logging', () => {
    it('never logs request bodies, query strings or credentials', async () => {
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/__test/echo?token=query-secret',
        headers: {
          authorization: 'Bearer header-secret-token',
          cookie: 'session=cookie-secret',
        },
        payload: { name: 'body-secret-value', records: [] },
      });
      const raw = t.logs.raw();
      expect(raw).not.toContain('header-secret-token');
      expect(raw).not.toContain('cookie-secret');
      expect(raw).not.toContain('body-secret-value');
      expect(raw).not.toContain('query-secret');
    });
  });

  describe('security headers and CORS', () => {
    it('sets helmet headers', async () => {
      const response = await t.app.inject({ method: 'GET', url: '/healthz' });
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['strict-transport-security']).toBeDefined();
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('allows configured origins with credentials and exposes X-Request-Id', async () => {
      const response = await t.app.inject({
        method: 'OPTIONS',
        url: '/api/v1/__test/echo',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(response.headers['access-control-allow-credentials']).toBe('true');

      const simple = await t.app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { origin: 'https://cellhive.test' },
      });
      expect(simple.headers['access-control-expose-headers']).toContain('x-request-id');
    });

    it('does not allow other origins', async () => {
      const response = await t.app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { origin: 'https://evil.example' },
      });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('GET /api/v1/openapi.json', () => {
    it('serves the committed OpenAPI document without a session', async () => {
      const response = await t.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      const committed = await readFile(
        new URL('../../../../packages/contracts/openapi.json', import.meta.url),
        'utf8',
      );
      expect(response.body).toBe(committed);
      expect(response.json<{ openapi: string }>().openapi).toBe('3.1.0');
    });
  });
});
