/**
 * Opt-in bench of S6 (BACKLOG T719): `S6_BENCH=1 pnpm --filter @cellhive/api
 * test:int test/int/s6.bench`. On the real application (Testcontainers):
 *
 * 1. Bearer vs session authentication: 1,000 interleaved `GET /bases/:id`
 *    each (p50/p95 and the extra cost of Bearer);
 * 2. `last_used_at` writes under 50 tokens × 20 req/s for 10 s (the token
 *    touch is throttled to once per 5 minutes per token);
 * 3. the audit viewer over HTTP on 1,000,000 entries of the organization
 *    (`S6_BENCH_AUDIT_ROWS`): first page, actor filter, action filter, base
 *    filter (org route) and the base route — p95 of 50 requests each, with
 *    the UI default range (last 7 days) and without a range;
 * 4. creating the two audit indexes of migration 0052 on that volume;
 * 5. 200 WebSocket connections opened with 200 tokens on `base:` channels,
 *    then one role change: time until every connection got
 *    `permission.changed`.
 *
 * Numbers are always printed; asserted only when the 1-minute load is below
 * twice the CPU count (BACKLOG S6 "Test").
 */
import { availableParallelism, loadavg } from 'node:os';

import { createdApiTokenSchema, type CreatedApiToken, type Id } from '@cellhive/contracts';
import { createDb, type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { uniqueIp } from './auth-support.js';
import { createMigratedDatabase, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';

const AUTH_ROUNDS = 1_000;
const TOKENS = 50;
const RATE_PER_TOKEN = 20;
const TOUCH_SECONDS = 10;
const AUDIT_ROWS = Number(process.env['S6_BENCH_AUDIT_ROWS'] ?? '1000000');
const AUDIT_SAMPLES = 50;
const WS_CONNECTIONS = 200;
const DAY_MS = 86_400_000;

const quiet = () => (loadavg()[0] ?? 0) < 2 * availableParallelism();
const loadText = () =>
  loadavg()
    .map((value) => value.toFixed(1))
    .join(' / ');

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

const ms = (value: number) => `${value.toFixed(1)} ms`;

describe.skipIf(process.env['S6_BENCH'] !== '1')('S6 bench (T719)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let wsUrl: string;
  let fx: RecordFixture;
  let base2: Id<'bse'>;
  const report: string[] = [];
  const sockets: TestSocket[] = [];
  /** The 50 tokens of u_reader (bench 2), reused by bench 5. */
  const readerTokens: string[] = [];

  async function createToken(user: FixtureUser, name: string): Promise<CreatedApiToken> {
    const response = await fx.call(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name,
      scopes: ['records:read', 'schema:read'],
      expires_at: new Date(Date.now() + 90 * DAY_MS).toISOString(),
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdApiTokenSchema.parse(response.json());
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createDb({ url: database.url, poolMax: 4, statementTimeoutMs: 0 });
    t = await startTestApp({ DATABASE_URL: database.url, LOG_LEVEL: 'warn' });
    wsUrl = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    const workspaces = await fx.call('owner', 'GET', `/orgs/${fx.orgId}/workspaces`);
    const workspaceId = workspaces.json<{ items: { id: string }[] }>().items[0]?.id ?? '';
    const b2 = await fx.call('owner', 'POST', `/workspaces/${workspaceId}/bases`, { name: 'B2' });
    expect(b2.statusCode, b2.body).toBe(201);
    base2 = b2.json<{ id: Id<'bse'> }>().id;
  }, 300_000);

  afterAll(async () => {
    process.stdout.write(`\nT719 S6 bench (load ${loadText()})\n${report.join('\n')}\n`);
    await closeSockets(sockets);
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('1. Bearer vs session: extra p50/p95 over 1,000 requests', async () => {
    const token = (await createToken('u_editor', 'auth bench')).token;
    const cookie = await fx.cookie('u_editor');
    const url = `/api/v1/bases/${fx.baseId}`;
    const run = async (headers: Record<string, string>): Promise<number> => {
      const started = process.hrtime.bigint();
      const response = await t.app.inject({ method: 'GET', url, headers });
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      expect(response.statusCode).toBe(200);
      return elapsed;
    };
    const session = { cookie };
    const bearer = { authorization: `Bearer ${token}` };
    for (let index = 0; index < 100; index += 1) {
      await run(session);
      await run(bearer);
    }
    const samples = { session: [] as number[], bearer: [] as number[] };
    for (let index = 0; index < AUTH_ROUNDS; index += 1) {
      samples.session.push(await run(session));
      samples.bearer.push(await run(bearer));
    }
    const p = (list: number[], q: number) => percentile(list, q);
    const extra50 = p(samples.bearer, 50) - p(samples.session, 50);
    const extra95 = p(samples.bearer, 95) - p(samples.session, 95);
    report.push(
      `1. auth (${String(AUTH_ROUNDS)} each, GET /bases/:id): session p50 ${ms(p(samples.session, 50))} p95 ${ms(p(samples.session, 95))}; ` +
        `bearer p50 ${ms(p(samples.bearer, 50))} p95 ${ms(p(samples.bearer, 95))}; extra p50 ${ms(extra50)}, p95 ${ms(extra95)}`,
    );
    if (quiet()) expect(extra95).toBeLessThanOrEqual(2);
  }, 600_000);

  it('2. last_used_at writes under 50 tokens × 20 req/s', async () => {
    // u_reader: 50 tokens (the most a member may have in an organization).
    const tokens = readerTokens;
    for (let index = 0; index < TOKENS; index += 1) {
      tokens.push((await createToken('u_reader', `touch ${String(index)}`)).token);
    }
    const statements: string[] = [];
    const prototype = pg.Client.prototype as unknown as {
      query: (this: pg.Client, ...args: unknown[]) => unknown;
    };
    const original = prototype.query;
    const spy = vi.spyOn(prototype, 'query').mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const first = args[0];
      statements.push(
        typeof first === 'string' ? first : String((first as { text?: unknown } | null)?.text),
      );
      return original.apply(this, args);
    });
    const latencies: number[] = [];
    const started = performance.now();
    try {
      const tick = 1_000 / RATE_PER_TOKEN;
      const pending: Promise<void>[] = [];
      for (let round = 0; round < RATE_PER_TOKEN * TOUCH_SECONDS; round += 1) {
        const due = started + round * tick;
        const wait = due - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        for (const token of tokens) {
          pending.push(
            (async () => {
              const at = performance.now();
              const response = await t.app.inject({
                method: 'GET',
                url: '/api/v1/me',
                headers: { authorization: `Bearer ${token}` },
                remoteAddress: uniqueIp(),
              });
              latencies.push(performance.now() - at);
              expect(response.statusCode).toBe(200);
            })(),
          );
        }
      }
      await Promise.all(pending);
    } finally {
      spy.mockRestore();
    }
    const seconds = (performance.now() - started) / 1000;
    const touches = statements.filter((text) =>
      /^update "meta"\."api_tokens" set "last_used_at"/iu.test(text),
    ).length;
    const touched = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.api_tokens
       WHERE user_id = ${fx.users.u_reader.id} AND last_used_at IS NOT NULL
    `.execute(db.kysely);
    report.push(
      `2. last_used_at: ${String(latencies.length)} requests in ${seconds.toFixed(1)} s ` +
        `(${(latencies.length / seconds).toFixed(0)} req/s, p95 ${ms(percentile(latencies, 95))}); ` +
        `${String(touches)} UPDATE statements = ${(touches / seconds).toFixed(2)} writes/s; ` +
        `${String(touched.rows[0]?.n ?? 0)}/${String(TOKENS)} tokens touched`,
    );
    expect(touched.rows[0]?.n).toBe(TOKENS);
    if (quiet()) expect(touches).toBeLessThanOrEqual(2 * TOKENS);
  }, 600_000);

  it('3–4. audit viewer on 1,000,000 entries (p95) and the 0052 index build', async () => {
    const users = ['owner', 'u_admin', 'u_editor', 'u_reader', 'u_sales1', 'u_sales2'] as const;
    const actors = users.map((user) => fx.users[user].id);
    const bases = [fx.baseId, base2];
    const actions = [
      ['record.updated', 700],
      ['record.created', 100],
      ['record.deleted', 50],
      ['field.updated', 30],
      ['view.updated', 20],
      ['role.updated', 20],
      ['auth.login', 20],
      ['table.updated', 20],
      ['automation.run.succeeded', 20],
      ['audit.viewed', 20],
    ] as const;
    const cases = sql.join(
      actions.map(([action], i) => {
        const upTo = actions.slice(0, i + 1).reduce((sum, [, share]) => sum + share, 0);
        return sql`WHEN (g::bigint * 7919) % 1000 < ${upTo} THEN ${action}`;
      }),
      sql` `,
    );
    // 13 monthly partitions (11 months back through next month), 330 days of entries.
    await sql`
      SELECT meta.create_monthly_partition(
        'audit_logs',
        (date_trunc('month', now() AT TIME ZONE 'UTC') + m * interval '1 month')::date)
        FROM generate_series(-11, 1) AS m
    `.execute(db.kysely);
    const insertStarted = performance.now();
    const chunk = 200_000;
    for (let start = 0; start < AUDIT_ROWS; start += chunk) {
      const end = Math.min(AUDIT_ROWS, start + chunk);
      await sql`
        INSERT INTO meta.audit_logs
          (id, organization_id, base_id, table_id, actor_type, actor_id, action, entity_type,
           entity_id, batch_id, request_id, before, after, ip, user_agent, created_at)
        SELECT 'aud_' || substr(md5('t719' || g::text), 1, 16),
               ${fx.orgId},
               (${sql.val(bases)}::text[])[1 + g % 2],
               ${fx.orders.id},
               'user',
               (${sql.val(actors)}::text[])[1 + g % ${actors.length}],
               CASE ${cases} END,
               'record',
               'rec_' || substr(md5((g % 50000)::text), 1, 16),
               NULL,
               'req_' || substr(md5((g / 10)::text), 1, 16),
               jsonb_build_object(${fx.fld['amount']?.id ?? ''}::text, g % 1000),
               jsonb_build_object(${fx.fld['amount']?.id ?? ''}::text, g % 997),
               '203.0.113.7'::inet,
               'Mozilla/5.0 (bench) Cellhive/1.0',
               now() - interval '330 days' * (g::double precision / ${AUDIT_ROWS})
          FROM generate_series(${start}::int, ${end - 1}::int) AS g
      `.execute(db.kysely);
    }
    await sql`ANALYZE meta.audit_logs`.execute(db.kysely);
    const inserted = performance.now() - insertStarted;

    // 4. The indexes of migration 0052, rebuilt on this volume.
    await sql`DROP INDEX meta.audit_logs_actor_idx`.execute(db.kysely);
    await sql`DROP INDEX meta.audit_logs_action_idx`.execute(db.kysely);
    const indexStarted = performance.now();
    await sql`
      CREATE INDEX audit_logs_actor_idx
        ON meta.audit_logs (organization_id, actor_id, created_at DESC, id DESC)
    `.execute(db.kysely);
    const actorIndex = performance.now() - indexStarted;
    await sql`
      CREATE INDEX audit_logs_action_idx
        ON meta.audit_logs (organization_id, action, created_at DESC, id DESC)
    `.execute(db.kysely);
    const bothIndexes = performance.now() - indexStarted;
    await sql`ANALYZE meta.audit_logs`.execute(db.kysely);
    // On-disk size of every partition of the table and of each 0052 index (T721).
    const sizes = await sql<{ name: string; bytes: string }>`
      SELECT root::text AS name, sum(pg_relation_size(tree.relid))::text AS bytes
        FROM unnest(ARRAY[
               'meta.audit_logs'::regclass,
               'meta.audit_logs_actor_idx'::regclass,
               'meta.audit_logs_action_idx'::regclass
             ]) AS root,
             LATERAL pg_partition_tree(root) AS tree
       GROUP BY root
    `.execute(db.kysely);
    const mib = (name: string) =>
      `${(Number(sizes.rows.find((row) => name.endsWith(row.name.replace(/^meta\./u, '')))?.bytes ?? 0) / 1_048_576).toFixed(1)} MiB`;
    report.push(
      `4. audit volume: ${String(AUDIT_ROWS)} entries written in ${(inserted / 1000).toFixed(1)} s; ` +
        `0052 indexes: actor ${(actorIndex / 1000).toFixed(1)} s, both ${(bothIndexes / 1000).toFixed(1)} s; ` +
        `size: table ${mib('meta.audit_logs')}, actor index ${mib('meta.audit_logs_actor_idx')}, ` +
        `action index ${mib('meta.audit_logs_action_idx')}`,
    );

    // 3. Through the API, as the organization owner (org route) and u_admin (base route).
    const week = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const shapes: [string, FixtureUser, string][] = [];
    for (const [suffix, range] of [
      ['7 days', `&from=${encodeURIComponent(week)}`],
      ['no range', ''],
    ] as const) {
      const org = `/orgs/${fx.orgId}/audit-logs?limit=50${range}`;
      shapes.push(
        [`first page (${suffix})`, 'owner', org],
        [`actor_id (${suffix})`, 'owner', `${org}&actor_id=${fx.users.u_editor.id}`],
        [`action (${suffix})`, 'owner', `${org}&action=role.updated`],
        [`base_id (${suffix})`, 'owner', `${org}&base_id=${fx.baseId}`],
        [`base route (${suffix})`, 'u_admin', `/bases/${fx.baseId}/audit-logs?limit=50${range}`],
        [
          `base route + actor + action (${suffix})`,
          'u_admin',
          `/bases/${fx.baseId}/audit-logs?limit=50${range}&actor_id=${fx.users.u_sales1.id}&action=record.updated`,
        ],
      );
    }
    const p95s = new Map<string, number>();
    for (const [label, user, path] of shapes) {
      const samples: number[] = [];
      for (let index = 0; index < AUDIT_SAMPLES + 3; index += 1) {
        const started = performance.now();
        const response = await fx.call(user, 'GET', path);
        const elapsed = performance.now() - started;
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<{ items: unknown[] }>().items.length).toBeGreaterThan(0);
        if (index >= 3) samples.push(elapsed);
      }
      p95s.set(label, percentile(samples, 95));
      report.push(
        `3. audit ${label}: p50 ${ms(percentile(samples, 50))}, p95 ${ms(percentile(samples, 95))}`,
      );
    }
    if (quiet()) {
      for (const [label, p95] of p95s) expect(p95, label).toBeLessThan(300);
    }
  }, 1_800_000);

  it('5. 200 token WebSocket connections, one role change → permission.changed', async () => {
    // 200 tokens of 4 members (50 each — the most per member): u_reader's from bench 2.
    const tokens = [...readerTokens];
    for (const user of ['u_admin', 'u_sales1', 'u_sales2'] as const) {
      for (let index = 0; index < TOKENS; index += 1) {
        tokens.push((await createToken(user, `ws ${String(index)}`)).token);
      }
    }
    expect(tokens).toHaveLength(WS_CONNECTIONS);
    const connectStarted = performance.now();
    const opened: TestSocket[] = [];
    for (const token of tokens.slice(0, WS_CONNECTIONS)) {
      const result = await TestSocket.open(wsUrl, {
        authorization: `Bearer ${token}`,
        forwardedFor: uniqueIp(),
      });
      if (!result.ok) throw new Error(`refused: ${String(result.status)} ${result.body}`);
      opened.push(result.socket);
      sockets.push(result.socket);
    }
    await Promise.all(
      opened.map(async (socket) => {
        expect(await socket.subscribe(`base:${fx.baseId}`)).toMatchObject({ type: 'subscribed' });
      }),
    );
    const connected = performance.now() - connectStarted;
    // One role change: the base's permission version goes up.
    const roles = await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/roles`);
    const sales = roles
      .json<{ items: { id: string; name: string; config: unknown }[] }>()
      .items.find((role) => role.name === 'Sales');
    const config = sales?.config as { base_rule: { copy: boolean } } & Record<string, unknown>;
    const changeStarted = performance.now();
    const changed = await fx.call(
      'u_admin',
      'PATCH',
      `/bases/${fx.baseId}/roles/${sales?.id ?? ''}`,
      { config: { ...config, base_rule: { ...config.base_rule, copy: !config.base_rule.copy } } },
    );
    expect(changed.statusCode, changed.body).toBe(200);
    // Arrival times to the millisecond (TestSocket.next polls every 250 ms).
    const arrivals = new Map<TestSocket, number>();
    const deadline = changeStarted + 30_000;
    while (arrivals.size < opened.length && performance.now() < deadline) {
      for (const socket of opened) {
        if (arrivals.has(socket)) continue;
        if (socket.received.some((message) => message.type === 'permission.changed')) {
          arrivals.set(socket, performance.now() - changeStarted);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(arrivals.size).toBe(opened.length);
    const times = [...arrivals.values()];
    report.push(
      `5. WS: ${String(opened.length)} token connections opened + subscribed in ${ms(connected)}; ` +
        `permission.changed after the PATCH: p50 ${ms(percentile(times, 50))}, p95 ${ms(percentile(times, 95))}, max ${ms(Math.max(...times))}`,
    );
    if (quiet()) expect(Math.max(...times)).toBeLessThan(5_000);
  }, 600_000);
});
