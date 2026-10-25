import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { availableParallelism, loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';

import {
  hookReceiveResponseSchema,
  incomingWebhookListenResponseSchema,
  incomingWebhookRequestListSchema,
  incomingWebhookSampleResponseSchema,
  incomingWebhookWithSecretsSchema,
  newId,
  type Id,
  type IncomingWebhookDto,
  type IncomingWebhookWithSecretsDto,
  type RealtimeServerMessage,
} from '@cellhive/contracts';
import {
  causationRejectedCounts,
  deriveCausationKey,
  encodeCausationToken,
  signWebhook,
  webhookRequestCounts,
  type Db,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IncomingWebhookRateLimits } from '../../src/common/rate-limit/incoming-webhook-rate-limits.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { startValkey } from './global-setup.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const MiB = 1_048_576;
const MAX_RATE = 50;
/** Never present in any log, stored event or job (canary). */
const BODY_CANARY = 'canary-body-7f3a9c';

function tokenOf(hook: Pick<IncomingWebhookDto, 'url'>): string {
  const token = hook.url.split('/api/v1/hooks/')[1];
  if (token === undefined) throw new Error(`unexpected url ${hook.url}`);
  return token;
}

/**
 * BACKLOG T603 (CONTRACTS §25.2–§25.3, ADR-35 §1, §5): the public route
 * `POST /api/v1/hooks/:token` — every acceptance criterion: same `404` for
 * unknown/disabled/regenerated/deleted/trashed, burst then `429` +
 * `Retry-After`, the base cap, `413`/`415`/`400`, Bearer and signature
 * `401`, rotation grace, `webhook-id` replay (one event), causation across
 * `Host: api:3000`, sample listening (P46), Valkey down → `503`; matrix
 * rows P45/P46 and canaries.
 */
describe('POST /api/v1/hooks/:token (T603)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let wsUrl: string;
  const sockets: TestSocket[] = [];
  /** Credentials and URL tokens issued: never logged or stored in clear. */
  const canaries: string[] = [];

  const limits = () => t.app.get(IncomingWebhookRateLimits);

  async function create(
    body: Record<string, unknown>,
    as: FixtureUser = 'u_admin',
  ): Promise<IncomingWebhookWithSecretsDto> {
    const response = await fx.call(as, 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
      name: `Hook ${newId('hok').slice(4, 12)}`,
      ...body,
    });
    expect(response.statusCode, response.body).toBe(201);
    const hook = incomingWebhookWithSecretsSchema.parse(response.json());
    canaries.push(tokenOf(hook));
    if (hook.signing_secret !== null) canaries.push(hook.signing_secret);
    if (hook.bearer_token !== null) canaries.push(hook.bearer_token);
    return hook;
  }

  interface PostOptions {
    readonly body?: unknown;
    readonly raw?: string | Buffer;
    readonly contentType?: string | null;
    readonly headers?: Record<string, string>;
    readonly ip?: string;
    readonly query?: string;
  }

  function post(token: string, options: PostOptions = {}): Promise<LightMyRequestResponse> {
    const payload =
      options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const contentType =
      options.contentType === null ? undefined : (options.contentType ?? 'application/json');
    return t.app.inject({
      method: 'POST',
      url: `/api/v1/hooks/${token}${options.query === undefined ? '' : `?${options.query}`}`,
      ...(payload === undefined ? {} : { payload }),
      headers: {
        ...(contentType === undefined ? {} : { 'content-type': contentType }),
        ...options.headers,
      },
      remoteAddress: options.ip ?? '198.51.100.7',
    });
  }

  /** Standard Webhooks headers over `raw` with `secrets`. */
  function signed(raw: string, secrets: string[], id: string = newId('evt'), at = new Date()) {
    const timestamp = Math.floor(at.getTime() / 1000);
    return {
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': signWebhook({ id, timestamp, body: raw }, secrets),
    };
  }

  const eventsOf = async (hookId: Id<'hok'>) =>
    (
      await sql<{
        id: string;
        causation: { depth: number; root_event_id: string };
        payload: unknown;
      }>`
        SELECT id, causation, payload FROM meta.events
         WHERE entity_id = ${hookId} AND type = 'webhook.received' ORDER BY created_at, id
      `.execute(db.kysely)
    ).rows;

  const requestLog = async (hookId: Id<'hok'>) => {
    const response = await fx.call('u_admin', 'GET', `/incoming-webhooks/${hookId}/requests`);
    expect(response.statusCode, response.body).toBe(200);
    return incomingWebhookRequestListSchema.parse(response.json()).items;
  };

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({
      DATABASE_URL: database.url,
      WEBHOOK_MAX_RATE_PER_SEC: String(MAX_RATE),
    });
    fx = await buildRecordFixture(t, db);
    limits().ip = { limit: 100_000, windowSeconds: 1 };
    wsUrl = await listen(t.app);
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('accepts', () => {
    it('stores a JSON request and answers 202 { request_id } with one webhook.received event', async () => {
      const hook = await create({ auth: 'none' });
      const response = await post(tokenOf(hook), {
        body: { order: 1, note: BODY_CANARY },
        query: 'src=shop&tag=a&tag=b',
      });
      expect(response.statusCode, response.body).toBe(202);
      const { request_id } = hookReceiveResponseSchema.parse(response.json());
      const events = await eventsOf(hook.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        base_id: fx.baseId,
        data: { incoming_webhook_id: hook.id, request_id },
      });
      const row = await db.kysely
        .selectFrom('meta.incoming_webhook_requests')
        .selectAll()
        .where('id', '=', request_id)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        body: { order: 1, note: BODY_CANARY },
        query: { src: 'shop', tag: ['a', 'b'] },
        event_id: events[0]?.id,
        duplicate: false,
      });
      const [actor] = (
        await sql<{ actor_type: string; actor_id: string }>`
          SELECT actor_type, actor_id FROM meta.events WHERE id = ${events[0]?.id ?? ''}
        `.execute(db.kysely)
      ).rows;
      expect(actor).toEqual({ actor_type: 'webhook', actor_id: hook.id });
      // T616: the hook (list and detail) shows when its newest stored request arrived.
      const read = await fx.call('u_admin', 'GET', `/incoming-webhooks/${hook.id}`);
      expect(read.json()).toMatchObject({ last_received_at: row.received_at.toISOString() });
      const list = await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/incoming-webhooks`);
      expect(
        list
          .json<{ items: { id: string; last_received_at: string | null }[] }>()
          .items.find((item) => item.id === hook.id)?.last_received_at,
      ).toBe(row.received_at.toISOString());
    });

    it('accepts a form body, an empty body and exactly 1 MiB', async () => {
      const hook = await create({ auth: 'none', rate_limit_per_sec: MAX_RATE });
      const form = await post(tokenOf(hook), {
        raw: 'a=1&a=2&b=x',
        contentType: 'application/x-www-form-urlencoded',
      });
      expect(form.statusCode, form.body).toBe(202);
      const empty = await post(tokenOf(hook), { contentType: null });
      expect(empty.statusCode, empty.body).toBe(202);
      const exact = `{"a":"${'x'.repeat(MiB - 8)}"}`;
      expect(Buffer.byteLength(exact)).toBe(MiB);
      const big = await post(tokenOf(hook), { raw: exact });
      expect(big.statusCode, big.body).toBe(202);
      const bodies = (
        await sql<{ body: unknown; size_bytes: number }>`
          SELECT body, size_bytes FROM meta.incoming_webhook_requests
           WHERE incoming_webhook_id = ${hook.id} ORDER BY received_at, id
        `.execute(db.kysely)
      ).rows;
      expect(bodies.map((row) => row.size_bytes)).toEqual([11, 0, MiB]);
      expect(bodies[0]?.body).toEqual({ a: ['1', '2'], b: 'x' });
      expect(bodies[1]?.body).toBeNull();
    });

    it('QA S5c: what a 1 MiB request costs on disk (request-table bloat at the cap)', async () => {
      const hook = await create({ auth: 'none', rate_limit_per_sec: MAX_RATE });
      // Three 1 MiB shapes: random text (incompressible), small varied numbers (the worst
      // case for jsonb: ~2 bytes of text per element), and repetitive text.
      const random = randomBytes(MiB / 2).toString('hex');
      const count = Math.floor((MiB - 2) / 2);
      const shapes = {
        random_text: `{"a":"${random.slice(0, MiB - 8)}"}`,
        numbers: `[${Array.from(randomBytes(count), (byte) => String(byte % 10)).join(',')}]`,
        repetitive: `{"a":"${'x'.repeat(MiB - 8)}"}`,
      };
      const sizes: Record<string, { body: number; row: number; event: number }> = {};
      for (const [name, raw] of Object.entries(shapes)) {
        expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MiB);
        const response = await post(tokenOf(hook), { raw });
        expect(response.statusCode, `${name}: ${response.body}`).toBe(202);
        const { request_id } = hookReceiveResponseSchema.parse(response.json());
        const { rows } = await sql<{ body: number; row: number; event: number }>`
          SELECT pg_column_size(r.body) AS body, pg_column_size(r.*) AS row,
                 (SELECT pg_column_size(e.*) FROM meta.events e WHERE e.id = r.event_id) AS event
            FROM meta.incoming_webhook_requests r WHERE r.id = ${request_id}
        `.execute(db.kysely);
        sizes[name] = rows[0] as { body: number; row: number; event: number };
      }
      // QA measurement for docs/reviews/S5c-QA.md.
      process.stdout.write(
        `[T616 bloat] stored bytes per 1 MiB request ${JSON.stringify(sizes)}\n`,
      );
      // Never more than ~1.6× the request on disk (jsonb's per-element overhead, compressed by
      // TOAST); the event row stays small (ids only, never the body).
      for (const size of Object.values(sizes)) {
        expect(size.row).toBeLessThan(1.6 * MiB);
        expect(size.event).toBeLessThan(2_000);
      }
    });
  });

  describe('P45: the same 404 for every hook that cannot receive', () => {
    it('unknown, malformed, disabled, regenerated, deleted and trashed-base tokens look alike', async () => {
      const unknown = 'A'.repeat(43);
      const disabled = await create({ auth: 'none' });
      await fx.call('u_admin', 'PATCH', `/incoming-webhooks/${disabled.id}`, { enabled: false });
      const regenerated = await create({ auth: 'none' });
      await fx.call('u_admin', 'POST', `/incoming-webhooks/${regenerated.id}/regenerate-token`);
      const deleted = await create({ auth: 'none' });
      await fx.call('u_admin', 'DELETE', `/incoming-webhooks/${deleted.id}`);

      const answers = [
        await post(unknown, { body: {} }),
        await post('not-a-token', { body: {} }),
        await post(tokenOf(disabled), { body: {} }),
        await post(tokenOf(regenerated), { body: {} }),
        await post(tokenOf(deleted), { body: {} }),
      ];
      const trashed = await create({ auth: 'none' });
      await sql`UPDATE meta.bases SET deleted_at = now() WHERE id = ${fx.baseId}`.execute(
        db.kysely,
      );
      try {
        answers.push(await post(tokenOf(trashed), { body: {} }));
      } finally {
        await sql`UPDATE meta.bases SET deleted_at = NULL WHERE id = ${fx.baseId}`.execute(
          db.kysely,
        );
      }
      const shapes = answers.map((response) => {
        const problem = { ...problemOf(response.body), request_id: undefined };
        return { status: response.statusCode, problem };
      });
      expect(shapes[0]?.status).toBe(404);
      for (const shape of shapes) expect(shape).toEqual(shapes[0]);
      // The trashed hook answers again once the base is restored.
      expect((await post(tokenOf(trashed), { body: {} })).statusCode).toBe(202);
    });

    it('QA S5c: guessing tokens — near misses look and time like any unknown token', async () => {
      const real = await create({ auth: 'none' });
      const token = tokenOf(real);
      const disabled = await create({ auth: 'none' });
      await fx.call('u_admin', 'PATCH', `/incoming-webhooks/${disabled.id}`, { enabled: false });
      // A near miss: the real token with its last character changed (a prefix match would
      // be the leak a guesser looks for — the lookup is by SHA-256, so there is none).
      const last = token.at(-1) === 'A' ? 'B' : 'A';
      const kinds = {
        unknown: () => `${'Z'.repeat(42)}${String(Math.floor(Math.random() * 10))}`,
        near_miss: () => `${token.slice(0, -1)}${last}`,
        disabled: () => tokenOf(disabled),
      };
      const headerNames = (response: LightMyRequestResponse) =>
        Object.keys(response.headers)
          .filter((name) => !['date', 'x-request-id', 'content-length'].includes(name))
          .sort();
      const timings: Record<string, number[]> = { unknown: [], near_miss: [], disabled: [] };
      let reference: { problem: unknown; headers: string[] } | null = null;
      for (let round = 0; round < 40; round += 1) {
        for (const [kind, tokenFor] of Object.entries(kinds)) {
          const started = performance.now();
          const response = await post(tokenFor(), { body: {} });
          timings[kind]?.push(performance.now() - started);
          expect(response.statusCode).toBe(404);
          const shape = {
            problem: { ...problemOf(response.body), request_id: undefined },
            headers: headerNames(response),
          };
          reference ??= shape;
          expect(shape).toEqual(reference);
        }
      }
      const median = (values: number[]) =>
        [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;
      const medians = Object.fromEntries(
        Object.entries(timings).map(([kind, values]) => [kind, median(values)]),
      );
      process.stdout.write(`[T616 token timing] median ms ${JSON.stringify(medians)}\n`);
      // Only meaningful on a machine that is not overloaded (like the other latency checks).
      if ((loadavg()[0] ?? 0) < 2 * availableParallelism()) {
        expect(Math.abs((medians['near_miss'] ?? 0) - (medians['unknown'] ?? 0))).toBeLessThan(5);
        // A disabled hook costs two more lookups (~1 ms) — only someone holding a valid token
        // could tell; never a difference between two unknown tokens.
        expect(Math.abs((medians['disabled'] ?? 0) - (medians['unknown'] ?? 0))).toBeLessThan(15);
      }
    });
  });

  describe('credentials (P45)', () => {
    it('Bearer: missing or wrong → 401 with no reason, right → 202', async () => {
      const hook = await create({ auth: 'bearer' });
      const missing = await post(tokenOf(hook), { body: { a: 1 } });
      const wrong = await post(tokenOf(hook), {
        body: { a: 1 },
        headers: { authorization: `Bearer ${'z'.repeat(43)}` },
      });
      expectProblem(missing, 401, 'UNAUTHENTICATED');
      expectProblem(wrong, 401, 'UNAUTHENTICATED');
      expect(problemOf(missing.body).detail).toBe(problemOf(wrong.body).detail);
      const right = await post(tokenOf(hook), {
        body: { a: 1 },
        headers: { authorization: `Bearer ${hook.bearer_token ?? ''}` },
      });
      expect(right.statusCode, right.body).toBe(202);
      expect(await eventsOf(hook.id)).toHaveLength(1);
    });

    it('signature: wrong or 330 s old → 401; valid → 202', async () => {
      const hook = await create({ auth: 'signature' });
      const secret = hook.signing_secret ?? '';
      const raw = JSON.stringify({ a: 1 });
      const other = signed(raw, ['whsec_' + Buffer.alloc(32, 9).toString('base64')]);
      expectProblem(await post(tokenOf(hook), { raw, headers: other }), 401, 'UNAUTHENTICATED');
      const old = signed(raw, [secret], newId('evt'), new Date(Date.now() - 330_000));
      expectProblem(await post(tokenOf(hook), { raw, headers: old }), 401, 'UNAUTHENTICATED');
      expectProblem(await post(tokenOf(hook), { raw }), 401, 'UNAUTHENTICATED');
      // The signature covers the exact bytes: re-serialised JSON fails.
      const tampered = signed(raw, [secret]);
      expectProblem(
        await post(tokenOf(hook), { raw: JSON.stringify({ a: 1 }, null, 1), headers: tampered }),
        401,
        'UNAUTHENTICATED',
      );
      const ok = await post(tokenOf(hook), { raw, headers: signed(raw, [secret]) });
      expect(ok.statusCode, ok.body).toBe(202);
    });

    it('QA S5c: replay and timestamp — 330 s ahead is refused; a replay re-timed is still a duplicate', async () => {
      const hook = await create({ auth: 'signature', rate_limit_per_sec: MAX_RATE });
      const secret = hook.signing_secret ?? '';
      const raw = JSON.stringify({ order: 'replay' });
      const ahead = signed(raw, [secret], newId('evt'), new Date(Date.now() + 330_000));
      expectProblem(await post(tokenOf(hook), { raw, headers: ahead }), 401, 'UNAUTHENTICATED');
      const nearAhead = signed(raw, [secret], newId('evt'), new Date(Date.now() + 290_000));
      expect((await post(tokenOf(hook), { raw, headers: nearAhead })).statusCode).toBe(202);
      // The sender (or anyone with the secret) re-signs the same webhook-id later, even with
      // another body: the replay key is the id, so no second event.
      const id = newId('evt');
      expect(
        (await post(tokenOf(hook), { raw, headers: signed(raw, [secret], id) })).statusCode,
      ).toBe(202);
      const later = JSON.stringify({ order: 'replay', changed: true });
      const again = await post(tokenOf(hook), {
        raw: later,
        headers: signed(later, [secret], id, new Date(Date.now() + 60_000)),
      });
      expect(again.statusCode, again.body).toBe(202);
      expect(await eventsOf(hook.id)).toHaveLength(2);
      const log = await requestLog(hook.id);
      expect(log.filter((item) => item.duplicate)).toHaveLength(1);
    });

    it('both: needs the Bearer token and the signature', async () => {
      const hook = await create({ auth: 'both' });
      const raw = JSON.stringify({ b: 2 });
      const headers = signed(raw, [hook.signing_secret ?? '']);
      expectProblem(await post(tokenOf(hook), { raw, headers }), 401, 'UNAUTHENTICATED');
      const ok = await post(tokenOf(hook), {
        raw,
        headers: { ...headers, authorization: `Bearer ${hook.bearer_token ?? ''}` },
      });
      expect(ok.statusCode, ok.body).toBe(202);
    });

    it('rotation: the previous secret is accepted for 24 h, then 401', async () => {
      const hook = await create({ auth: 'signature' });
      const previous = hook.signing_secret ?? '';
      const rotated = incomingWebhookWithSecretsSchema.parse(
        (await fx.call('u_admin', 'POST', `/incoming-webhooks/${hook.id}/rotate-secret`)).json(),
      );
      canaries.push(rotated.signing_secret ?? '');
      const raw = JSON.stringify({ c: 3 });
      expect(
        (await post(tokenOf(hook), { raw, headers: signed(raw, [previous]) })).statusCode,
      ).toBe(202);
      await sql`
        UPDATE meta.incoming_webhooks SET signing_secret_prev_expires_at = now() - interval '1 second'
         WHERE id = ${hook.id}
      `.execute(db.kysely);
      expectProblem(
        await post(tokenOf(hook), { raw, headers: signed(raw, [previous]) }),
        401,
        'UNAUTHENTICATED',
      );
      const current = await post(tokenOf(hook), {
        raw,
        headers: signed(raw, [rotated.signing_secret ?? '']),
      });
      expect(current.statusCode, current.body).toBe(202);
    });

    it('the same webhook-id twice → 202 both times, one event, the replay logged as duplicate', async () => {
      const hook = await create({ auth: 'signature' });
      const raw = JSON.stringify({ d: 4 });
      const headers = signed(raw, [hook.signing_secret ?? ''], 'msg_same_id');
      const first = await post(tokenOf(hook), { raw, headers });
      const second = await post(tokenOf(hook), { raw, headers });
      expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
      expect(await eventsOf(hook.id)).toHaveLength(1);
      const log = await requestLog(hook.id);
      expect(log.map((entry) => entry.duplicate).sort()).toEqual([false, true]);
      expect(log.find((entry) => entry.duplicate)?.event_id).toBeNull();
      expect(hookReceiveResponseSchema.parse(second.json()).request_id).toBe(
        log.find((entry) => entry.duplicate)?.id,
      );
    });
  });

  describe('body checks', () => {
    it('1 MiB + 1 byte → 413 (declared length, never read); text/plain → 415; broken JSON → 400', async () => {
      const hook = await create({ auth: 'none', rate_limit_per_sec: MAX_RATE });
      const tooLarge = await post(tokenOf(hook), { raw: Buffer.alloc(MiB + 1, 0x20) });
      expectProblem(tooLarge, 413, 'PAYLOAD_TOO_LARGE');
      expect(tooLarge.headers.connection).toBe('close');
      expectProblem(
        await post(tokenOf(hook), { raw: 'hello', contentType: 'text/plain' }),
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      );
      expectProblem(await post(tokenOf(hook), { raw: '{"a":' }), 400, 'MALFORMED_JSON');
      expectProblem(await post(tokenOf(hook), { raw: '"scalar"' }), 400, 'MALFORMED_JSON');
      expect(await eventsOf(hook.id)).toHaveLength(0);
    });

    it('QA S5c: JSON nested deeper than 64 (up to 1 MiB of "[") → 400 MALFORMED_JSON, nothing stored', async () => {
      const hook = await create({ auth: 'none' });
      for (const depth of [65, 500_000]) {
        const response = await post(tokenOf(hook), {
          raw: `${'['.repeat(depth)}${']'.repeat(depth)}`,
        });
        expectProblem(response, 400, 'MALFORMED_JSON');
      }
      const deepest = await post(tokenOf(hook), { raw: `${'['.repeat(64)}${']'.repeat(64)}` });
      expect(deepest.statusCode, deepest.body).toBe(202);
      expect(await eventsOf(hook.id)).toHaveLength(1);
    });

    it('a chunked body over 1 MiB (no Content-Length) is cut with 413 and the connection closed', async () => {
      const hook = await create({ auth: 'none', rate_limit_per_sec: MAX_RATE });
      const base = new URL(wsUrl.replace(/^ws/u, 'http'));
      // A raw socket: an HTTP client drops the answer once the server closes mid-upload.
      const { status, closed, sent } = await new Promise<{
        status: number;
        closed: boolean;
        sent: number;
      }>((resolve) => {
        const socket = connect(Number(base.port), base.hostname);
        let answer = '';
        let sent = 0;
        socket.on('data', (data: Buffer) => {
          answer += data.toString('latin1');
        });
        socket.on('error', () => undefined);
        socket.on('close', () => {
          resolve({
            status: Number(/^HTTP\/1\.1 (\d{3})/u.exec(answer)?.[1] ?? 0),
            closed: /\r\nconnection: close\r\n/iu.test(answer),
            sent,
          });
        });
        socket.write(
          `POST /api/v1/hooks/${tokenOf(hook)} HTTP/1.1\r\nHost: ${base.host}\r\n` +
            'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n',
        );
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        const frame = Buffer.concat([
          Buffer.from(`${chunk.length.toString(16)}\r\n`),
          chunk,
          Buffer.from('\r\n'),
        ]);
        const pump = () => {
          while (sent < 8 * MiB && !socket.destroyed) {
            sent += chunk.length;
            if (!socket.write(frame)) {
              socket.once('drain', pump);
              return;
            }
          }
        };
        pump();
      });
      // The server stopped reading long before the 8 MiB were offered.
      expect(sent).toBeLessThan(8 * MiB);
      // It answers 413 + `Connection: close`, then closes with unread bytes in its
      // buffer: the kernel may reset the connection before the client read the
      // answer (seen under load). Either way the body was never read in full.
      if (status !== 0) {
        expect(status).toBe(413);
        expect(closed).toBe(true);
      }
    });
  });

  describe('rate limits', () => {
    it('a hook of 5 req/s lets the 20 of its burst through, then 429 with Retry-After', async () => {
      const hook = await create({ auth: 'none', rate_limit_per_sec: 5 });
      const started = Date.now();
      const responses = await Promise.all(
        Array.from({ length: 25 }, () => post(tokenOf(hook), { body: { burst: true } })),
      );
      const elapsedSeconds = (Date.now() - started) / 1000;
      const accepted = responses.filter((response) => response.statusCode === 202);
      const limited = responses.filter((response) => response.statusCode === 429);
      // Tokens refill at 5/s while the 25 requests are handled (slow under a loaded run).
      expect(accepted.length).toBeGreaterThanOrEqual(20);
      expect(accepted.length).toBeLessThanOrEqual(20 + Math.ceil(elapsedSeconds * 5));
      if (elapsedSeconds < 0.8) expect(limited.length).toBeGreaterThanOrEqual(1);
      expect(accepted.length + limited.length).toBe(25);
      for (const response of limited) {
        expectProblem(response, 429, 'RATE_LIMITED');
        expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      }
    });

    it('caps a base at 50 req/s across 3 hooks (one atomic take of hook + base tokens)', async () => {
      const baseId = newId('bse');
      const hookIds = [newId('hok'), newId('hok'), newId('hok')];
      const outcomes = await Promise.all(
        Array.from({ length: 120 }, (_, index) =>
          limits()
            .takeHook(baseId, hookIds[index % 3] ?? newId('hok'), MAX_RATE)
            .then(
              () => 'ok',
              (error: unknown) => (error as { code?: string }).code ?? 'error',
            ),
        ),
      );
      const ok = outcomes.filter((outcome) => outcome === 'ok').length;
      expect(ok).toBeGreaterThanOrEqual(50);
      expect(ok).toBeLessThanOrEqual(55);
      expect(outcomes.filter((outcome) => outcome === 'RATE_LIMITED')).toHaveLength(120 - ok);
    });

    it('over HTTP, hooks of one base share its cap', async () => {
      const saved = limits().base;
      limits().base = { ratePerSec: 1, burst: 5 };
      try {
        const hooks = [
          await create({ auth: 'none', rate_limit_per_sec: MAX_RATE }),
          await create({ auth: 'none', rate_limit_per_sec: MAX_RATE }),
          await create({ auth: 'none', rate_limit_per_sec: MAX_RATE }),
        ];
        const responses = await Promise.all(
          hooks.flatMap((hook) =>
            Array.from({ length: 4 }, () => post(tokenOf(hook), { body: { shared: true } })),
          ),
        );
        const accepted = responses.filter((response) => response.statusCode === 202).length;
        expect(accepted).toBeGreaterThanOrEqual(5);
        expect(accepted).toBeLessThanOrEqual(6);
      } finally {
        limits().base = saved;
        await new Promise((resolve) => setTimeout(resolve, 1_100));
      }
    });

    it('20 req/s per IP, checked before the token', async () => {
      const saved = limits().ip;
      limits().ip = { limit: 20, windowSeconds: 1 };
      try {
        const responses = await Promise.all(
          Array.from({ length: 45 }, () => post('B'.repeat(43), { body: {}, ip: '203.0.113.99' })),
        );
        const limited = responses.filter((response) => response.statusCode === 429);
        expect(limited.length).toBeGreaterThanOrEqual(5);
        expect(responses.every((r) => r.statusCode === 404 || r.statusCode === 429)).toBe(true);
        // Another IP is not affected.
        expect((await post('B'.repeat(43), { body: {}, ip: '203.0.113.100' })).statusCode).toBe(
          404,
        );
      } finally {
        limits().ip = saved;
      }
    });
  });

  describe('causation (ADR-27, ADR-35 §5)', () => {
    const key = () => deriveCausationKey(t.config.security.appMasterKey);
    const chain = () => ({
      root_event_id: newId('evt'),
      depth: 1,
      automation_chain: [newId('aut')],
    });

    it('a valid token sent to Host api:3000 continues the chain with depth + 1', async () => {
      const hook = await create({ auth: 'none', rate_limit_per_sec: MAX_RATE });
      const causation = chain();
      const header = encodeCausationToken(causation, {
        key: key(),
        host: 'api:3000',
        path: '/api/v1/hooks',
        now: new Date(),
      });
      canaries.push(header);
      const response = await post(tokenOf(hook), {
        body: { e: 1 },
        headers: { host: 'api:3000', 'x-cellhive-causation': header },
      });
      expect(response.statusCode, response.body).toBe(202);
      const [event] = await eventsOf(hook.id);
      expect(event?.causation).toEqual({
        root_event_id: causation.root_event_id,
        depth: 2,
        automation_chain: causation.automation_chain,
      });
      expect((await requestLog(hook.id))[0]?.causation_accepted).toBe(true);
    });

    it('the instance-bound token works on any hook of this instance (ADR-27 §5 amendment)', async () => {
      const first = await create({ auth: 'none', rate_limit_per_sec: MAX_RATE });
      const second = await create({ auth: 'none', rate_limit_per_sec: MAX_RATE });
      const causation = chain();
      const header = encodeCausationToken(causation, {
        key: key(),
        host: new URL(TEST_PUBLIC_URL).host,
        path: '/api/v1/hooks',
        now: new Date(),
      });
      canaries.push(header);
      // Forwarded by n8n from another Host: still matched by the PUBLIC_URL host.
      for (const hook of [first, second]) {
        const response = await post(tokenOf(hook), {
          body: { c: 1 },
          headers: { host: 'n8n-callback.internal:5678', 'x-cellhive-causation': header },
        });
        expect(response.statusCode, response.body).toBe(202);
        const [event] = await eventsOf(hook.id);
        expect(event?.causation).toEqual({ ...causation, depth: 2 });
      }
    });

    it('QA S5c: a loop across two organizations keeps its depth — capped at 5, never reset', async () => {
      // A hook of another organization (its owner creates the workspace, base and hook).
      const me = await fx.call('stranger', 'GET', '/me');
      const otherOrg = me.json<{ orgs: { id: string }[] }>().orgs[0]?.id ?? '';
      const workspace = await fx.call('stranger', 'POST', `/orgs/${otherOrg}/workspaces`, {
        name: 'Elsewhere',
      });
      expect(workspace.statusCode, workspace.body).toBe(201);
      const base = await fx.call(
        'stranger',
        'POST',
        `/workspaces/${workspace.json<{ id: string }>().id}/bases`,
        { name: 'Elsewhere base' },
      );
      expect(base.statusCode, base.body).toBe(201);
      const created = await fx.call(
        'stranger',
        'POST',
        `/bases/${base.json<{ id: string }>().id}/incoming-webhooks`,
        { name: 'Other org hook', auth: 'none', rate_limit_per_sec: MAX_RATE },
      );
      expect(created.statusCode, created.body).toBe(201);
      const foreign = incomingWebhookWithSecretsSchema.parse(created.json());
      canaries.push(tokenOf(foreign));
      // A run of this organization (depth 1, then the deepest a run can be) calls it.
      for (const depth of [1, 5]) {
        const causation = { ...chain(), depth };
        const header = encodeCausationToken(causation, {
          key: key(),
          host: new URL(TEST_PUBLIC_URL).host,
          path: '/api/v1/hooks',
          now: new Date(),
        });
        canaries.push(header);
        const response = await post(tokenOf(foreign), {
          body: { loop: depth },
          headers: { 'x-cellhive-causation': header },
        });
        expect(response.statusCode, response.body).toBe(202);
        const { rows } = await sql<{ causation: { depth: number } }>`
          SELECT causation FROM meta.events
           WHERE entity_id = ${foreign.id} AND type = 'webhook.received'
           ORDER BY created_at DESC, id DESC LIMIT 1
        `.execute(db.kysely);
        // The other organization's loop guard sees the chain: depth + 1, at most 5
        // (automation_max_depth ≤ 5 stops every automation there).
        expect(rows[0]?.causation.depth).toBe(Math.min(depth + 1, 5));
      }
    });

    it('a token bound to another target or altered → depth 0 + automation_causation_rejected_total', async () => {
      const first = await create({ auth: 'none', rate_limit_per_sec: MAX_RATE });
      const second = await create({ auth: 'none', rate_limit_per_sec: MAX_RATE });
      const valid = encodeCausationToken(chain(), {
        key: key(),
        host: new URL(TEST_PUBLIC_URL).host,
        path: '/api/v1/hooks',
        now: new Date(),
      });
      // Bound to the destination URL (the pre-amendment binding): not this instance.
      const header = encodeCausationToken(chain(), {
        key: key(),
        host: 'n8n.internal:5678',
        path: '/webhook/abc',
        now: new Date(),
      });
      canaries.push(header, valid);
      const before = causationRejectedCounts();
      const copied = await post(tokenOf(second), {
        body: { f: 1 },
        headers: { 'x-cellhive-causation': header },
      });
      const altered = await post(tokenOf(first), {
        body: { f: 2 },
        headers: { 'x-cellhive-causation': `${valid.slice(0, -6)}AAAAAA` },
      });
      expect([copied.statusCode, altered.statusCode]).toEqual([202, 202]);
      const after = causationRejectedCounts();
      expect(after.get('target_mismatch')).toBe((before.get('target_mismatch') ?? 0) + 1);
      expect(after.get('bad_tag')).toBe((before.get('bad_tag') ?? 0) + 1);
      for (const hook of [first, second]) {
        const [event] = await eventsOf(hook.id);
        expect(event?.causation.depth).toBe(0);
        expect(event?.causation.root_event_id).toBe(event?.id);
      }
      const metrics = await t.app
        .get((await import('../../src/modules/metrics/metrics.service.js')).MetricsService)
        .render();
      expect(metrics.body).toMatch(
        /automation_causation_rejected_total\{reason="target_mismatch"\} [1-9]/u,
      );
      expect(metrics.body).toMatch(/webhook_requests_total\{result="accepted"\} [1-9]/u);
      expect(metrics.body).toContain('webhook_request_duration_seconds_bucket');
    });
  });

  describe('listen for a sample request (C§25.3, P46)', () => {
    async function socketOf(user: FixtureUser): Promise<TestSocket> {
      const socket = await TestSocket.connect(wsUrl, {
        origin: TEST_PUBLIC_URL,
        cookie: await fx.cookie(user),
      });
      sockets.push(socket);
      expect(await socket.subscribe(`user:${fx.users[user].id}`)).toMatchObject({
        type: 'subscribed',
      });
      return socket;
    }
    const captured =
      (hookId: Id<'hok'>) =>
      (message: RealtimeServerMessage): boolean =>
        message.type === 'incoming_webhook.sample_captured' &&
        message.incoming_webhook_id === hookId;

    async function sampleOf(hookId: Id<'hok'>) {
      const response = await fx.call('u_admin', 'GET', `/incoming-webhooks/${hookId}/sample`);
      expect(response.statusCode, response.body).toBe(200);
      return incomingWebhookSampleResponseSchema.parse(response.json());
    }

    it('stores only the first valid request, without sensitive headers; the envelope reaches the listener only', async () => {
      const hook = await create({ auth: 'bearer', rate_limit_per_sec: MAX_RATE });
      const listener = await socketOf('u_admin');
      const owner = await socketOf('owner');
      expect(await sampleOf(hook.id)).toEqual({ sample: null, listen_until: null });

      const listened = await fx.call('u_admin', 'POST', `/incoming-webhooks/${hook.id}/listen`);
      expect(listened.statusCode, listened.body).toBe(200);
      const { listen_until } = incomingWebhookListenResponseSchema.parse(listened.json());
      const window = new Date(listen_until).getTime() - Date.now();
      expect(window).toBeGreaterThan(170_000);
      expect(window).toBeLessThanOrEqual(180_000);
      expect((await sampleOf(hook.id)).listen_until).toBe(listen_until);

      // An unauthenticated request is not a valid one: not captured.
      expectProblem(await post(tokenOf(hook), { body: { bad: true } }), 401, 'UNAUTHENTICATED');
      const sensitive = {
        authorization: `Bearer ${hook.bearer_token ?? ''}`,
        cookie: 'session=abc',
        'webhook-signature': 'v1,xyz',
        'x-cellhive-causation': 'v1.garbage',
        'x-custom': 'kept',
      };
      const first = await post(tokenOf(hook), {
        body: { first: true },
        headers: sensitive,
        query: 'q=1',
      });
      expect(first.statusCode, first.body).toBe(202);
      const second = await post(tokenOf(hook), {
        body: { second: true },
        headers: { authorization: sensitive.authorization },
      });
      expect(second.statusCode, second.body).toBe(202);

      const { sample, listen_until: closed } = await sampleOf(hook.id);
      expect(closed).toBeNull();
      expect(sample).toMatchObject({ body: { first: true }, query: { q: '1' }, truncated: false });
      expect(sample?.headers['x-custom']).toBe('kept');
      // QA S5c: the Content-Type the sender used (not the route's internal raw-upload type).
      expect(sample?.headers['content-type']).toBe('application/json');
      for (const name of ['authorization', 'cookie', 'webhook-signature', 'x-cellhive-causation']) {
        expect(sample?.headers).not.toHaveProperty(name);
      }
      // The sampled request still ran normally: two events.
      expect(await eventsOf(hook.id)).toHaveLength(2);
      // Stored request rows never keep sensitive headers either.
      const { rows } = await sql<{ headers: Record<string, string> }>`
        SELECT headers FROM meta.incoming_webhook_requests WHERE incoming_webhook_id = ${hook.id}
      `.execute(db.kysely);
      for (const row of rows) {
        for (const name of [
          'authorization',
          'cookie',
          'webhook-signature',
          'x-cellhive-causation',
        ]) {
          expect(row.headers).not.toHaveProperty(name);
        }
      }

      expect(await listener.next(captured(hook.id))).toEqual({
        type: 'incoming_webhook.sample_captured',
        channel: `user:${fx.users.u_admin.id}`,
        organization_id: fx.orgId,
        incoming_webhook_id: hook.id,
      });
      await owner.expectNone(captured(hook.id));
    });

    it('a 100 KB body is truncated; listening again drops the old sample; DELETE …/listen stops', async () => {
      const hook = await create({ auth: 'none', rate_limit_per_sec: MAX_RATE });
      await fx.call('u_admin', 'POST', `/incoming-webhooks/${hook.id}/listen`);
      expect((await post(tokenOf(hook), { body: { text: 'x'.repeat(100_000) } })).statusCode).toBe(
        202,
      );
      const { sample } = await sampleOf(hook.id);
      expect(sample?.truncated).toBe(true);
      expect(typeof sample?.body).toBe('string');
      expect(Buffer.byteLength(sample?.body as string)).toBeLessThanOrEqual(65_536);

      await fx.call('u_admin', 'POST', `/incoming-webhooks/${hook.id}/listen`);
      expect((await sampleOf(hook.id)).sample).toBeNull();
      const stop = await fx.call('u_admin', 'DELETE', `/incoming-webhooks/${hook.id}/listen`);
      expect(stop.statusCode, stop.body).toBe(204);
      await post(tokenOf(hook), { body: { late: true } });
      expect(await sampleOf(hook.id)).toEqual({ sample: null, listen_until: null });
    });

    it('P46: readers who are not base admins get 403, others 404; the log has no headers', async () => {
      const hook = await create({ auth: 'none' });
      const routes = [
        ['POST', `/incoming-webhooks/${hook.id}/listen`],
        ['DELETE', `/incoming-webhooks/${hook.id}/listen`],
        ['GET', `/incoming-webhooks/${hook.id}/sample`],
        ['GET', `/incoming-webhooks/${hook.id}/requests`],
      ] as const;
      for (const [method, url] of routes) {
        expectProblem(await fx.call('u_editor', method, url), 403, 'PERMISSION_DENIED');
        expectProblem(await fx.call('u_out', method, url), 404, 'NOT_FOUND');
        expectProblem(await fx.call('stranger', method, url), 404, 'NOT_FOUND');
      }
      await post(tokenOf(hook), { body: { g: 1 }, headers: { authorization: 'Bearer x' } });
      const [entry] = await requestLog(hook.id);
      expect(Object.keys(entry ?? {}).sort()).toEqual(
        ['causation_accepted', 'duplicate', 'event_id', 'id', 'received_at', 'size_bytes'].sort(),
      );
    });
  });

  it('counts outcomes in webhook_requests_total', () => {
    const counts = webhookRequestCounts();
    for (const result of [
      'accepted',
      'duplicate',
      'unauthorized',
      'rate_limited',
      'too_large',
      'unsupported',
      'not_found',
    ] as const) {
      expect(counts.get(result), result).toBeGreaterThan(0);
    }
  });

  it('canaries: no URL token, credential, causation token or body in logs, events or jobs', async () => {
    expect(canaries.length).toBeGreaterThan(20);
    const { rows: events } = await sql`SELECT * FROM meta.events`.execute(db.kysely);
    const { rows: audit } = await sql`SELECT * FROM meta.audit_logs`.execute(db.kysely);
    const { rows: jobs } = await sql`SELECT payload FROM graphile_worker._private_jobs`.execute(
      db.kysely,
    );
    const stored = JSON.stringify({ events, audit, jobs });
    const logs = t.logs.raw();
    for (const canary of [...canaries, BODY_CANARY]) {
      expect(logs).not.toContain(canary);
      expect(stored).not.toContain(canary);
    }
    const { rows: received } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM meta.audit_logs WHERE action = 'webhook.received'
    `.execute(db.kysely);
    expect(Number(received[0]?.n)).toBe(0);
  });
});

describe('POST /api/v1/hooks/:token without Valkey (T603)', () => {
  it('answers 503 DEPENDENCY_UNAVAILABLE with Retry-After: 1 (fail closed)', async () => {
    const database = await createMigratedDatabase();
    const db = createTestDb(database.url);
    const valkey = await startValkey();
    const t = await startTestApp({
      DATABASE_URL: database.url,
      CACHE_URL: `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`,
    });
    try {
      const fx = await buildRecordFixture(t, db);
      const created = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
        name: 'Valkey down',
        auth: 'none',
      });
      const hook = incomingWebhookWithSecretsSchema.parse(created.json());
      const token = tokenOf(hook);
      const send = () =>
        t.app.inject({
          method: 'POST',
          url: `/api/v1/hooks/${token}`,
          payload: '{}',
          headers: { 'content-type': 'application/json' },
        });
      expect((await send()).statusCode).toBe(202);
      await valkey.stop();
      // Under load the client can still see the old connection for a moment after the
      // container is gone (the port proxy closes it late): poll until it notices, then the
      // answer must be the fail-closed 503 — never another status.
      let down = await send();
      for (let tries = 0; down.statusCode === 202 && tries < 50; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        down = await send();
      }
      expectProblem(down, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(down.headers['retry-after']).toBe('1');
    } finally {
      await t.close();
      await db.destroy();
      await database.drop();
    }
  });
});
