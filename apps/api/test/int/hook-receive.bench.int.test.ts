import { incomingWebhookWithSecretsSchema } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IncomingWebhookRateLimits } from '../../src/common/rate-limit/incoming-webhook-rate-limits.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type RecordFixture } from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';

const RATE = 50;
const SECONDS = 60;

/**
 * BACKLOG T603 bench, opt-in (`WEBHOOK_BENCH=1`): one hook at its full
 * 50 req/s for 60 s through `app.inject` — every request answered `202`,
 * every request row and event stored (0 lost), p95 of the route printed.
 */
describe.skipIf(process.env.WEBHOOK_BENCH !== '1')('hooks bench: 50 req/s for 60 s (T603)', () => {
  let database: TestDatabase;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let t: TestApp;
  let fx: RecordFixture;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url, WEBHOOK_MAX_RATE_PER_SEC: String(RATE) });
    fx = await buildRecordFixture(t, db);
    t.app.get(IncomingWebhookRateLimits).ip = { limit: 100_000, windowSeconds: 1 };
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it(
    'loses nothing and reports p95',
    async () => {
      const created = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
        name: 'Bench',
        auth: 'none',
        rate_limit_per_sec: RATE,
      });
      const hook = incomingWebhookWithSecretsSchema.parse(created.json());
      const token = hook.url.split('/api/v1/hooks/')[1] ?? '';
      const total = RATE * SECONDS;
      const durations: number[] = [];
      const statuses = new Map<number, number>();
      const pending: Promise<void>[] = [];
      const started = performance.now();
      for (let index = 0; index < total; index += 1) {
        const due = started + (index * 1000) / RATE;
        const wait = due - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        const sentAt = performance.now();
        pending.push(
          t.app
            .inject({
              method: 'POST',
              url: `/api/v1/hooks/${token}`,
              payload: JSON.stringify({ order: index, items: [{ sku: 'A', qty: 2 }] }),
              headers: { 'content-type': 'application/json' },
            })
            .then((response) => {
              durations.push(performance.now() - sentAt);
              statuses.set(response.statusCode, (statuses.get(response.statusCode) ?? 0) + 1);
            }),
        );
      }
      await Promise.all(pending);
      durations.sort((a, b) => a - b);
      const p = (q: number) =>
        durations[Math.min(durations.length - 1, Math.floor(q * durations.length))] ?? 0;
      const { rows } = await sql<{ requests: string; events: string }>`
        SELECT (SELECT count(*) FROM meta.incoming_webhook_requests WHERE incoming_webhook_id = ${hook.id}) AS requests,
               (SELECT count(*) FROM meta.events WHERE entity_id = ${hook.id} AND type = 'webhook.received') AS events
      `.execute(db.kysely);
      process.stdout.write(
        `[T603 bench] ${String(total)} requests at ${String(RATE)}/s: statuses ${JSON.stringify(Object.fromEntries(statuses))}, ` +
          `p50 ${p(0.5).toFixed(1)} ms, p95 ${p(0.95).toFixed(1)} ms, p99 ${p(0.99).toFixed(1)} ms, ` +
          `stored ${rows[0]?.requests ?? '?'} rows / ${rows[0]?.events ?? '?'} events\n`,
      );
      expect(statuses.get(202)).toBe(total);
      expect(Number(rows[0]?.requests)).toBe(total);
      expect(Number(rows[0]?.events)).toBe(total);
    },
    (SECONDS + 60) * 1000,
  );
});
