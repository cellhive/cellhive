import {
  aiUsageSchema,
  createdApiTokenSchema,
  TIME_ZONE_HINT,
  type CreatedApiToken,
} from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AiAccess } from '../../src/modules/ai/ai-access.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { listen } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';
import type { LightMyRequestResponse } from 'fastify';

const DAY = 86_400_000;
/** Well-formed ids of things that do not exist: the request is refused before any lookup. */
const WIDGET = 'wgt_T1005NoWidget001';
const SHARE_TOKEN = 'shr_T1005NoShareLink0000000000000000';

type Method = 'GET' | 'POST' | 'PATCH';

/**
 * BACKLOG T1005 (CONTRACTS §1.1, §13, §21, §29.4, §30.4): a UTC offset is
 * refused as a time zone on every route that takes one — `422` with
 * `INVALID_TIME_ZONE` and `params.hint` at the zone's path, never converted
 * — and a legacy name is stored by its IANA primary name. The schemas are
 * tested one by one in `packages/contracts/test/time-zones.test.ts`, the CLI
 * `setup` in `test/unit/cli.test.ts`.
 */
describe('time zones: UTC offsets refused, legacy names stored by primary name (T1005)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let mcpUrl: URL;
  let token: CreatedApiToken;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    mcpUrl = new URL('/api/v1/mcp', (await listen(t.app)).replace('ws://', 'http://'));
    fx = await buildRecordFixture(t, db);
    const on = await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}`, {
      settings: { mcp: { enabled: true } },
    });
    expect(on.statusCode, on.body).toBe(200);
    const created = await fx.call('u_admin', 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: 'time zones',
      scopes: ['records:read', 'schema:read'],
      expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
    });
    expect(created.statusCode, created.body).toBe(201);
    token = createdApiTokenSchema.parse(created.json());
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  interface Route {
    readonly name: string;
    readonly user: FixtureUser;
    readonly method: Method;
    readonly url: (zone: string) => string;
    readonly body?: (zone: string) => unknown;
    readonly code?: string;
    readonly path: string;
  }

  const q = encodeURIComponent;
  const routes = (): Route[] => [
    {
      name: 'PATCH /me',
      user: 'u_editor',
      method: 'PATCH',
      url: () => '/me',
      body: (timezone) => ({ timezone }),
      path: 'timezone',
    },
    {
      name: 'POST /orgs',
      user: 'owner',
      method: 'POST',
      url: () => '/orgs',
      body: (timezone) => ({ name: 'Zoned', timezone }),
      path: 'timezone',
    },
    {
      name: 'PATCH /orgs/:id',
      user: 'owner',
      method: 'PATCH',
      url: () => `/orgs/${fx.orgId}`,
      body: (timezone) => ({ settings: { timezone } }),
      path: 'settings.timezone',
    },
    {
      name: 'POST /invitations/:token/accept',
      user: 'stranger',
      method: 'POST',
      url: () => '/invitations/inv_T1005NoInvitationToken0000000000/accept',
      body: (timezone) => ({ timezone }),
      path: 'timezone',
    },
    {
      name: 'POST /tables/:id/fields (date field)',
      user: 'u_admin',
      method: 'POST',
      url: () => `/tables/${fx.tickets.id}/fields`,
      body: (timezone) => ({ name: 'Zoned', type: 'datetime', options: { timezone } }),
      path: 'options.timezone',
    },
    {
      name: 'POST /bases/:id/automations (schedule)',
      user: 'u_admin',
      method: 'POST',
      url: () => `/bases/${fx.baseId}/automations`,
      body: (timezone) => ({
        name: 'Zoned',
        definition: { trigger: { type: 'schedule', cron: '0 8 * * *', timezone }, actions: [] },
      }),
      code: 'AUTOMATION_INVALID',
      path: 'definition.trigger.timezone',
    },
    {
      name: 'POST /widgets/:id/data',
      user: 'u_admin',
      method: 'POST',
      url: () => `/widgets/${WIDGET}/data`,
      body: (timezone) => ({ timezone }),
      path: 'timezone',
    },
    {
      name: 'POST /widgets/:id/options',
      user: 'u_admin',
      method: 'POST',
      url: () => `/widgets/${WIDGET}/options`,
      body: (timezone) => ({ timezone }),
      path: 'timezone',
    },
    {
      name: 'POST /widgets/:id/records',
      user: 'u_admin',
      method: 'POST',
      url: () => `/widgets/${WIDGET}/records`,
      body: (timezone) => ({ timezone }),
      path: 'timezone',
    },
    {
      name: 'GET /widgets/:id/export',
      user: 'u_admin',
      method: 'GET',
      url: (timezone) => `/widgets/${WIDGET}/export?format=csv&timezone=${q(timezone)}`,
      path: 'timezone',
    },
    {
      name: 'POST /shares/:token/widgets/:id/data',
      user: 'stranger',
      method: 'POST',
      url: () => `/shares/${SHARE_TOKEN}/widgets/${WIDGET}/data`,
      body: (timezone) => ({ timezone }),
      path: 'timezone',
    },
    {
      name: 'GET /shares/:token/export',
      user: 'stranger',
      method: 'GET',
      url: (tz) => `/shares/${SHARE_TOKEN}/export?format=csv&tz=${q(tz)}`,
      path: 'tz',
    },
    {
      name: 'POST /tables/:id/ai/ask',
      user: 'u_admin',
      method: 'POST',
      url: () => `/tables/${fx.orders.id}/ai/ask`,
      body: (timezone) => ({ question: 'Orders by month', timezone }),
      path: 'timezone',
    },
  ];

  const send = (route: Route, zone: string): Promise<LightMyRequestResponse> =>
    fx.call(route.user, route.method, route.url(zone), route.body?.(zone));

  describe.each(['+07:00', '-0530', '+7', 'UTC+7', 'GMT+07:00'])('the offset %s', (zone) => {
    it.each(routes().map((route) => [route.name, route] as const))(
      '%s → 422 INVALID_TIME_ZONE with a hint',
      async (_name, route) => {
        const response = await send(route, zone);
        expect(response.statusCode, response.body).toBe(422);
        expect(response.json()).toMatchObject({
          code: route.code ?? 'VALIDATION_FAILED',
          errors: [
            {
              path: route.path,
              code: 'INVALID_TIME_ZONE',
              message: expect.stringContaining('UTC offset') as string,
              params: { hint: TIME_ZONE_HINT },
            },
          ],
        });
      },
    );

    it('MCP aggregate_records → isError VALIDATION_FAILED at timezone, IANA names only', async () => {
      const response = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'aggregate_records',
            arguments: {
              table_id: fx.orders.id,
              metrics: [{ aggregation: 'count' }],
              timezone: zone,
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      const { result } = (await response.json()) as {
        result: { isError?: boolean; structuredContent?: unknown };
      };
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        code: 'VALIDATION_FAILED',
        message: expect.any(String) as string,
        errors: [
          {
            path: 'timezone',
            code: 'INVALID_TIME_ZONE',
            message: expect.stringContaining('UTC offset') as string,
            params: { hint: TIME_ZONE_HINT },
          },
        ],
        total: 1,
      });
    });
  });

  it('the MCP tool says it takes IANA names and no offsets', async () => {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const { result } = (await response.json()) as {
      result: {
        tools: {
          name: string;
          inputSchema: { properties: Record<string, { description?: string }> };
        }[];
      };
    };
    const tool = result.tools.find((item) => item.name === 'aggregate_records');
    expect(tool?.inputSchema.properties['timezone']?.description).toMatch(
      /IANA time zone name.*UTC offsets .* are not accepted/su,
    );
  });

  it('stores EST5EDT and SystemV/* names by their IANA primary name', async () => {
    const me = await fx.call('u_editor', 'PATCH', '/me', { timezone: 'EST5EDT' });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json<{ timezone: string }>().timezone).toBe('America/New_York');

    const field = await fx.call('u_admin', 'POST', `/tables/${fx.tickets.id}/fields`, {
      name: 'Pacific',
      type: 'datetime',
      options: { timezone: 'SystemV/PST8PDT' },
    });
    expect(field.statusCode, field.body).toBe(201);
    expect(field.json<{ options: { timezone: string } }>().options.timezone).toBe(
      'America/Los_Angeles',
    );

    const automation = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'Central',
      definition: {
        trigger: { type: 'schedule', cron: '0 8 * * *', timezone: 'CST6CDT' },
        actions: [],
      },
    });
    expect(automation.statusCode, automation.body).toBe(201);
    expect(
      automation.json<{ definition: { trigger: { timezone: string } } }>().definition.trigger
        .timezone,
    ).toBe('America/Chicago');

    const fixed = await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}`, {
      settings: { timezone: 'Etc/GMT-7' },
    });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(fixed.json<{ settings: { timezone: string } }>().settings.timezone).toBe('Etc/GMT-7');
  });

  it('the AI quota day follows the organization zone set with PATCH /orgs/:id', async () => {
    const access = t.app.get(AiAccess);
    const usage = async () =>
      aiUsageSchema.parse((await fx.call('owner', 'GET', `/orgs/${fx.orgId}/ai-usage`)).json());
    access.now = () => new Date('2027-03-14T16:30:00Z');
    try {
      for (const [timezone, today, resetAt] of [
        // 23:30 in Ho Chi Minh City: the day ends at 17:00 UTC.
        ['Asia/Ho_Chi_Minh', '2027-03-14', '2027-03-14T17:00:00.000Z'],
        // 06:30 on the 15th at UTC+14.
        ['Etc/GMT-14', '2027-03-15', '2027-03-15T10:00:00.000Z'],
        // 12:30 in New York (daylight saving time since 07:00 UTC that day).
        ['EST5EDT', '2027-03-14', '2027-03-15T04:00:00.000Z'],
      ] as const) {
        const saved = await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}`, {
          settings: { timezone },
        });
        expect(saved.statusCode, saved.body).toBe(200);
        expect(await usage()).toMatchObject({
          to: today,
          time_zone: timezone === 'EST5EDT' ? 'America/New_York' : timezone,
          quota: { reset_at: resetAt },
        });
      }
    } finally {
      access.now = () => new Date();
    }
  });
});
