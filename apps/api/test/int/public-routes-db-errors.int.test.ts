import { randomBytes } from 'node:crypto';

import { incomingWebhookWithSecretsSchema, type IncomingWebhookDto } from '@cellhive/contracts';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { IncomingWebhookRateLimits } from '../../src/common/rate-limit/incoming-webhook-rate-limits.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type RecordFixture } from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';

/** In the body of the refused request: never in a log line. */
const BODY_CANARY = 'canary-db-error-4e1b';

function tokenOf(hook: Pick<IncomingWebhookDto, 'url'>): string {
  return hook.url.split('/api/v1/hooks/')[1] ?? '';
}

/**
 * QA S5c (T616; BACKLOG "Tồn đọng S5c", T609 note): the two public S5c
 * routes when PostgreSQL fails mid-request, on a database of their own in
 * the shared container —
 *
 * - a write the database refuses (a constraint added for the test, so the
 *   error carries PostgreSQL's "Failing row contains (…)" detail with the
 *   body): `503 DEPENDENCY_UNAVAILABLE` + `Retry-After`, and nothing of the
 *   body in the logs;
 * - the database refusing every connection (`ALLOW_CONNECTIONS false` +
 *   the open connections terminated): `POST /hooks/:token` and
 *   `POST /telegram/webhook/:pathToken` answer `503` + `Retry-After` (never
 *   `404`, which a sender takes as "gone", nor `500`).
 */
describe('public S5c routes when the database fails (QA S5c)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let databaseName: string;

  async function asAdmin(statement: string): Promise<void> {
    const client = new pg.Client({ connectionString: inject('databaseUrl') });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  }

  async function createHook(): Promise<IncomingWebhookDto> {
    const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
      name: `DB errors ${randomBytes(3).toString('hex')}`,
      auth: 'none',
    });
    expect(response.statusCode, response.body).toBe(201);
    return incomingWebhookWithSecretsSchema.parse(response.json());
  }

  const postHook = (token: string, body: unknown) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/hooks/${token}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
      remoteAddress: '198.51.100.9',
    });

  beforeAll(async () => {
    database = await createMigratedDatabase();
    databaseName = new URL(database.url).pathname.slice(1);
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    t.app.get(IncomingWebhookRateLimits).ip = { limit: 100_000, windowSeconds: 1 };
  });

  afterAll(async () => {
    await asAdmin(
      `ALTER DATABASE ${pg.escapeIdentifier(databaseName)} WITH ALLOW_CONNECTIONS true`,
    ).catch(() => undefined);
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('a write the database refuses: 503 + Retry-After, and the body never reaches the logs', async () => {
    const hook = await createHook();
    await sql`
      ALTER TABLE meta.incoming_webhook_requests
        ADD CONSTRAINT qa_refuse CHECK (body IS NULL OR body::text NOT LIKE '%qa-refuse%') NOT VALID
    `.execute(db.kysely);
    try {
      const refused = await postHook(tokenOf(hook), { note: `qa-refuse ${BODY_CANARY}` });
      expect(refused.statusCode, refused.body).toBe(503);
      expect(refused.json()).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(refused.body).not.toContain(BODY_CANARY);
      expect(t.logs.raw()).not.toContain(BODY_CANARY);
      // Only the SQLSTATE and the class of the error are logged.
      expect(t.logs.lines).toContainEqual(
        expect.objectContaining({ sqlstate: '23514', msg: 'webhook request not stored' }),
      );
    } finally {
      await sql`ALTER TABLE meta.incoming_webhook_requests DROP CONSTRAINT qa_refuse`.execute(
        db.kysely,
      );
    }
    // The same hook works again.
    expect((await postHook(tokenOf(hook), { note: 'fine' })).statusCode).toBe(202);
  });

  it('the database refusing connections: both public routes answer 503 + Retry-After', async () => {
    const hook = await createHook();
    await asAdmin(
      `ALTER DATABASE ${pg.escapeIdentifier(databaseName)} WITH ALLOW_CONNECTIONS false`,
    );
    await asAdmin(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = ${pg.escapeLiteral(databaseName)} AND pid <> pg_backend_pid()`,
    );
    try {
      const hookDown = await postHook(tokenOf(hook), { note: 'while down' });
      expect(hookDown.statusCode, hookDown.body).toBe(503);
      expect(hookDown.json()).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
      expect(Number(hookDown.headers['retry-after'])).toBeGreaterThanOrEqual(1);

      const telegramDown = await t.app.inject({
        method: 'POST',
        url: `/api/v1/telegram/webhook/${randomBytes(24).toString('base64url')}`,
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': 'whatever',
        },
        payload: JSON.stringify({ update_id: 1 }),
      });
      expect(telegramDown.statusCode, telegramDown.body).toBe(503);
      expect(telegramDown.json()).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
      expect(Number(telegramDown.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    } finally {
      await asAdmin(
        `ALTER DATABASE ${pg.escapeIdentifier(databaseName)} WITH ALLOW_CONNECTIONS true`,
      );
    }
    // Back to normal once PostgreSQL accepts connections again.
    const deadline = Date.now() + 10_000;
    let status = 0;
    while (Date.now() < deadline) {
      status = (await postHook(tokenOf(hook), { note: 'after' })).statusCode;
      if (status === 202) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(status).toBe(202);
  });
});
