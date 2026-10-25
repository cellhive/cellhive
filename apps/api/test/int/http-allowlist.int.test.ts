import {
  HTTP_ALLOWLIST_MAX_ENTRIES,
  httpAllowlistEntrySchema,
  httpAllowlistSchema,
  newId,
  type HttpAllowlistEntryDto,
} from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

/**
 * BACKLOG T600 (CONTRACTS §25.4, ADR-35 §3): the outbound HTTP allowlist
 * through the API — owner/admin management with canonical patterns, the
 * validation codes, the 100-entry cap, audit entries, and the P49 row of
 * the S5c permission matrix (base admin `403`, another organization `404`).
 */
describe('HTTP allowlist API (T600)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;

  async function create(
    pattern: string,
    as: FixtureUser = 'owner',
    note?: string,
  ): Promise<HttpAllowlistEntryDto> {
    const response = await fx.call(as, 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern,
      ...(note === undefined ? {} : { note }),
    });
    expect(response.statusCode, response.body).toBe(201);
    return httpAllowlistEntrySchema.parse(response.json());
  }

  const auditOf = async (entityId: string) =>
    (
      await sql<{ action: string; before: unknown; after: unknown; entity_type: string }>`
        SELECT action, before, after, entity_type FROM meta.audit_logs
         WHERE organization_id = ${fx.orgId} AND entity_id = ${entityId}
         ORDER BY created_at, id
      `.execute(db.kysely)
    ).rows;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    // u_sales2 becomes an organization admin (not an owner).
    await sql`
      UPDATE meta.org_members SET role = 'admin'
       WHERE organization_id = ${fx.orgId} AND user_id = ${fx.users.u_sales2.id}
    `.execute(db.kysely);
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('stores the canonical pattern, lists it with the instance policy and audits it', async () => {
    const entry = await create('  N8N.Internal:5678 ', 'owner', 'n8n nội bộ');
    expect(entry).toMatchObject({
      organization_id: fx.orgId,
      pattern: 'n8n.internal:5678',
      host: 'n8n.internal',
      wildcard: false,
      port: 5678,
      note: 'n8n nội bộ',
      created_by: { id: fx.users.owner.id, name: 'Owner' },
    });
    const wildcard = await create('*.Bücher.example');
    expect(wildcard).toMatchObject({
      pattern: '*.xn--bcher-kva.example',
      host: 'xn--bcher-kva.example',
      wildcard: true,
      port: null,
    });

    const list = await fx.call('owner', 'GET', `/orgs/${fx.orgId}/http-allowlist`);
    expect(list.statusCode).toBe(200);
    const body = httpAllowlistSchema.parse(list.json());
    expect(body.private_addresses).toBe('org');
    expect(body.items.map((item) => item.pattern)).toEqual([
      '*.xn--bcher-kva.example',
      'n8n.internal:5678',
    ]);

    expect(await auditOf(entry.id)).toEqual([
      {
        action: 'http_allowlist.created',
        entity_type: 'http_allowlist',
        before: null,
        after: { pattern: 'n8n.internal:5678', note: 'n8n nội bộ' },
      },
    ]);

    const removed = await fx.call('owner', 'DELETE', `/http-allowlist/${wildcard.id}`);
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await auditOf(wildcard.id)).map((row) => row.action)).toEqual([
      'http_allowlist.created',
      'http_allowlist.deleted',
    ]);
    expect((await auditOf(wildcard.id))[1]?.before).toEqual({
      pattern: '*.xn--bcher-kva.example',
      note: '',
    });
    expectProblem(
      await fx.call('owner', 'DELETE', `/http-allowlist/${wildcard.id}`),
      404,
      'NOT_FOUND',
    );
  });

  it.each([
    ['an IPv4 address', '10.0.0.5'],
    ['an IPv4 address with a port', '127.0.0.1:6379'],
    ['an IPv4 address in hex', '0x7f.1'],
    ['an IPv6 address', '[::1]:8080'],
    ['a CIDR range', '10.0.0.0/8'],
    ['a wildcard over one label', '*.internal'],
    ['a wildcard over a TLD', '*.com'],
    ['a URL', 'http://n8n.internal'],
    ['a path', 'n8n.internal/webhook'],
    ['a port out of range', 'n8n.internal:70000'],
  ])('refuses %s (422 INVALID_ALLOWLIST_PATTERN)', async (_name, pattern) => {
    const response = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern,
    });
    expectProblem(response, 422, 'VALIDATION_FAILED');
    expect(problemOf(response.body)['errors']).toEqual([
      expect.objectContaining({ path: 'pattern', code: 'INVALID_ALLOWLIST_PATTERN' }),
    ]);
  });

  it('refuses the same host twice, whatever the case (ALLOWLIST_ENTRY_EXISTS)', async () => {
    await create('hooks.example.com');
    const response = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern: 'HOOKS.example.com.',
    });
    expectProblem(response, 422, 'VALIDATION_FAILED');
    expect(problemOf(response.body)['errors']).toEqual([
      expect.objectContaining({ path: 'pattern', code: 'ALLOWLIST_ENTRY_EXISTS' }),
    ]);
    // Another port is another entry.
    await create('hooks.example.com:8443');
  });

  it('caps an organization at 100 entries (TOO_MANY_ALLOWLIST_ENTRIES)', async () => {
    const existing = Number(
      (
        await sql<{ n: string }>`
          SELECT count(*) AS n FROM meta.http_allowlist WHERE organization_id = ${fx.orgId}
        `.execute(db.kysely)
      ).rows[0]?.n,
    );
    const fillers = Array.from({ length: HTTP_ALLOWLIST_MAX_ENTRIES - existing }, (_, index) => ({
      id: newId('hal'),
      organization_id: fx.orgId,
      pattern: `filler-${String(index)}.example.com`,
      host: `filler-${String(index)}.example.com`,
      wildcard: false,
      port: null,
    }));
    await db.kysely.insertInto('meta.http_allowlist').values(fillers).execute();
    const response = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern: 'one-more.example.com',
    });
    expectProblem(response, 422, 'VALIDATION_FAILED');
    expect(problemOf(response.body)['errors']).toEqual([
      expect.objectContaining({ code: 'TOO_MANY_ALLOWLIST_ENTRIES' }),
    ]);
    await db.kysely
      .deleteFrom('meta.http_allowlist')
      .where('organization_id', '=', fx.orgId)
      .where('pattern', 'like', 'filler-%')
      .execute();
  });

  it('lets an organization admin (not owner) manage the list', async () => {
    const entry = await create('admin.example.com', 'u_sales2');
    expect(entry.created_by?.id).toBe(fx.users.u_sales2.id);
    const removed = await fx.call('u_sales2', 'DELETE', `/http-allowlist/${entry.id}`);
    expect(removed.statusCode, removed.body).toBe(204);
  });

  describe('P49: base admin (not org admin) 403, admin of another organization 404', () => {
    it.each(['u_admin', 'u_editor', 'u_reader'] as const)(
      '%s, a member who is not an owner/admin, gets 403',
      async (user) => {
        const entry = await create(`p49-${user.replace('_', '-')}.example.com`);
        expectProblem(
          await fx.call(user, 'GET', `/orgs/${fx.orgId}/http-allowlist`),
          403,
          'PERMISSION_DENIED',
        );
        expectProblem(
          await fx.call(user, 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
            pattern: 'sneaky.example.com',
          }),
          403,
          'PERMISSION_DENIED',
        );
        expectProblem(
          await fx.call(user, 'DELETE', `/http-allowlist/${entry.id}`),
          403,
          'PERMISSION_DENIED',
        );
      },
    );

    it('the owner of another organization gets 404 everywhere', async () => {
      const entry = await create('p49-stranger.example.com');
      expectProblem(
        await fx.call('stranger', 'GET', `/orgs/${fx.orgId}/http-allowlist`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('stranger', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
          pattern: 'sneaky.example.com',
        }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('stranger', 'DELETE', `/http-allowlist/${entry.id}`),
        404,
        'NOT_FOUND',
      );
      // Still there.
      const list = httpAllowlistSchema.parse(
        (await fx.call('owner', 'GET', `/orgs/${fx.orgId}/http-allowlist`)).json(),
      );
      expect(list.items.map((item) => item.id)).toContain(entry.id);
    });

    it('an unknown or malformed id is 404 / 400', async () => {
      expectProblem(
        await fx.call('owner', 'DELETE', `/http-allowlist/${newId('hal')}`),
        404,
        'NOT_FOUND',
      );
      const malformed = await fx.call('owner', 'DELETE', '/http-allowlist/not-an-id');
      expect([400, 404, 422]).toContain(malformed.statusCode);
    });
  });
});
