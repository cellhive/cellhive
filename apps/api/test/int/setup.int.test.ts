import { setupResponseSchema, setupStatusSchema } from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uniqueIp } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';

const SETUP = {
  email: 'owner@example.test',
  password: 'Setup-Password-2026',
  display_name: 'Nguyễn Văn Ánh',
  org_name: 'Công ty Đông Á',
  locale: 'vi',
  timezone: 'Asia/Ho_Chi_Minh',
};

describe('first-time setup (SPEC §14.1A)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  function post(payload: object, ip = uniqueIp()) {
    return t.app.inject({ method: 'POST', url: '/api/v1/setup', payload, remoteAddress: ip });
  }

  it('reports that setup is required on an empty instance', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/v1/setup' });
    expect(response.statusCode).toBe(200);
    expect(setupStatusSchema.parse(response.json())).toEqual({
      setup_required: true,
      auth_config: { smtp_enabled: false, providers: [] },
    });
  });

  it('reports smtp_enabled when SMTP is configured, without a connection', async () => {
    const app = await startTestApp({
      DATABASE_URL: database.url,
      SMTP_URL: 'smtp://127.0.0.1:9',
      SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
    });
    try {
      const response = await app.app.inject({ method: 'GET', url: '/api/v1/setup' });
      expect(setupStatusSchema.parse(response.json()).auth_config).toEqual({
        smtp_enabled: true,
        providers: [],
      });
    } finally {
      await app.close();
    }
  });

  it('rejects a weak password with 422 before creating anything', async () => {
    const common = await post({ ...SETUP, password: 'qwertyuiop' });
    expect(common.statusCode).toBe(422);
    expect(problemOf(common.body)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ path: 'password', code: 'PASSWORD_TOO_COMMON' })],
    });
    const short = await post({ ...SETUP, password: 'short' });
    expect(short.statusCode).toBe(422);
    expect(problemOf(short.body)).toMatchObject({
      errors: [expect.objectContaining({ path: 'password', code: 'TOO_SMALL' })],
    });
    const badZone = await post({ ...SETUP, timezone: 'Mars/Olympus' });
    expect(problemOf(badZone.body)).toMatchObject({
      errors: [expect.objectContaining({ path: 'timezone', code: 'INVALID_TIME_ZONE' })],
    });
    const users = await db.kysely.selectFrom('meta.users').select('id').execute();
    expect(users).toHaveLength(0);
  });

  it('lets exactly one of two concurrent setups succeed', async () => {
    const [first, second] = await Promise.all([
      post(SETUP),
      post({ ...SETUP, email: 'other@example.test', org_name: 'Other' }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = first.statusCode === 409 ? first : second;
    expect(problemOf(loser.body).code).toBe('SETUP_COMPLETED');

    const users = await db.kysely.selectFrom('meta.users').selectAll().execute();
    const orgs = await db.kysely.selectFrom('meta.organizations').selectAll().execute();
    expect(users).toHaveLength(1);
    expect(orgs).toHaveLength(1);
  });

  it('created the user, the organization and the owner membership', async () => {
    const user = await db.kysely.selectFrom('meta.users').selectAll().executeTakeFirstOrThrow();
    const org = await db.kysely
      .selectFrom('meta.organizations')
      .selectAll()
      .executeTakeFirstOrThrow();
    const members = await db.kysely.selectFrom('meta.org_members').selectAll().execute();
    expect(user.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(user.locale).toBeNull();
    expect(members).toEqual([
      expect.objectContaining({ organization_id: org.id, user_id: user.id, role: 'owner' }),
    ]);
    expect(org.settings).toMatchObject({ currency: 'USD' });
    if (user.email === SETUP.email) {
      expect(org).toMatchObject({ name: 'Công ty Đông Á', slug: 'cong-ty-dong-a' });
      expect(org.settings).toMatchObject({ locale: 'vi', timezone: 'Asia/Ho_Chi_Minh' });
    }

    const events = await db.kysely
      .selectFrom('meta.events')
      .select(['type', 'organization_id', 'actor_type', 'actor_id'])
      .orderBy('type')
      .execute();
    expect(events).toEqual([
      { type: 'org.created', organization_id: org.id, actor_type: 'user', actor_id: user.id },
      { type: 'org_member.added', organization_id: org.id, actor_type: 'user', actor_id: user.id },
    ]);
    const audit = await db.kysely
      .selectFrom('meta.audit_logs')
      .select(['action', 'organization_id', 'actor_id', 'request_id'])
      .orderBy('action')
      .execute();
    expect(audit.map((entry) => entry.action)).toEqual([
      'org.created',
      'org_member.added',
      'setup.completed',
    ]);
    for (const entry of audit) {
      expect(entry).toMatchObject({ organization_id: org.id, actor_id: user.id });
      expect(entry.request_id).toMatch(/^req_/);
    }
    // The password hash never reaches the audit log.
    const raw = JSON.stringify(await db.kysely.selectFrom('meta.audit_logs').selectAll().execute());
    expect(raw).not.toContain('argon2');
  });

  it('answers 409 SETUP_COMPLETED once a user exists, and GET reports it', async () => {
    const response = await post({ ...SETUP, email: 'late@example.test' });
    expect(response.statusCode).toBe(409);
    expect(problemOf(response.body)).toMatchObject({ code: 'SETUP_COMPLETED', status: 409 });
    const status = await t.app.inject({ method: 'GET', url: '/api/v1/setup' });
    expect(status.json()).toEqual({
      setup_required: false,
      auth_config: { smtp_enabled: false, providers: [] },
    });
  });

  it('returns the created user and organization', async () => {
    // Shape check with the contract schema on a fresh instance.
    const fresh = await createMigratedDatabase();
    const app = await startTestApp({ DATABASE_URL: fresh.url });
    try {
      const response = await app.app.inject({
        method: 'POST',
        url: '/api/v1/setup',
        payload: SETUP,
        remoteAddress: uniqueIp(),
      });
      expect(response.statusCode).toBe(201);
      const body = setupResponseSchema.parse(response.json());
      expect(body.user).toMatchObject({ email: SETUP.email, display_name: SETUP.display_name });
      expect(body.organization.slug).toBe('cong-ty-dong-a');
      // Setup does not sign in.
      expect(response.headers['set-cookie']).toBeUndefined();
    } finally {
      await app.close();
      await fresh.drop();
    }
  });

  it('rate limits setup attempts per IP with 429 and Retry-After', async () => {
    const ip = uniqueIp();
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await post({ ...SETUP, email: `x${String(i)}@example.test` }, ip);
      statuses.push(last.statusCode);
    }
    expect(statuses.slice(0, 10).every((status) => status === 409)).toBe(true);
    expect(last?.statusCode).toBe(429);
    expect(problemOf(last?.body ?? '{}').code).toBe('RATE_LIMITED');
    expect(Number(last?.headers['retry-after'])).toBeGreaterThan(0);
  });
});
