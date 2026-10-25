import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import { type Id } from '@cellhive/contracts';
import { HttpDeliveriesRepository, HttpOutbox, orgScope, type Db } from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker, type WorkerHandle } from '../../src/index.js';
import { buildTaskList } from '../../src/tasks/index.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  queuedJobs,
  testConfig,
  waitFor,
  type CapturedLogger,
  type TestDatabase,
} from './support.js';

import type { AddressInfo } from 'node:net';

const ORG: Id<'org'> = 'org_HttpDeliverWork1';
const USER: Id<'usr'> = 'usr_HttpDeliverWork1';
const URL_CANARY = 'never-logged-url-token';
const BODY_CANARY = 'never-logged-body';

/**
 * BACKLOG T605 with the real worker (graphile-worker, Postgres
 * Testcontainers): a delivery enqueued by `HttpOutbox` is picked up by the
 * `http.deliver` task of `buildTaskList`, goes through the SSRF guard (the
 * loopback destination opened by an exact allowlist entry with its port,
 * read from `meta.http_allowlist`) and reaches the destination once; the
 * row ends `succeeded` without its request. The task logs ids, codes and
 * the outcome — never the URL or the body.
 */
describe('worker: http.deliver (T605)', () => {
  let database: TestDatabase;
  let db: Db;
  let worker: WorkerHandle;
  let captured: CapturedLogger;
  let server: Server;
  let port: number;
  const received: { url: string; headers: IncomingMessage['headers']; body: string }[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end('{"accepted":true}');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;

    const config = testConfig(database.url);
    await db.kysely
      .insertInto('meta.organizations')
      .values({ id: ORG, name: 'Acme', slug: 'acme-http' })
      .execute();
    await db.kysely
      .insertInto('meta.users')
      .values({ id: USER, email: 'http-deliver@example.test', display_name: 'Owner' })
      .execute();
    await db.kysely
      .insertInto('meta.org_members')
      .values({ organization_id: ORG, user_id: USER, role: 'owner' })
      .execute();
    await db.kysely
      .insertInto('meta.http_allowlist')
      .values({
        id: 'hal_HttpDeliverWork1',
        organization_id: ORG,
        pattern: `hooks.test:${String(port)}`,
        host: 'hooks.test',
        wildcard: false,
        port,
        created_by: USER,
      })
      .execute();
    captured = captureLogger();
    worker = await createWorker(config, {
      logger: captured.logger,
      pollIntervalMs: 200,
      taskList: buildTaskList({
        config,
        db,
        logger: captured.logger,
        // `hooks.test` is the loopback destination (no real DNS).
        httpDelivery: { lookup: () => Promise.resolve(['127.0.0.1']) },
      }),
    });
  });

  afterAll(async () => {
    await worker.close();
    server.close();
    await db.destroy();
    await database.drop();
  });

  it('delivers a queued request once through the guard; the row ends succeeded', async () => {
    const config = testConfig(database.url);
    const { row } = await db.withTx((tx) =>
      new HttpOutbox(db, { masterKey: config.security.appMasterKey }).enqueue(tx, orgScope(ORG), {
        kind: 'test',
        automationId: null,
        actionId: null,
        requestedBy: USER,
        request: {
          method: 'POST',
          url: `http://hooks.test:${String(port)}/in?token=${URL_CANARY}`,
          headers: [['content-type', 'application/json']],
          body: JSON.stringify({ note: BODY_CANARY }),
          authHeaderName: null,
          causation: null,
        },
      }),
    );
    const done = await waitFor(
      async () => {
        const current = await new HttpDeliveriesRepository(db).get(orgScope(ORG), row.id);
        return current?.status === 'succeeded' ? current : undefined;
      },
      { what: 'the delivery' },
    );
    expect(done).toMatchObject({ attempts: 1, last_status: 202, request_enc: null });
    expect(received).toHaveLength(1);
    expect(received[0]?.headers['webhook-id']).toBe(row.id);
    expect(received[0]?.headers['idempotency-key']).toBe(`test:${row.id}`);
    // A test delivery carries no causation.
    expect(received[0]?.headers['x-cellhive-causation']).toBeUndefined();
    const lines = captured.lines.filter((line) => line['msg'] === 'http delivery');
    expect(lines).toEqual([
      expect.objectContaining({
        org_id: ORG,
        delivery_id: row.id,
        status: 'succeeded',
        attempt: 1,
      }),
    ]);
    expect(captured.raw()).not.toContain(URL_CANARY);
    expect(captured.raw()).not.toContain(BODY_CANARY);
    // The safety job left by TX-a (end of the lease) is still queued and will find it final.
    const safety = await queuedJobs(db, 'http.deliver');
    expect(safety.every((job) => job.payload['delivery_id'] === row.id)).toBe(true);
  });
});
