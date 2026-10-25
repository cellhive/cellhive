import { type Id } from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  ApiRateLimits,
  DEFAULT_BASE_RATE_LIMIT,
  DEFAULT_PRINCIPAL_RATE_LIMIT,
} from '../../src/common/rate-limit/api-rate-limits.js';

import { Browser, seedOrg, seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/** SPEC §13.1: per-principal and per-principal-and-base limits on every authenticated route. */
describe('API rate limits', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let limits: ApiRateLimits;
  let org: Id<'org'>;
  let baseId: Id<'bse'>;
  let otherBaseId: Id<'bse'>;
  let tableId: Id<'tbl'>;
  let fieldId: Id<'fld'>;
  /** Unique window per test, so counters of earlier tests never interfere. */
  let window = 30;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    limits = t.app.get(ApiRateLimits);
    org = await seedOrg(db, 'Limits');
    const owner = await seedUser(db, { memberships: [{ orgId: org, role: 'owner' }] });
    const browser = await signIn(owner);
    const json = async (response: Promise<LightMyRequestResponse>) => {
      const result = await response;
      expect(result.statusCode, result.body).toBeLessThan(300);
      return result.json<{ id: string }>();
    };
    const workspace = await json(post(browser, `/orgs/${org}/workspaces`, { name: 'W' }));
    baseId = (await json(post(browser, `/workspaces/${workspace.id}/bases`, { name: 'B' })))
      .id as Id<'bse'>;
    otherBaseId = (await json(post(browser, `/workspaces/${workspace.id}/bases`, { name: 'C' })))
      .id as Id<'bse'>;
    tableId = (await json(post(browser, `/bases/${baseId}/tables`, { name: 'T' }))).id as Id<'tbl'>;
    fieldId = (
      await json(post(browser, `/tables/${tableId}/fields`, { name: 'N', type: 'number' }))
    ).id as Id<'fld'>;
  });

  afterEach(() => {
    limits.perPrincipal = DEFAULT_PRINCIPAL_RATE_LIMIT;
    limits.perBase = DEFAULT_BASE_RATE_LIMIT;
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  async function signIn(user: SeededUser): Promise<Browser> {
    const browser = new Browser(t.app);
    expect((await browser.login(user.email)).statusCode).toBe(204);
    return browser;
  }

  function post(browser: Browser, url: string, payload: object) {
    return browser.request({ method: 'POST', url: `/api/v1${url}`, payload });
  }

  function get(browser: Browser, url: string) {
    return browser.request({ method: 'GET', url: `/api/v1${url}` });
  }

  /** A fresh owner of the organization and fresh counters (a new window length). */
  async function freshCaller(): Promise<Browser> {
    window += 1;
    return signIn(await seedUser(db, { memberships: [{ orgId: org, role: 'owner' }] }));
  }

  function expectLimited(response: LightMyRequestResponse): void {
    expect(response.statusCode).toBe(429);
    expect(problemOf(response.body).code).toBe('RATE_LIMITED');
    expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  }

  it('limits every authenticated route per principal, not only records', async () => {
    const browser = await freshCaller();
    limits.perPrincipal = { limit: 2, windowSeconds: window };
    expect((await get(browser, `/orgs/${org}`)).statusCode).toBe(200);
    expect((await get(browser, '/me')).statusCode).toBe(200);
    expectLimited(await get(browser, `/orgs/${org}/workspaces`));
    // Another user has their own budget.
    const other = await freshCaller();
    limits.perPrincipal = { limit: 2, windowSeconds: window };
    expect((await get(other, `/orgs/${org}`)).statusCode).toBe(200);
  });

  it('limits requests on a base, its tables and fields per principal and base', async () => {
    const browser = await freshCaller();
    limits.perBase = { limit: 3, windowSeconds: window };
    expect((await get(browser, `/bases/${baseId}`)).statusCode).toBe(200);
    expect((await get(browser, `/tables/${tableId}`)).statusCode).toBe(200);
    expect((await get(browser, `/fields/${fieldId}`)).statusCode).toBe(200);
    expectLimited(await get(browser, `/tables/${tableId}/fields`));
    // Another base keeps its own budget; routes without a base are not counted per base.
    expect((await get(browser, `/bases/${otherBaseId}`)).statusCode).toBe(200);
    expect((await get(browser, `/orgs/${org}`)).statusCode).toBe(200);
  });

  it('counts records/query against the principal only (grid scrolling)', async () => {
    const browser = await freshCaller();
    limits.perBase = { limit: 1, windowSeconds: window };
    for (let i = 0; i < 4; i += 1) {
      const response = await post(browser, `/tables/${tableId}/records/query`, { limit: 1 });
      expect(response.statusCode, response.body).toBe(200);
    }
    // Other record routes of the base are still limited per base.
    expect((await get(browser, `/tables/${tableId}/records?limit=1`)).statusCode).toBe(200);
    expectLimited(await get(browser, `/tables/${tableId}/records?limit=1`));

    limits.perPrincipal = { limit: 1, windowSeconds: window + 100 };
    expect((await post(browser, `/tables/${tableId}/records/query`, { limit: 1 })).statusCode).toBe(
      200,
    );
    expectLimited(await post(browser, `/tables/${tableId}/records/query`, { limit: 1 }));
  });

  it('never counts probes, metrics or unauthenticated requests', async () => {
    window += 1;
    limits.perPrincipal = { limit: 1, windowSeconds: window };
    for (let i = 0; i < 3; i += 1) {
      expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    }
    const anonymous = new Browser(t.app);
    for (let i = 0; i < 3; i += 1) {
      expect((await get(anonymous, '/me')).statusCode).toBe(401);
    }
  });
});
