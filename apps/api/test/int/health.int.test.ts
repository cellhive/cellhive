import { problemDetailsSchema } from '@cellhive/contracts';
import { readinessResponseSchema } from '@cellhive/contracts/openapi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startValkey } from './global-setup.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { StartedTestContainer } from 'testcontainers';

describe('/healthz and /readyz', () => {
  describe('with every dependency up, then Valkey stopped', () => {
    let valkey: StartedTestContainer;
    let t: TestApp;

    beforeAll(async () => {
      // A dedicated Valkey: this suite stops it.
      valkey = await startValkey();
      t = await startTestApp({
        CACHE_URL: `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`,
      });
    });

    afterAll(async () => {
      await t.close();
    });

    it('GET /healthz → 200 {status: ok}', async () => {
      const response = await t.app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });

    it('GET /readyz → 200 with every check up', async () => {
      const response = await t.app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(200);
      const body: unknown = response.json();
      expect(readinessResponseSchema.parse(body)).toEqual({
        status: 'ok',
        checks: { database: 'up', cache: 'up', storage: 'up' },
      });
    });

    it('GET /readyz → 503 DEPENDENCY_UNAVAILABLE naming the cache once Valkey stops', async () => {
      await valkey.stop();
      const response = await t.app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(503);
      const problem = problemOf(response.body);
      expect(problemDetailsSchema.safeParse(problem).success).toBe(true);
      expect(problem).toMatchObject({
        code: 'DEPENDENCY_UNAVAILABLE',
        status: 503,
        errors: [
          {
            path: 'checks.cache',
            code: 'DEPENDENCY_DOWN',
            message: 'The cache dependency is unavailable',
          },
        ],
      });
      // Liveness does not depend on dependencies.
      expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    });
  });

  it('GET /readyz → 503 naming database and storage when they are unreachable', async () => {
    const t = await startTestApp({
      DATABASE_URL: 'postgres://cellhive:wrong@127.0.0.1:1/cellhive',
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: 'http://127.0.0.1:1',
      S3_REGION: 'garage',
      S3_BUCKET: 'cellhive',
      S3_ACCESS_KEY_ID: 'GK0123456789abcdef01234567',
      S3_SECRET_ACCESS_KEY: 'secret-that-must-not-leak',
    });
    try {
      const started = Date.now();
      const response = await t.app.inject({ method: 'GET', url: '/readyz' });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(response.statusCode).toBe(503);
      const problem = problemOf(response.body);
      expect((problem.errors as { path: string }[]).map((item) => item.path)).toEqual([
        'checks.database',
        'checks.storage',
      ]);
      expect(response.body).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|wrong|secret/);
    } finally {
      await t.close();
    }
  });
});
