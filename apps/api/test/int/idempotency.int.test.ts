import { IDEMPOTENT_REPLAYED_HEADER, type Id } from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser, seedOrg, seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/**
 * `Idempotency-Key` on the organization-scoped write `POST`s (CONTRACTS
 * §1.1), applied by the global `RequestPoliciesInterceptor`.
 */
describe('Idempotency-Key on write POST routes', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let org: Id<'org'>;
  let owner: SeededUser;
  let stranger: SeededUser;
  let ownerBrowser: Browser;
  let strangerBrowser: Browser;
  let counter = 0;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url, ALLOW_ORG_CREATION: 'true' });
    org = await seedOrg(db, 'Idem');
    const otherOrg = await seedOrg(db, 'Elsewhere');
    owner = await seedUser(db, { memberships: [{ orgId: org, role: 'owner' }] });
    stranger = await seedUser(db, { memberships: [{ orgId: otherOrg, role: 'owner' }] });
    ownerBrowser = new Browser(t.app);
    expect((await ownerBrowser.login(owner.email)).statusCode).toBe(204);
    strangerBrowser = new Browser(t.app);
    expect((await strangerBrowser.login(stranger.email)).statusCode).toBe(204);
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  function post(
    browser: Browser,
    url: string,
    payload: object,
    key?: string,
  ): Promise<LightMyRequestResponse> {
    return browser.request({
      method: 'POST',
      url: `/api/v1${url}`,
      payload,
      headers: key === undefined ? {} : { 'idempotency-key': key },
    });
  }

  function newKey(): string {
    counter += 1;
    return `idem-${String(counter)}-${String(Date.now())}`;
  }

  /** Sends the same request twice with one key: the second is a replay of the first. */
  async function replayed(url: string, payload: object): Promise<Record<string, unknown>> {
    const key = newKey();
    const first = await post(ownerBrowser, url, payload, key);
    expect(first.statusCode, first.body).toBeLessThan(300);
    expect(first.headers[IDEMPOTENT_REPLAYED_HEADER]).toBeUndefined();
    const second = await post(ownerBrowser, url, payload, key);
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true');
    expect(second.body).toBe(first.body);
    return JSON.parse(first.body) as Record<string, unknown>;
  }

  async function count(table: 'workspaces' | 'groups' | 'bases' | 'tables'): Promise<number> {
    const row = await db.kysely
      .selectFrom(`meta.${table}`)
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  it('replays workspace, group, base, table and field creation instead of repeating it', async () => {
    const workspacesBefore = await count('workspaces');
    const workspace = await replayed(`/orgs/${org}/workspaces`, { name: 'Replayed' });
    expect(await count('workspaces')).toBe(workspacesBefore + 1);

    const groupsBefore = await count('groups');
    const group = await replayed(`/orgs/${org}/groups`, { name: 'Replayed group' });
    expect(await count('groups')).toBe(groupsBefore + 1);
    await replayed(`/groups/${String(group.id)}/members`, { user_id: owner.id });

    const basesBefore = await count('bases');
    const base = await replayed(`/workspaces/${String(workspace.id)}/bases`, { name: 'B' });
    expect(await count('bases')).toBe(basesBefore + 1);

    const tablesBefore = await count('tables');
    const table = await replayed(`/bases/${String(base.id)}/tables`, { name: 'T' });
    expect(await count('tables')).toBe(tablesBefore + 1);

    const field = await replayed(`/tables/${String(table.id)}/fields`, {
      name: 'Amount',
      type: 'number',
    });
    const deleted = await ownerBrowser.request({
      method: 'DELETE',
      url: `/api/v1/fields/${String(field.id)}`,
    });
    expect(deleted.statusCode).toBe(204);
    const restored = await replayed(`/fields/${String(field.id)}/restore`, {});
    expect(restored.id).toBe(field.id);
  });

  it('answers 409 IDEMPOTENCY_KEY_REUSED for the same key with another body', async () => {
    const key = newKey();
    expect((await post(ownerBrowser, `/orgs/${org}/groups`, { name: 'G1' }, key)).statusCode).toBe(
      201,
    );
    const reused = await post(ownerBrowser, `/orgs/${org}/groups`, { name: 'G2' }, key);
    expect(reused.statusCode).toBe(409);
    expect(problemOf(reused.body).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('does not store failed requests: the key can be retried', async () => {
    const key = newKey();
    const conflict = await post(ownerBrowser, `/orgs/${org}/groups`, { name: 'G1' }, key);
    expect(conflict.statusCode).toBe(409);
    expect(problemOf(conflict.body).code).toBe('NAME_CONFLICT');
    const retried = await post(ownerBrowser, `/orgs/${org}/groups`, { name: 'G3' }, key);
    expect(retried.statusCode).toBe(201);
  });

  it('keeps the invitation link of a replay, stored encrypted only', async () => {
    const invitation = await replayed(`/orgs/${org}/invitations`, {
      email: 'invitee@example.test',
      role: 'member',
    });
    const url = String(invitation.invite_url);
    const token = url.slice(url.lastIndexOf('/') + 1);
    expect(token.length).toBeGreaterThan(20);
    const rows = await db.kysely
      .selectFrom('meta.idempotency_keys')
      .select('response')
      .where('principal_key', '=', owner.id)
      .execute();
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('replays POST /orgs under the caller’s oldest organization', async () => {
    const created = await replayed('/orgs', { name: 'Second org' });
    const orgs = await db.kysely
      .selectFrom('meta.organizations')
      .select('id')
      .where('name', '=', 'Second org')
      .execute();
    expect(orgs.map((row) => row.id)).toEqual([created.id]);
  });

  it('never lets a key reach a resource the caller cannot see (404, nothing stored)', async () => {
    const key = newKey();
    const response = await post(strangerBrowser, `/orgs/${org}/groups`, { name: 'Nope' }, key);
    expect(response.statusCode).toBe(404);
    const stored = await db.kysely
      .selectFrom('meta.idempotency_keys')
      .select('key')
      .where('key', '=', key)
      .execute();
    expect(stored).toEqual([]);
  });

  it('validates the header', async () => {
    const response = await post(ownerBrowser, `/orgs/${org}/groups`, { name: 'Bad key' }, 'a b');
    expect(response.statusCode).toBe(422);
  });
});
