import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createdShareLinkSchema,
  dashboardListSchema,
  dashboardSchema,
  fieldListSchema,
  meResponseSchema,
  newId,
  buttonClickResponseSchema,
  recordGroupCountsResponseSchema,
  recordListResponseSchema,
  roleListSchema,
  roleSchema,
  shareMetaSchema,
  viewListSchema,
  viewSchema,
  widgetDataSchema,
  type Id,
} from '@cellhive/contracts';
import { loadConfig } from '@cellhive/server-core';
import { createWorker, CRON_ITEMS } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { PasswordHasher } from '../../src/common/auth/password/password-hasher.js';
import {
  DEMO_AUTOMATION_NAMES,
  DEMO_BUTTON_FIELD,
  DEMO_IDENTITY_NAMES,
  DEMO_IT_SMTP,
  DEMO_TELEGRAM_BOT,
} from '../../src/seed/demo-automations.js';
import { DEMO_COMPUTED_FIELDS } from '../../src/seed/demo-computed.js';
import {
  DEMO_BASE,
  DEMO_GROUP_NAME,
  DEMO_ORG,
  DEMO_PASSWORD,
  DEMO_USERS,
  DEMO_WORKSPACE_NAME,
  demoUsersOf,
  type DemoUserKey,
} from '../../src/seed/demo-fixture.js';
import {
  DEMO_ASSIGN_FIELDS,
  DEMO_FOLLOWS,
  DEMO_REMINDER,
} from '../../src/seed/demo-notifications.js';
import {
  DEMO_API_TOKEN,
  DEMO_HTTP_SECRET,
  DEMO_REVOKED_API_TOKEN,
  DEMO_WAREHOUSE_ROLE,
} from '../../src/seed/demo-s6.js';
import { DEMO_COLOR_RULE, DEMO_DASHBOARD, DEMO_S7_FIELDS } from '../../src/seed/demo-s7.js';
import { DEMO_TABLE_NAMES, orderLineCountFor } from '../../src/seed/demo-tables.js';
import { DEMO_VIEW_NAMES } from '../../src/seed/demo-views.js';
import {
  DEMO_ALLOWLIST_PATTERN,
  DEMO_HTTP_REQUEST_URL,
  DEMO_INCOMING_WEBHOOK,
  DEMO_WEBHOOK_AUTOMATION_NAMES,
} from '../../src/seed/demo-webhooks.js';
import { runSeed } from '../../src/seed/run.js';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { relaxRateLimits } from './record-fixture.js';
import {
  captureLogger,
  problemOf,
  startTestApp,
  TEST_PUBLIC_URL,
  TEST_SESSION_SECRET,
  type TestApp,
} from './support.js';

import type { Db, Env } from '@cellhive/server-core';
import type { LightMyRequestResponse } from 'fastify';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Smaller than CONTRACTS §9 (covered by the T108 seed test) to keep this test fast. */
const TABLE_COUNTS = { customers: 12, tickets: 30, orders: 40 } as const;

/** Exact `total` of a record list (small tables are always counted exactly). */
function totalOf(body: unknown): number {
  const list = recordListResponseSchema.parse(body);
  if (!('total' in list)) throw new Error('expected an exact total');
  return list.total;
}

interface SeedRun {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

/**
 * T012: `pnpm seed:demo` against a migrated database: the demo data of
 * CONTRACTS §9 created through the API services (events + audit), an
 * idempotent re-run and the production guard.
 */
describe('pnpm seed:demo (T012)', () => {
  let storageRoot: string;

  function env(databaseUrl: string, overrides: Env = {}): Env {
    return {
      NODE_ENV: 'development',
      PUBLIC_URL: TEST_PUBLIC_URL,
      DATABASE_URL: databaseUrl,
      // Own logical database: the seed's invitation rate limit counts per IP.
      CACHE_URL: `${inject('cacheUrl')}/5`,
      APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      SESSION_SECRET: TEST_SESSION_SECRET,
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_PATH: storageRoot,
      LOG_LEVEL: 'warn',
      ...overrides,
    };
  }

  async function seed(databaseUrl: string, argv: string[] = [], overrides: Env = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSeed(
      argv,
      env(databaseUrl, overrides),
      {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      },
      { tableCounts: TABLE_COUNTS },
    );
    return { code, out, err } satisfies SeedRun;
  }

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'cellhive-seed-'));
  });

  afterAll(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  describe('in development', () => {
    let database: TestDatabase;
    let db: Db;
    let first: SeedRun;

    beforeAll(async () => {
      database = await createMigratedDatabase();
      db = createTestDb(database.url);
      first = await seed(database.url);
    });

    afterAll(async () => {
      await db.destroy();
      await database.drop();
    });

    it('succeeds and prints every user with the demo password', () => {
      expect(first.err.join('\n')).not.toMatch(/fail/i);
      // The Sales role config is stored as given (no normalisation adjustments).
      expect(first.err.join('\n')).not.toContain('Warning');
      expect(first.code).toBe(0);
      const summary = first.out.join('\n');
      for (const user of DEMO_USERS) {
        const row = first.out.find((line) => line.includes(user.email));
        expect(row).toBeDefined();
        expect(row).toContain(DEMO_PASSWORD);
        expect(row).toContain(user.displayName);
      }
      expect(summary).toContain(DEMO_ORG.name);
      expect(summary).toContain(DEMO_BASE.name);
    });

    it('creates the organization with the six users and their roles', async () => {
      const orgs = await db.kysely.selectFrom('meta.organizations').selectAll().execute();
      expect(orgs).toHaveLength(1);
      const org = orgs[0];
      expect(org?.name).toBe(DEMO_ORG.name);
      expect(org?.settings).toEqual(DEMO_ORG.settings);

      const members = await db.kysely
        .selectFrom('meta.org_members as m')
        .innerJoin('meta.users as u', 'u.id', 'm.user_id')
        .select(['u.email', 'u.display_name', 'u.password_hash', 'm.role'])
        .execute();
      expect(members).toHaveLength(DEMO_USERS.length);
      const hasher = new PasswordHasher();
      for (const demo of DEMO_USERS) {
        const member = members.find((row) => row.email === demo.email);
        expect(member?.display_name).toBe(demo.displayName);
        expect(member?.role).toBe(demo.key === 'u_admin' ? 'owner' : 'member');
        expect(await hasher.verify(member?.password_hash ?? '', DEMO_PASSWORD)).toBe(true);
      }
    });

    it('creates the Sales group, the workspace and the base with its system roles', async () => {
      const userId = async (key: string) =>
        (
          await db.kysely
            .selectFrom('meta.users')
            .select('id')
            .where('email', '=', DEMO_USERS.find((user) => user.key === key)?.email ?? '')
            .executeTakeFirstOrThrow()
        ).id;

      const group = await db.kysely
        .selectFrom('meta.groups')
        .selectAll()
        .where('name', '=', DEMO_GROUP_NAME)
        .executeTakeFirstOrThrow();
      const groupMembers = await db.kysely
        .selectFrom('meta.group_members')
        .select('user_id')
        .where('group_id', '=', group.id)
        .execute();
      expect(groupMembers.map((row) => row.user_id).sort()).toEqual(
        [await userId('u_sales1'), await userId('u_sales2')].sort(),
      );

      const workspace = await db.kysely
        .selectFrom('meta.workspaces')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(workspace.name).toBe(DEMO_WORKSPACE_NAME);
      const workspaceMembers = await db.kysely
        .selectFrom('meta.workspace_members')
        .select(['principal_type', 'principal_id', 'role'])
        .where('workspace_id', '=', workspace.id)
        .execute();
      expect(workspaceMembers).toHaveLength(3);
      expect(workspaceMembers).toEqual(
        expect.arrayContaining([
          { principal_type: 'user', principal_id: await userId('u_editor'), role: 'member' },
          { principal_type: 'user', principal_id: await userId('u_reader'), role: 'member' },
          { principal_type: 'group', principal_id: group.id, role: 'member' },
        ]),
      );

      const base = await db.kysely.selectFrom('meta.bases').selectAll().executeTakeFirstOrThrow();
      expect(base).toMatchObject({
        name: DEMO_BASE.name,
        workspace_id: workspace.id,
        owner_id: await userId('u_admin'),
      });
      const roles = await db.kysely
        .selectFrom('meta.base_roles')
        .select(['id', 'kind', 'name'])
        .where('base_id', '=', base.id)
        .execute();
      // Sales and, since T719, "Kho".
      expect(roles.map((role) => role.kind).sort()).toEqual([
        'custom',
        'custom',
        'system_admin',
        'system_editor',
        'system_reader',
      ]);
      const roleOf = (kind: string) => roles.find((role) => role.kind === kind)?.id;
      const assignments = await db.kysely
        .selectFrom('meta.base_role_members')
        .select(['principal_type', 'principal_id', 'role_id'])
        .where('base_id', '=', base.id)
        .execute();
      expect(assignments).toHaveLength(3);
      expect(assignments).toEqual(
        expect.arrayContaining([
          {
            principal_type: 'group',
            principal_id: group.id,
            role_id: roles.find((role) => role.name === 'Sales')?.id,
          },
          {
            principal_type: 'user',
            principal_id: await userId('u_editor'),
            role_id: roleOf('system_editor'),
          },
          {
            principal_type: 'user',
            principal_id: await userId('u_reader'),
            role_id: roleOf('system_reader'),
          },
        ]),
      );
      expect(Number(base.permission_version)).toBeGreaterThan(0);
    });

    it('writes the events and audit entries of every step', async () => {
      const events = await db.kysely.selectFrom('meta.events').select('type').execute();
      const count = (type: string) => events.filter((event) => event.type === type).length;
      expect({
        org: count('org.created'),
        orgMembers: count('org_member.added'),
        invited: count('invitation.created'),
        accepted: count('invitation.accepted'),
        workspace: count('workspace.created'),
        workspaceMembers: count('workspace_member.added'),
        group: count('group.created'),
        groupMembers: count('group_member.added'),
        base: count('base.created'),
        roles: count('role.created'),
        assignments: count('role_assignment.changed'),
        tables: count('table.created'),
        records: count('record.created'),
      }).toEqual({
        org: 1,
        orgMembers: DEMO_USERS.length,
        invited: DEMO_USERS.length - 1,
        accepted: DEMO_USERS.length - 1,
        workspace: 1,
        workspaceMembers: 3,
        group: 1,
        groupMembers: 2,
        base: 1,
        // Three system roles, Sales and "Kho" (T719).
        roles: 5,
        assignments: 3,
        // BACKLOG T412: a 4th table, "Chi tiết đơn hàng" (order lines).
        tables: 4,
        records:
          TABLE_COUNTS.customers +
          TABLE_COUNTS.tickets +
          TABLE_COUNTS.orders +
          orderLineCountFor(TABLE_COUNTS.orders),
      });
      // Role changes go through RoleService, which also emits `permission.changed`.
      expect(count('permission.changed')).toBeGreaterThanOrEqual(4);

      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['action', 'actor_type'])
        .execute();
      // Every event is audited (CONTRACTS §8), plus `setup.completed`, the
      // audit-only `secret.created` of the sample Telegram bot (CONTRACTS §24)
      // and `http_allowlist.created` of the sample entry (CONTRACTS §25.4),
      // `secret.created` of the sample HTTP secret (T719).
      expect(audit).toHaveLength(events.length + 4);
      expect(audit.filter((entry) => entry.action === 'secret.created')).toHaveLength(2);
      expect(audit.filter((entry) => entry.action === 'http_allowlist.created')).toHaveLength(1);
      expect(count('incoming_webhook.created')).toBe(1);
      expect(audit.filter((entry) => entry.action === 'setup.completed')).toEqual([
        { action: 'setup.completed', actor_type: 'system' },
      ]);
    });

    it('creates the S5 samples through the services (T519)', async () => {
      const automations = await db.kysely
        .selectFrom('meta.automations as a')
        .innerJoin('meta.users as u', 'u.id', 'a.run_as_user_id')
        .select(['a.name', 'a.enabled', 'a.trigger_type', 'u.email'])
        .orderBy('a.created_at')
        .orderBy('a.id')
        .execute();
      const admin = DEMO_USERS[0]?.email;
      // No SMTP in this test: the "Khẩn cấp" email automation stays off.
      expect(automations).toEqual([
        {
          name: DEMO_AUTOMATION_NAMES.urgent,
          enabled: false,
          trigger_type: 'record.matches',
          email: admin,
        },
        {
          name: DEMO_AUTOMATION_NAMES.sla,
          enabled: true,
          trigger_type: 'record.created',
          email: admin,
        },
        {
          name: DEMO_AUTOMATION_NAMES.digest,
          enabled: false,
          trigger_type: 'schedule',
          email: admin,
        },
        {
          name: DEMO_AUTOMATION_NAMES.approve,
          enabled: true,
          trigger_type: 'button.clicked',
          email: admin,
        },
        {
          name: DEMO_AUTOMATION_NAMES.linesTotal,
          enabled: true,
          trigger_type: 'record.updated',
          email: admin,
        },
        {
          name: DEMO_AUTOMATION_NAMES.telegram,
          enabled: false,
          trigger_type: 'record.matches',
          email: admin,
        },
        // S5c (T615): created after the S5 ones, both off.
        {
          name: DEMO_WEBHOOK_AUTOMATION_NAMES.fromWebsite,
          enabled: false,
          trigger_type: 'webhook.received',
          email: admin,
        },
        {
          name: DEMO_WEBHOOK_AUTOMATION_NAMES.httpRequest,
          enabled: false,
          trigger_type: 'record.created',
          email: admin,
        },
      ]);
      const summary = first.out.join('\n');
      expect(summary).toContain('Automations (6, 3 on):');
      for (const automation of automations) expect(summary).toContain(automation.name);

      // Sender identities: never verified by the seed; the IT one has its own SMTP.
      const identities = await db.kysely
        .selectFrom('meta.email_identities')
        .select(['display_name', 'email', 'transport', 'mode', 'status', 'smtp_password_enc'])
        .orderBy('created_at')
        .execute();
      const offline = first.err.some((line) => line.includes('could not be resolved'));
      expect(
        identities.map(({ display_name, email, transport, mode, status }) => ({
          display_name,
          email,
          transport,
          mode,
          status,
        })),
      ).toEqual([
        {
          display_name: DEMO_IDENTITY_NAMES.support,
          // No SMTP_FROM here: the demo domain, sent on behalf.
          email: 'support@demo.cellhive.local',
          transport: 'system',
          mode: 'on_behalf',
          status: 'pending',
        },
        {
          display_name: DEMO_IDENTITY_NAMES.hr,
          email: 'hr-demo@example.com',
          transport: 'system',
          mode: 'on_behalf',
          status: 'pending',
        },
        ...(offline
          ? []
          : [
              {
                display_name: DEMO_IDENTITY_NAMES.it,
                email: 'it-demo@example.com',
                transport: 'smtp',
                mode: 'send_as',
                status: 'pending',
              },
            ]),
      ]);
      // The placeholder password is sealed like any other, never stored as typed.
      const sealed = identities.find((identity) => identity.transport === 'smtp');
      if (sealed !== undefined) {
        expect(sealed.smtp_password_enc).not.toBeNull();
        expect(JSON.stringify(sealed.smtp_password_enc)).not.toContain(DEMO_IT_SMTP.password);
      }
      // No email left the seed: each verification email is recorded as not sent.
      const verifications = await db.kysely
        .selectFrom('meta.audit_logs')
        .select('after')
        .where('action', '=', 'email_identity.verification_sent')
        .execute();
      expect(verifications).toHaveLength(identities.length);
      for (const entry of verifications) {
        expect(entry.after).toMatchObject({ status: 'failed', code: 'smtp_not_configured' });
      }

      // The Telegram bot: a fake token, only for the demo base.
      const secrets = await db.kysely
        .selectFrom('meta.secrets')
        .select(['name', 'kind', 'base_scope', 'ciphertext'])
        .where('kind', '=', 'telegram_bot')
        .execute();
      expect(secrets.map(({ name, kind, base_scope }) => ({ name, kind, base_scope }))).toEqual([
        { name: DEMO_TELEGRAM_BOT.name, kind: 'telegram_bot', base_scope: 'selected' },
      ]);
      expect(JSON.stringify(secrets[0]?.ciphertext)).not.toContain(DEMO_TELEGRAM_BOT.token);

      const button = await db.kysely
        .selectFrom('meta.fields')
        .select(['type', 'db_column_name'])
        .where('name', '=', DEMO_BUTTON_FIELD.name)
        .executeTakeFirstOrThrow();
      expect(button).toEqual({ type: 'button', db_column_name: null });
    });

    it('settles the events of the sample data: no events.dispatch backlog (T519)', async () => {
      const { rows } = await sql<{ pending: number; jobs: number; records: number }>`
        SELECT (SELECT count(*)::int FROM meta.events WHERE dispatched_at IS NULL) AS pending,
               (SELECT count(*)::int FROM meta.events
                 WHERE type = 'record.created' AND dispatched_at IS NOT NULL) AS records,
               (SELECT count(*)::int FROM graphile_worker.jobs
                 WHERE task_identifier = 'events.dispatch') AS jobs
      `.execute(db.kysely);
      // Every record event is settled; only what came after the settlement
      // (identities, button field, automations, Sales role) is still queued.
      expect(rows[0]?.records).toBe(
        TABLE_COUNTS.customers +
          TABLE_COUNTS.tickets +
          TABLE_COUNTS.orders +
          orderLineCountFor(TABLE_COUNTS.orders),
      );
      expect(rows[0]?.pending).toBe(rows[0]?.jobs);
      expect(rows[0]?.jobs).toBeLessThan(50);
    });

    it('creates the S5b samples: assignment flags, the Tickets reminder armed now, follows (T557)', async () => {
      const fields = await db.kysely
        .selectFrom('meta.fields as f')
        .innerJoin('meta.tables as t', 't.id', 'f.table_id')
        .select(['f.id', 'f.table_id', 'f.name', 'f.type', 'f.options', 't.name as table'])
        .where('f.deleted_at', 'is', null)
        .execute();
      const field = (table: string, name: string) => {
        const found = fields.find((item) => item.table === table && item.name === name);
        if (found === undefined) throw new Error(`no field ${table}.${name}`);
        return found;
      };
      for (const { table, name } of DEMO_ASSIGN_FIELDS) {
        const row = field(DEMO_TABLE_NAMES[table], name);
        expect(row.type).toBe('user');
        expect(row.options).toMatchObject({ notify_on_assign: true });
      }
      // No other user field tells its assignees.
      expect(
        fields.filter(
          (item) => (item.options as Record<string, unknown>)['notify_on_assign'] === true,
        ),
      ).toHaveLength(DEMO_ASSIGN_FIELDS.length);

      const due = field(DEMO_TABLE_NAMES.tickets, DEMO_REMINDER.field);
      const assignee = field(DEMO_TABLE_NAMES.tickets, DEMO_REMINDER.recipientField);
      expect((due.options as Record<string, unknown>)['reminder']).toEqual({
        offset_minutes: -1_440,
        time_of_day: '09:00',
        recipients: 'field_user',
        user_field_id: assignee.id,
      });
      // Armed by the seed: only due moments after it are ever reminded.
      const cursors = await db.kysely
        .selectFrom('meta.date_reminder_cursors')
        .select(['field_id', 'armed_at', 'scanned_until'])
        .execute();
      expect(cursors.map((cursor) => cursor.field_id)).toEqual([due.id]);
      const armedAt = cursors[0]?.armed_at.getTime() ?? 0;
      expect(Date.now() - armedAt).toBeLessThan(10 * 60_000);
      expect(cursors[0]?.scanned_until.getTime()).toBeLessThanOrEqual(armedAt);

      const follows = await db.kysely
        .selectFrom('meta.record_follows as f')
        .innerJoin('meta.users as u', 'u.id', 'f.user_id')
        .innerJoin('meta.tables as t', 't.id', 'f.table_id')
        .select(['u.email', 't.name as table', 'f.source', 'f.muted'])
        .execute();
      const emailOf = (key: DemoUserKey) => DEMO_USERS.find((user) => user.key === key)?.email;
      const expected = DEMO_FOLLOWS.flatMap((spec) =>
        Array.from({ length: spec.count }, () => ({
          email: emailOf(spec.user),
          table: DEMO_TABLE_NAMES[spec.table],
          source: 'manual',
          muted: false,
        })),
      );
      const order = (
        rows: readonly {
          email: string | undefined;
          table: string;
          source: string;
          muted: boolean;
        }[],
      ) =>
        rows
          .map((row) => `${row.email ?? ''}|${row.table}|${row.source}|${String(row.muted)}`)
          .sort();
      expect(order(follows)).toEqual(order(expected));
      // The editor follows tickets assigned to her.
      const editorTickets = await db.kysely
        .selectFrom('meta.record_follows as f')
        .innerJoin('meta.users as u', 'u.id', 'f.user_id')
        .select('f.record_id')
        .where('u.email', '=', emailOf('u_editor') ?? '')
        .where('f.table_id', '=', due.table_id)
        .execute();
      expect(editorTickets).toHaveLength(3);

      const summary = first.out.join('\n');
      expect(summary).toContain('Assignment notifications: Tickets · Phụ trách, Orders · owner');
      expect(summary).toContain('Due-date reminder: Tickets · Hạn');
      expect(summary).toContain('Sample follows: u_editor 5, u_admin 2, u_reader 2');
    });

    it('creates the S5c samples: a Bearer webhook, an allowlist entry, two automations off (T615)', async () => {
      const hooks = await db.kysely
        .selectFrom('meta.incoming_webhooks as h')
        .innerJoin('meta.bases as b', 'b.id', 'h.base_id')
        .innerJoin('meta.users as u', 'u.id', 'h.created_by')
        .select([
          'h.id',
          'h.name',
          'h.auth',
          'h.enabled',
          'h.rate_limit_per_sec',
          'h.signing_secret_enc',
          'h.bearer_hash',
          'b.name as base',
          'u.email',
        ])
        .execute();
      expect(hooks).toHaveLength(1);
      const hook = hooks[0];
      expect(hook).toMatchObject({
        name: DEMO_INCOMING_WEBHOOK.name,
        auth: 'bearer',
        enabled: true,
        rate_limit_per_sec: 5,
        signing_secret_enc: null,
        base: DEMO_BASE.name,
        email: DEMO_USERS[0]?.email,
      });
      expect(hook?.bearer_hash).not.toBeNull();

      const allowlist = await db.kysely
        .selectFrom('meta.http_allowlist')
        .select(['pattern', 'host', 'port', 'wildcard'])
        .execute();
      expect(allowlist).toEqual([
        { pattern: DEMO_ALLOWLIST_PATTERN, host: 'n8n.local', port: 5678, wildcard: false },
      ]);

      const automations = await db.kysely
        .selectFrom('meta.automations')
        .select(['name', 'enabled', 'description', 'definition'])
        .where('name', 'in', Object.values(DEMO_WEBHOOK_AUTOMATION_NAMES))
        .execute();
      const definitionOf = (name: string) =>
        automations.find((item) => item.name === name)?.definition as {
          trigger: Record<string, unknown>;
          actions: { type: string; config: Record<string, unknown> }[];
        };
      const fromWebsite = definitionOf(DEMO_WEBHOOK_AUTOMATION_NAMES.fromWebsite);
      expect(fromWebsite.trigger).toEqual({
        type: 'webhook.received',
        incoming_webhook_id: hook?.id,
      });
      expect(fromWebsite.actions.map((action) => action.type)).toEqual(['create_record']);
      const http = definitionOf(DEMO_WEBHOOK_AUTOMATION_NAMES.httpRequest);
      expect(http.actions[0]).toMatchObject({
        type: 'http_request',
        config: { method: 'POST', url: { literal: DEMO_HTTP_REQUEST_URL } },
      });
      expect(automations.every((item) => !item.enabled)).toBe(true);
      expect(
        automations.find((item) => item.name === DEMO_WEBHOOK_AUTOMATION_NAMES.httpRequest)
          ?.description,
      ).toContain('localhost:9');

      // The seed sent nothing: no delivery, no request received, no sample.
      const { rows } = await sql<{ deliveries: number; requests: number }>`
        SELECT (SELECT count(*)::int FROM meta.http_deliveries) AS deliveries,
               (SELECT count(*)::int FROM meta.incoming_webhook_requests) AS requests
      `.execute(db.kysely);
      expect(rows[0]).toEqual({ deliveries: 0, requests: 0 });

      // The summary: the automations, the entry, the URL and the token (once, in development).
      const summary = first.out.join('\n');
      expect(summary).toContain('Automations with webhooks and HTTP (2, all off):');
      for (const name of Object.values(DEMO_WEBHOOK_AUTOMATION_NAMES)) {
        expect(summary).toContain(`off  ${name}`);
      }
      expect(summary).toContain(`HTTP allowlist: ${DEMO_ALLOWLIST_PATTERN}`);
      expect(summary).toMatch(
        new RegExp(`URL {4}${TEST_PUBLIC_URL}/api/v1/hooks/[A-Za-z0-9_-]{43}`, 'u'),
      );
      expect(summary).toMatch(/Token {2}[A-Za-z0-9_-]{43}/u);
    });

    it('creates the S6 samples: two API tokens (one revoked), an HTTP secret with hosts, the role Kho (T719)', async () => {
      const admin = DEMO_USERS[0];
      const tokens = await db.kysely
        .selectFrom('meta.api_tokens as t')
        .innerJoin('meta.users as u', 'u.id', 't.user_id')
        .select(['t.name', 't.scopes', 't.base_ids', 't.expires_at', 't.revoked_at', 'u.email'])
        .orderBy('t.created_at')
        .execute();
      expect(
        tokens.map(({ name, scopes, email, revoked_at }) => ({
          name,
          scopes,
          email,
          revoked: revoked_at !== null,
        })),
      ).toEqual([
        {
          name: DEMO_API_TOKEN.name,
          scopes: ['records:read', 'schema:read'],
          email: admin?.email,
          revoked: false,
        },
        {
          name: DEMO_REVOKED_API_TOKEN.name,
          scopes: ['records:write'],
          email: admin?.email,
          revoked: true,
        },
      ]);
      const base = await db.kysely
        .selectFrom('meta.bases')
        .select('id')
        .where('name', '=', DEMO_BASE.name)
        .executeTakeFirstOrThrow();
      expect(tokens[0]?.base_ids).toEqual([base.id]);
      const days = ((tokens[0]?.expires_at?.getTime() ?? 0) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89.9);
      expect(days).toBeLessThanOrEqual(90);

      const secrets = await db.kysely
        .selectFrom('meta.secrets')
        .select(['name', 'kind', 'allowed_hosts', 'base_scope'])
        .where('kind', '=', 'http_header')
        .execute();
      expect(secrets).toEqual([
        {
          name: DEMO_HTTP_SECRET.name,
          kind: 'http_header',
          allowed_hosts: [...DEMO_HTTP_SECRET.allowedHosts],
          base_scope: 'selected',
        },
      ]);

      const role = await db.kysely
        .selectFrom('meta.base_roles')
        .select(['id', 'kind', 'config'])
        .where('name', '=', DEMO_WAREHOUSE_ROLE.name)
        .executeTakeFirstOrThrow();
      expect(role.kind).toBe('custom');
      const config = role.config as {
        base_rule: Record<string, boolean>;
        tables: Record<
          string,
          { perm: string; record_rule: { read_scope: string; read_filter: unknown } }
        >;
      };
      expect(config.base_rule).toEqual({ copy: true, download: true, share_link: false });
      expect(
        Object.values(config.tables)
          .map((table) => table.perm)
          .sort(),
      ).toEqual(['edit', 'read_only', 'read_only']);
      const filtered = Object.values(config.tables).find(
        (table) => table.record_rule.read_scope === 'filter',
      );
      // The record rule on the link field Khách hàng (T710): three customers by id.
      expect(JSON.stringify(filtered?.record_rule.read_filter)).toMatch(
        /"value":\["rec_\w+","rec_\w+","rec_\w+"\],"operator":"has_any_of"/u,
      );
      // Nobody has it: the demo users keep the access of CONTRACTS §5.
      const members = await db.kysely
        .selectFrom('meta.base_role_members')
        .select('principal_id')
        .where('role_id', '=', role.id)
        .execute();
      expect(members).toEqual([]);

      // Audit of each step, as through the API.
      const actions = await db.kysely
        .selectFrom('meta.audit_logs')
        .select('action')
        .where('action', 'in', [
          'api_token.created',
          'api_token.revoked',
          'secret.created',
          'role.created',
        ])
        .execute();
      expect(actions.map((row) => row.action).sort()).toEqual([
        'api_token.created',
        'api_token.created',
        'api_token.revoked',
        // The three system roles of the base, Sales and Kho.
        'role.created',
        'role.created',
        'role.created',
        'role.created',
        'role.created',
        'secret.created',
        'secret.created',
      ]);

      // The summary: the token value once (development), the revoked one, the secret, the role.
      const summary = first.out.join('\n');
      expect(summary).toContain(
        `API token "${DEMO_API_TOKEN.name}" of u_admin (records:read + schema:read, this base only`,
      );
      expect(summary).toMatch(/Token {2}cht_[A-Za-z0-9]{36}/u);
      expect(summary).toContain(`Revoked API token: "${DEMO_REVOKED_API_TOKEN.name}"`);
      expect(summary).toContain(`allowed hosts ${DEMO_HTTP_SECRET.allowedHosts.join(', ')}`);
      expect(summary).toContain(`Role "${DEMO_WAREHOUSE_ROLE.name}"`);
      // The secret value is never printed.
      expect(summary).not.toContain(DEMO_HTTP_SECRET.value);
    });

    it('the printed API token reads the demo base only, and cannot write (T719)', async () => {
      const token = /Token {2}(cht_\S+)/u.exec(first.out.join('\n'))?.[1] ?? '';
      const t = await startTestApp({ DATABASE_URL: database.url });
      try {
        relaxRateLimits(t);
        const call = (method: Method, url: string, payload?: object) =>
          t.app.inject({
            method,
            url: `/api/v1${url}`,
            headers: { authorization: `Bearer ${token}` },
            ...(payload === undefined ? {} : { payload }),
          });
        const base = await db.kysely
          .selectFrom('meta.bases')
          .select('id')
          .where('name', '=', DEMO_BASE.name)
          .executeTakeFirstOrThrow();
        const orders = await db.kysely
          .selectFrom('meta.tables')
          .select('id')
          .where('base_id', '=', base.id)
          .where('name', '=', DEMO_TABLE_NAMES.orders)
          .executeTakeFirstOrThrow();
        expect((await call('GET', `/bases/${base.id}`)).statusCode).toBe(200);
        const read = await call('POST', `/tables/${orders.id}/records/query`, { limit: 2 });
        expect(read.statusCode, read.body).toBe(200);
        expect(recordListResponseSchema.parse(read.json()).records).toHaveLength(2);
        const created = await call('POST', `/tables/${orders.id}/records`, {
          records: [{ fields: {} }],
        });
        expect({ status: created.statusCode, code: problemOf(created.body).code }).toEqual({
          status: 403,
          code: 'INSUFFICIENT_SCOPE',
        });
      } finally {
        await t.close();
      }
    });

    it('notifies nobody about the sample data; a worker drains every job it left (T557)', async () => {
      const queued = await sql<{ task: string; n: number }>`
        SELECT task_identifier AS task, count(*)::int AS n FROM graphile_worker.jobs
         GROUP BY task_identifier ORDER BY task_identifier
      `.execute(db.kysely);
      // The dispatch of the steps after the settlement (T519) and the background
      // work of the data (thumbnails, finished backfills, auto numbers, run_as
      // check) — no notification, flush, delivery, Telegram poll or import job.
      const tasks = queued.rows.map((row) => row.task);
      expect(tasks).toContain('events.dispatch');
      expect(tasks.filter((task) => task.startsWith('notifications.'))).toEqual([]);
      expect(tasks).not.toContain('table.import');

      const worker = await createWorker(loadConfig(env(database.url)), {
        logger: captureLogger().logger,
        pollIntervalMs: 50,
      });
      try {
        const deadline = Date.now() + 120_000;
        for (;;) {
          const { rows } = await sql<{ pending: number; jobs: number }>`
            SELECT (SELECT count(*)::int FROM meta.events WHERE dispatched_at IS NULL) AS pending,
                   (SELECT count(*)::int FROM graphile_worker.jobs
                     WHERE task_identifier NOT IN (${sql.join(CRON_ITEMS.map((item) => item.task))})
                   ) AS jobs
          `.execute(db.kysely);
          if (rows[0]?.pending === 0 && rows[0].jobs === 0) break;
          if (Date.now() > deadline) throw new Error(`not drained: ${JSON.stringify(rows[0])}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally {
        await worker.close();
      }
      const { rows } = await sql<{
        notifications: number;
        deliveries: number;
        buffered: number;
        runs: number;
      }>`
        SELECT (SELECT count(*)::int FROM meta.notifications) AS notifications,
               (SELECT count(*)::int FROM meta.notification_deliveries) AS deliveries,
               (SELECT count(*)::int FROM meta.notification_buffer) AS buffered,
               (SELECT count(*)::int FROM meta.automation_runs) AS runs
      `.execute(db.kysely);
      expect(rows[0]).toEqual({ notifications: 0, deliveries: 0, buffered: 0, runs: 0 });
      // No Telegram channel is linked (it needs a real bot), no link is pending.
      const channels = await sql<{ n: number }>`
        SELECT (SELECT count(*)::int FROM meta.user_channels)
             + (SELECT count(*)::int FROM meta.user_channel_link_tokens) AS n
      `.execute(db.kysely);
      expect(channels.rows[0]?.n).toBe(0);
    });

    it('leaves no session behind', async () => {
      const sessions = await db.kysely.selectFrom('meta.sessions').select('id').execute();
      expect(sessions).toHaveLength(0);
    });

    it('the printed URL and Bearer token reach the sample hook; nothing runs, it is off (T615)', async () => {
      const summary = first.out.join('\n');
      const url = /URL {4}(\S+)/u.exec(summary)?.[1] ?? '';
      const token = /Token {2}(\S+)/u.exec(summary)?.[1] ?? '';
      const t = await startTestApp({ DATABASE_URL: database.url });
      try {
        const post = (authorization?: string) =>
          t.app.inject({
            method: 'POST',
            url: new URL(url).pathname,
            headers: {
              'content-type': 'application/json',
              ...(authorization === undefined ? {} : { authorization }),
            },
            payload: JSON.stringify({ title: 'Đơn thử từ website', amount: 1_500_000 }),
          });
        expect((await post()).statusCode).toBe(401);
        const accepted = await post(`Bearer ${token}`);
        expect(accepted.statusCode, accepted.body).toBe(202);
      } finally {
        await t.close();
      }
      // Recorded once; the automation is off, so no run will ever start from it.
      const { rows } = await sql<{ requests: number; runs: number }>`
        SELECT (SELECT count(*)::int FROM meta.incoming_webhook_requests) AS requests,
               (SELECT count(*)::int FROM meta.automation_runs) AS runs
      `.execute(db.kysely);
      expect(rows[0]).toEqual({ requests: 1, runs: 0 });
    });

    it('lets a seeded user sign in with the demo password', async () => {
      const t = await startTestApp({ DATABASE_URL: database.url });
      try {
        const browser = new Browser(t.app);
        const reader = DEMO_USERS.find((user) => user.key === 'u_reader');
        expect((await browser.login(reader?.email ?? '', DEMO_PASSWORD)).statusCode).toBe(204);
        const me = await browser.request({ method: 'GET', url: '/api/v1/me' });
        expect(me.statusCode).toBe(200);
        const body = meResponseSchema.parse(me.json());
        expect(body.user.email).toBe(reader?.email);
        expect(body.orgs.map((org) => org.name)).toEqual([DEMO_ORG.name]);
        expect(body.locale).toBe('vi');
      } finally {
        await t.close();
      }
    });

    it('creates the tables and the Sales role of CONTRACTS §5, enforced over HTTP', async () => {
      const tables = await db.kysely
        .selectFrom('meta.tables')
        .select(['id', 'name'])
        .where('deleted_at', 'is', null)
        .execute();
      const tableId = (name: string) => tables.find((table) => table.name === name)?.id ?? '';
      const orders = tableId('Orders');
      const fields = await db.kysely
        .selectFrom('meta.fields')
        .select(['id', 'name'])
        .where('table_id', '=', orders as Id<'tbl'>)
        .execute();
      const fieldId = (name: string) => fields.find((field) => field.name === name)?.id;
      const role = await db.kysely
        .selectFrom('meta.base_roles')
        .select(['name', 'config'])
        .where('kind', '=', 'custom')
        .where('name', '=', 'Sales')
        .executeTakeFirstOrThrow();
      expect(role.name).toBe('Sales');
      expect(role.config).toMatchObject({
        base_rule: { copy: false, download: false, share_link: false },
        tables: {
          [orders]: {
            perm: 'edit',
            view_rule: {
              allow_edit: false,
              visible_views: [expect.any(String), expect.any(String)],
            },
            record_rule: {
              operations: ['add'],
              edit_filter: {
                op: 'and',
                items: [
                  {
                    field: fieldId('owner'),
                    operator: 'has_any_of',
                    value: [{ $var: 'current_user' }],
                  },
                ],
              },
              read_scope: 'editable',
            },
            field_rule: {
              mode: 'specify',
              fields: { [fieldId('cost') ?? '']: 'no_perm', [fieldId('status') ?? '']: 'read' },
            },
          },
        },
      });

      const t = await startTestApp({ DATABASE_URL: database.url });
      try {
        const signIn = async (key: string) => {
          const browser = new Browser(t.app);
          const email = DEMO_USERS.find((user) => user.key === key)?.email ?? '';
          expect((await browser.login(email, DEMO_PASSWORD)).statusCode).toBe(204);
          return browser;
        };
        const query = (browser: Browser, table: string) =>
          browser.request({
            method: 'POST',
            url: `/api/v1/tables/${tableId(table)}/records/query`,
            payload: { limit: 100 },
          });

        const editor = await signIn('u_editor');
        for (const [name, count] of [
          ['Customers', TABLE_COUNTS.customers],
          ['Tickets', TABLE_COUNTS.tickets],
          ['Orders', TABLE_COUNTS.orders],
        ] as const) {
          const response = await query(editor, name);
          expect(response.statusCode).toBe(200);
          expect(totalOf(response.json())).toBe(count);
        }

        // Sales: only the orders it owns, without `cost`; no other table.
        const sales1 = await signIn('u_sales1');
        const sales1Id = (await sales1.request({ method: 'GET', url: '/api/v1/me' })).json<{
          user: { id: string };
        }>().user.id;
        const own = recordListResponseSchema.parse((await query(sales1, 'Orders')).json());
        expect(totalOf(own)).toBeGreaterThan(0);
        expect(totalOf(own)).toBeLessThan(TABLE_COUNTS.orders);
        for (const record of own.records) {
          expect(record.fields).not.toHaveProperty('cost');
          expect(record.fields.owner).toEqual([expect.objectContaining({ id: sales1Id })]);
        }
        expect((await query(sales1, 'Customers')).statusCode).toBe(404);
      } finally {
        await t.close();
      }
    });

    describe('views, share links and the permission matrix on the seeded data (T309)', () => {
      let t: TestApp;
      const browsers = new Map<DemoUserKey, Browser>();
      const ids = {} as Record<DemoUserKey, Id<'usr'>>;
      let baseId: Id<'bse'>;
      const tables = {} as Record<
        'Customers' | 'Tickets' | 'Orders' | 'Chi tiết đơn hàng',
        Id<'tbl'>
      >;

      beforeAll(async () => {
        t = await startTestApp({ DATABASE_URL: database.url });
        relaxRateLimits(t);
        for (const user of DEMO_USERS) {
          ids[user.key] = (
            await db.kysely
              .selectFrom('meta.users')
              .select('id')
              .where('email', '=', user.email)
              .executeTakeFirstOrThrow()
          ).id;
        }
        baseId = (await db.kysely.selectFrom('meta.bases').select('id').executeTakeFirstOrThrow())
          .id;
        for (const table of await db.kysely
          .selectFrom('meta.tables')
          .select(['id', 'name'])
          .execute()) {
          tables[table.name as keyof typeof tables] = table.id;
        }
      });

      afterAll(async () => {
        await t.close();
      });

      async function as(key: DemoUserKey): Promise<Browser> {
        let browser = browsers.get(key);
        if (browser === undefined) {
          browser = new Browser(t.app);
          const email = DEMO_USERS.find((user) => user.key === key)?.email ?? '';
          expect((await browser.login(email, DEMO_PASSWORD)).statusCode).toBe(204);
          browsers.set(key, browser);
        }
        return browser;
      }

      async function call(
        key: DemoUserKey,
        method: Method,
        url: string,
        payload?: object,
      ): Promise<LightMyRequestResponse> {
        return (await as(key)).request({
          method,
          url: `/api/v1${url}`,
          ...(payload === undefined ? {} : { payload }),
        });
      }

      async function viewsOf(key: DemoUserKey, table: keyof typeof tables) {
        const response = await call(key, 'GET', `/tables/${tables[table]}/views`);
        expect(response.statusCode, response.body).toBe(200);
        return viewListSchema.parse(response.json()).items;
      }

      async function viewId(table: keyof typeof tables, name: string): Promise<Id<'viw'>> {
        const view = (await viewsOf('u_admin', table)).find((item) => item.name === name);
        if (view === undefined) throw new Error(`no view ${name}`);
        return view.id;
      }

      function expectProblem(response: LightMyRequestResponse, status: number, code: string) {
        expect({ status: response.statusCode, code: problemOf(response.body).code }).toEqual({
          status,
          code,
        });
      }

      const orderQuery = (key: DemoUserKey, body: object = {}) =>
        call(key, 'POST', `/tables/${tables.Orders}/records/query`, { limit: 100, ...body });

      it('creates the shared views of every table, in order', async () => {
        const names = async (key: DemoUserKey, table: keyof typeof tables) =>
          (await viewsOf(key, table)).map((view) => `${view.type}:${view.name}`);
        const v = DEMO_VIEW_NAMES;
        expect(await names('u_admin', 'Customers')).toEqual([
          `grid:${v.customers.all}`,
          `grid:${v.customers.byTier}`,
          `grid:${v.customers.vip}`,
        ]);
        const tickets = [
          `grid:${v.tickets.all}`,
          `grid:${v.tickets.mine}`,
          `grid:${v.tickets.open}`,
          `grid:${v.tickets.byStatus}`,
          `kanban:${v.tickets.kanban}`,
          `form:${v.tickets.form}`,
        ];
        expect(await names('u_admin', 'Tickets')).toEqual(tickets);
        // The personal view of u_editor: listed for its owner only.
        expect(await names('u_editor', 'Tickets')).toEqual([
          ...tickets,
          `grid:${v.tickets.editorUrgent}`,
        ]);
        expect(await names('u_admin', 'Orders')).toEqual([
          `grid:${v.orders.all}`,
          `grid:${v.orders.mine}`,
          `grid:${v.orders.highCost}`,
        ]);
        // T421b: no English default name ("Grid view") left in the demo.
        expect(await names('u_admin', 'Chi tiết đơn hàng')).toEqual([`grid:${v.orderLines.all}`]);
        // Sales sees only its views ("Đơn của tôi" first: the grid opens there).
        expect(await names('u_sales1', 'Orders')).toEqual([
          `grid:${v.orders.mine}`,
          `grid:${v.orders.highCost}`,
        ]);
        const form = (await viewsOf('u_admin', 'Tickets')).find((view) => view.type === 'form');
        expect(form?.config.form).toMatchObject({ require_login: false, submission_limit: 'none' });
        const counts = await call(
          'u_admin',
          'POST',
          `/tables/${tables.Customers}/records/group-counts`,
          { view_id: await viewId('Customers', v.customers.byTier) },
        );
        expect(counts.statusCode, counts.body).toBe(200);
        const groups = recordGroupCountsResponseSchema.parse(counts.json()).groups;
        expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(TABLE_COUNTS.customers);
      });

      it('hides the cost condition of "Đơn giá vốn cao" from Sales, and still applies it', async () => {
        const highCost = await viewId('Orders', DEMO_VIEW_NAMES.orders.highCost);
        const adminView = viewSchema.parse(
          (await call('u_admin', 'GET', `/views/${highCost}`)).json(),
        );
        expect(JSON.stringify(adminView.config.filter)).toContain('gte');
        const salesView = viewSchema.parse(
          (await call('u_sales1', 'GET', `/views/${highCost}`)).json(),
        );
        expect(salesView.config.filter).toBeNull();

        const costOf = new Map(
          recordListResponseSchema
            .parse((await orderQuery('u_admin', { view_id: highCost })).json())
            .records.map((record) => [record.id, record.fields['cost']]),
        );
        const sales = recordListResponseSchema.parse(
          (await orderQuery('u_sales1', { view_id: highCost })).json(),
        );
        for (const record of sales.records) {
          expect(record.fields).not.toHaveProperty('cost');
          expect(costOf.get(record.id)).toBeGreaterThanOrEqual(3_000_000);
          expect(record.fields['owner']).toEqual([expect.objectContaining({ id: ids.u_sales1 })]);
        }
      });

      it('P16: u_sales1 through "Tất cả đơn hàng" → 404, through "Đơn của tôi" → only its orders', async () => {
        const all = await viewId('Orders', DEMO_VIEW_NAMES.orders.all);
        const mineId = await viewId('Orders', DEMO_VIEW_NAMES.orders.mine);
        expectProblem(await orderQuery('u_sales1', { view_id: all }), 404, 'NOT_FOUND');
        expectProblem(
          await call('u_sales1', 'GET', `/tables/${tables.Orders}/records?view_id=${all}`),
          404,
          'NOT_FOUND',
        );
        const mine = await orderQuery('u_sales1', { view_id: mineId });
        expect(mine.statusCode, mine.body).toBe(200);
        const own = recordListResponseSchema.parse(mine.json());
        expect(totalOf(own)).toBe(totalOf((await orderQuery('u_sales1')).json()));
        expect(totalOf(own)).toBeGreaterThan(0);
        for (const record of own.records) {
          expect(record.fields).not.toHaveProperty('cost');
          expect(record.fields['owner']).toEqual([expect.objectContaining({ id: ids.u_sales1 })]);
        }
        // `current_user` is the caller: the editor gets its own orders through the same view.
        const editors = recordListResponseSchema.parse(
          (await orderQuery('u_editor', { view_id: mineId })).json(),
        );
        expect(editors.records.length).toBeGreaterThan(0);
        for (const record of editors.records) {
          expect(record.fields['owner']).toEqual([expect.objectContaining({ id: ids.u_editor })]);
        }
      });

      it('P17: u_sales1 cannot change shared views; hidden ones are 404; personal views are allowed', async () => {
        const mine = await viewId('Orders', DEMO_VIEW_NAMES.orders.mine);
        const all = await viewId('Orders', DEMO_VIEW_NAMES.orders.all);
        expectProblem(
          await call('u_sales1', 'POST', `/tables/${tables.Orders}/views`, {
            name: 'Shared',
            type: 'grid',
          }),
          403,
          'PERMISSION_DENIED',
        );
        for (const body of [{ name: 'x' }, { position: 0 }, { config: { row_height: 'tall' } }]) {
          expectProblem(
            await call('u_sales1', 'PATCH', `/views/${mine}`, body),
            403,
            'PERMISSION_DENIED',
          );
          expectProblem(await call('u_sales1', 'PATCH', `/views/${all}`, body), 404, 'NOT_FOUND');
        }
        expectProblem(await call('u_sales1', 'DELETE', `/views/${mine}`), 403, 'PERMISSION_DENIED');
        expectProblem(await call('u_sales1', 'DELETE', `/views/${all}`), 404, 'NOT_FOUND');
        const personal = await call('u_sales1', 'POST', `/tables/${tables.Orders}/views`, {
          name: 'Của riêng Lan',
          type: 'grid',
          is_personal: true,
        });
        expect(personal.statusCode, personal.body).toBe(201);
        const personalId = viewSchema.parse(personal.json()).id;
        expect((await call('u_sales1', 'DELETE', `/views/${personalId}`)).statusCode).toBe(204);
      });

      it('P18: u_sales1 cannot export (download = false); the editor can', async () => {
        const url = `/tables/${tables.Orders}/export?format=csv`;
        expectProblem(await call('u_sales1', 'GET', url), 403, 'PERMISSION_DENIED');
        expectProblem(
          await call('u_sales1', 'GET', `/tables/${tables.Customers}/export?format=csv`),
          404,
          'NOT_FOUND',
        );
        const csv = await call('u_editor', 'GET', url);
        expect(csv.statusCode).toBe(200);
        expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
      });

      it('P25: a direct reader role beats the group role of u_sales1', async () => {
        const readerRole = roleListSchema
          .parse((await call('u_admin', 'GET', `/bases/${baseId}/roles`)).json())
          .items.find((role) => role.kind === 'system_reader');
        const assign = await call('u_admin', 'PUT', `/bases/${baseId}/role-assignments`, {
          principal_type: 'user',
          principal_id: ids.u_sales1,
          role_id: readerRole?.id,
        });
        expect(assign.statusCode, assign.body).toBe(200);
        try {
          const every = await orderQuery('u_sales1');
          expect(totalOf(every.json())).toBe(TABLE_COUNTS.orders);
          const record = recordListResponseSchema.parse(every.json()).records[0];
          expect(record?.fields).toHaveProperty('cost');
          expectProblem(
            await call(
              'u_sales1',
              'PATCH',
              `/tables/${tables.Orders}/records/${record?.id ?? ''}`,
              { fields: { amount: 1 } },
            ),
            403,
            'PERMISSION_DENIED',
          );
        } finally {
          const removed = await call('u_admin', 'DELETE', `/bases/${baseId}/role-assignments`, {
            principal_type: 'user',
            principal_id: ids.u_sales1,
          });
          expect(removed.statusCode).toBe(204);
        }
        expect(totalOf((await orderQuery('u_sales1')).json())).toBeLessThan(TABLE_COUNTS.orders);
      });

      it('P30: Sales cannot share; a share_link variant shares "Đơn của tôi" within its rights', async () => {
        const mine = await viewId('Orders', DEMO_VIEW_NAMES.orders.mine);
        expectProblem(
          await call('u_sales1', 'POST', `/views/${mine}/share-links`, { audience: 'public' }),
          403,
          'PERMISSION_DENIED',
        );
        // BACKLOG decision S3 #1: a variant of Sales with share_link = true, given
        // directly to u_sales1; the seeded Sales role stays as it is.
        const sales = roleListSchema
          .parse((await call('u_admin', 'GET', `/bases/${baseId}/roles`)).json())
          .items.find((role) => role.name === 'Sales');
        if (sales === undefined) throw new Error('no Sales role');
        const variant = await call('u_admin', 'POST', `/bases/${baseId}/roles`, {
          name: 'Sales (share)',
          config: {
            ...sales.config,
            base_rule: { copy: false, download: false, share_link: true },
          },
        });
        expect(variant.statusCode, variant.body).toBe(201);
        const variantId = roleSchema.parse(variant.json()).id;
        const assigned = await call('u_admin', 'PUT', `/bases/${baseId}/role-assignments`, {
          principal_type: 'user',
          principal_id: ids.u_sales1,
          role_id: variantId,
        });
        expect(assigned.statusCode).toBe(200);

        const created = await call('u_sales1', 'POST', `/views/${mine}/share-links`, {
          audience: 'public',
        });
        expect(created.statusCode, created.body).toBe(201);
        const { token } = createdShareLinkSchema.parse(created.json());
        const anonymous = new Browser(t.app);
        const read = () =>
          anonymous.request({
            method: 'POST',
            url: `/api/v1/shares/${token}/records/query`,
            payload: { limit: 100 },
          });
        const page = recordListResponseSchema.parse((await read()).json());
        expect(totalOf(page)).toBe(totalOf((await orderQuery('u_sales1')).json()));
        for (const record of page.records) {
          expect(record.fields).not.toHaveProperty('cost');
          expect(record.fields['owner']).toEqual([expect.objectContaining({ id: ids.u_sales1 })]);
        }

        // Back to the group's Sales role, which cannot share: the link is gone.
        const removed = await call('u_admin', 'DELETE', `/bases/${baseId}/role-assignments`, {
          principal_type: 'user',
          principal_id: ids.u_sales1,
        });
        expect(removed.statusCode).toBe(204);
        expectProblem(await read(), 410, 'SHARE_LINK_GONE');
        const deleted = await call('u_admin', 'DELETE', `/bases/${baseId}/roles/${variantId}`);
        expect(deleted.statusCode).toBe(204);
      });

      it('P37–P38 on the seeded "Duyệt nhanh" button of Orders (T519)', async () => {
        const fields = fieldListSchema.parse(
          (await call('u_admin', 'GET', `/tables/${tables.Orders}/fields`)).json(),
        ).items;
        const button = fields.find((field) => field.name === DEMO_BUTTON_FIELD.name);
        if (button === undefined) throw new Error('no button field');
        const orders = recordListResponseSchema.parse((await orderQuery('u_admin')).json()).records;
        const ownerOf = (record: (typeof orders)[number]) =>
          (record.fields['owner'] as { id: string }[] | null)?.[0]?.id;
        const isNew = (record: (typeof orders)[number]) => record.fields['status'] === 'Mới';
        const newOf = (owner: DemoUserKey) =>
          orders.find((record) => isNew(record) && ownerOf(record) === ids[owner])?.id;
        const ofSales2 = orders.find((record) => ownerOf(record) === ids.u_sales2)?.id;
        const sales1New = newOf('u_sales1');
        const editorNew = newOf('u_editor');
        if (ofSales2 === undefined || sales1New === undefined || editorNew === undefined) {
          throw new Error('the seeded orders lack a case');
        }
        const click = (key: DemoUserKey, recordId: string) =>
          call(
            key,
            'POST',
            `/tables/${tables.Orders}/records/${recordId}/buttons/${button.id}/click`,
          );
        // P37: the automation needs `edit` on the record; u_reader only reads.
        expectProblem(await click('u_reader', editorNew), 403, 'PERMISSION_DENIED');
        // P38: an order u_sales1 cannot read does not exist for them.
        expectProblem(await click('u_sales1', ofSales2), 404, 'NOT_FOUND');
        // u_sales1 edits their own order (the status field itself is read-only for Sales).
        const own = await click('u_sales1', sales1New);
        expect(own.statusCode, own.body).toBe(202);
        expect(buttonClickResponseSchema.parse(own.json()).run_id).toMatch(/^run_/u);
        const editor = await click('u_editor', editorNew);
        expect(editor.statusCode, editor.body).toBe(202);
      });

      it('P31 on the seeded base: only u_admin manages the S5 automations (T519)', async () => {
        const listed = await call('u_admin', 'GET', `/bases/${baseId}/automations`);
        expect(listed.statusCode, listed.body).toBe(200);
        const items = listed.json<{ items: { id: string; name: string }[] }>().items;
        expect(items.map((item) => item.name).sort()).toEqual(
          [
            ...Object.values(DEMO_AUTOMATION_NAMES),
            ...Object.values(DEMO_WEBHOOK_AUTOMATION_NAMES),
          ].sort(),
        );
        const idOf = (name: string) => items.find((item) => item.name === name)?.id ?? '';
        // Triggered on Orders, which all three read; the Tickets ones are 404 for Sales.
        const approve = idOf(DEMO_AUTOMATION_NAMES.approve);
        const urgent = idOf(DEMO_AUTOMATION_NAMES.urgent);
        for (const key of ['u_editor', 'u_reader', 'u_sales1'] as const) {
          expectProblem(
            await call(key, 'GET', `/bases/${baseId}/automations`),
            403,
            'PERMISSION_DENIED',
          );
          for (const [method, url, body] of [
            ['PATCH', `/automations/${approve}`, { name: 'x' }],
            ['POST', `/automations/${approve}/disable`, undefined],
          ] as const) {
            expectProblem(await call(key, method, url, body), 403, 'PERMISSION_DENIED');
          }
        }
        expectProblem(await call('u_sales1', 'GET', `/automations/${urgent}`), 404, 'NOT_FOUND');
        expectProblem(await call('u_out', 'GET', `/automations/${approve}`), 404, 'NOT_FOUND');
      });

      it('prints the sample share links once; they work', async () => {
        // The dashboard link (T818) has its own line: see the S7 test.
        const lines = first.out.filter(
          (line) => line.includes('/s/') && !line.includes('Public link'),
        );
        expect(lines).toHaveLength(2);
        const lineOf = (name: string) => lines.find((item) => item.includes(name)) ?? '';
        const tokenOf = (name: string) =>
          new RegExp(`${TEST_PUBLIC_URL}/s/([A-Za-z0-9_-]{43})$`).exec(lineOf(name))?.[1] ?? '';
        const form = tokenOf(DEMO_VIEW_NAMES.tickets.form);
        const open = tokenOf(DEMO_VIEW_NAMES.tickets.open);
        expect(lineOf(DEMO_VIEW_NAMES.tickets.form)).toContain('public');
        expect(lineOf(DEMO_VIEW_NAMES.tickets.open)).toContain('org');

        const anonymous = new Browser(t.app);
        const meta = (token: string, browser: Browser) =>
          browser.request({ method: 'GET', url: `/api/v1/shares/${token}/meta` });
        const formMeta = await meta(form, anonymous);
        expect(formMeta.statusCode, formMeta.body).toBe(200);
        expect(shareMetaSchema.parse(formMeta.json())).toMatchObject({
          target_type: 'form',
          view: { name: DEMO_VIEW_NAMES.tickets.form, type: 'form' },
        });
        // The organization link: sign-in required, any member of the organization.
        expectProblem(await meta(open, anonymous), 401, 'UNAUTHENTICATED');
        const openMeta = await meta(open, await as('u_out'));
        expect(openMeta.statusCode, openMeta.body).toBe(200);
        expect(shareMetaSchema.parse(openMeta.json())).toMatchObject({
          target_type: 'view',
          view: { name: DEMO_VIEW_NAMES.tickets.open },
        });

        // Tokens are never stored (only their hash and a prefix).
        const stored = JSON.stringify(
          await db.kysely
            .selectFrom('meta.share_links')
            .select(['token_prefix', 'token_hash', 'settings'])
            .execute(),
        );
        expect(stored).not.toContain(form);
        expect(stored).not.toContain(open);
      });

      it('creates the S7 samples: order dates and regions, the dashboard, its public link, a color rule (T818)', async () => {
        // Every order has a date of the last 180 days and a region.
        const fields = fieldListSchema.parse(
          (await call('u_admin', 'GET', `/tables/${tables.Orders}/fields`)).json(),
        ).items;
        const orderDate = fields.find((field) => field.name === DEMO_S7_FIELDS.orderDate);
        const region = fields.find((field) => field.name === DEMO_S7_FIELDS.region);
        expect(orderDate?.type).toBe('datetime');
        expect(region?.type).toBe('select');
        const empty = await orderQuery('u_admin', {
          filter: {
            op: 'or',
            items: [
              { field: orderDate?.id, operator: 'is_empty' },
              { field: region?.id, operator: 'is_empty' },
            ],
          },
        });
        expect(empty.statusCode, empty.body).toBe(200);
        expect(totalOf(empty.json())).toBe(0);

        // The dashboard: 8 widgets, every data widget follows the status control.
        const list = await call('u_admin', 'GET', `/bases/${baseId}/dashboards`);
        expect(list.statusCode, list.body).toBe(200);
        const summary = dashboardListSchema
          .parse(list.json())
          .items.find((item) => item.name === DEMO_DASHBOARD.name);
        expect(summary?.widget_count).toBe(8);
        const dashboard = dashboardSchema.parse(
          (await call('u_admin', 'GET', `/dashboards/${summary?.id ?? ''}`)).json(),
        );
        const byTitle = (title: string) => {
          const widget = dashboard.widgets.find((item) => item.title === title);
          if (widget === undefined) throw new Error(`no widget ${title}`);
          return widget;
        };
        const titles = DEMO_DASHBOARD.widgets;
        expect(dashboard.widgets.map((widget) => widget.type).sort()).toEqual(
          ['bar', 'filter_control', 'filter_control', 'kpi', 'line', 'pie', 'table', 'text'].sort(),
        );
        expect(dashboard.widgets.every((widget) => widget.status === 'ok')).toBe(true);
        const statusControl = byTitle(titles.statusControl).id;
        for (const title of [
          titles.kpi,
          titles.stacked,
          titles.weekly,
          titles.byOwner,
          titles.top,
        ]) {
          expect(
            (byTitle(title).config as { filter_bindings: string[] }).filter_bindings,
          ).toContain(statusControl);
        }

        // P21 on the seed: Sales reads D (read_only); u_sales1 counts only its orders.
        const data = async (key: DemoUserKey, title: string, body: object = {}) => {
          const response = await call(key, 'POST', `/widgets/${byTitle(title).id}/data`, body);
          expect(response.statusCode, response.body).toBe(200);
          return widgetDataSchema.parse(response.json());
        };
        const sum = (rows: unknown[][]) => rows.reduce((acc, row) => acc + Number(row.at(-1)), 0);
        const mine = totalOf((await orderQuery('u_sales1', { limit: 1 })).json());
        expect(mine).toBeGreaterThan(0);
        expect(mine).toBeLessThan(TABLE_COUNTS.orders);
        const salesStacked = await data('u_sales1', titles.stacked);
        expect(salesStacked.status).toBe('ok');
        expect(sum(salesStacked.rows)).toBe(mine);
        expect(sum((await data('u_admin', titles.stacked)).rows)).toBe(TABLE_COUNTS.orders);
        expect(sum((await data('u_admin', titles.weekly)).rows)).toBe(TABLE_COUNTS.orders);
        const kpi = await data('u_admin', titles.kpi);
        expect(kpi.status).toBe('ok');
        expect(kpi.compare?.current_period.from).toMatch(/^\d{4}-\d{2}-01$/u);
        expect((await data('u_sales1', titles.top)).rows.length).toBeLessThanOrEqual(
          Math.min(10, mine),
        );
        expectProblem(await call('u_out', 'GET', `/dashboards/${dashboard.id}`), 404, 'NOT_FOUND');

        // The public link (printed once, embedding off) shows the numbers of its creator (u_admin).
        const line = first.out.find((item) => item.includes('Public link')) ?? '';
        const token = new RegExp(`${TEST_PUBLIC_URL}/s/([A-Za-z0-9_-]{43})$`).exec(line)?.[1] ?? '';
        expect(token).not.toBe('');
        const anonymous = new Browser(t.app);
        const shared = await anonymous.request({
          method: 'GET',
          url: `/api/v1/shares/${token}/dashboard`,
        });
        expect(shared.statusCode, shared.body).toBe(200);
        const sharedData = await anonymous.request({
          method: 'POST',
          url: `/api/v1/shares/${token}/widgets/${byTitle(titles.stacked).id}/data`,
          payload: {},
        });
        expect(sharedData.statusCode, sharedData.body).toBe(200);
        expect(sum(widgetDataSchema.parse(sharedData.json()).rows)).toBe(TABLE_COUNTS.orders);
        const link = await db.kysely
          .selectFrom('meta.share_links')
          .select(['audience', 'settings'])
          .where('target_type', '=', 'dashboard')
          .executeTakeFirstOrThrow();
        expect(link).toMatchObject({ audience: 'public', settings: { embed: { enabled: false } } });

        // "Quá hạn" rows are red on "Tất cả phiếu", for every reader of the view.
        const view = viewSchema.parse(
          (
            await call('u_admin', 'GET', `/views/${await viewId('Tickets', DEMO_COLOR_RULE.view)}`)
          ).json(),
        );
        const rules = (view.config as { color_rules?: { id: string; color: string }[] })
          .color_rules;
        expect(rules).toEqual([expect.objectContaining({ color: DEMO_COLOR_RULE.color })]);
        const tickets = await call(
          'u_editor',
          'POST',
          `/tables/${tables.Tickets}/records/query?field_key_type=name`,
          { view_id: view.id, limit: 100 },
        );
        expect(tickets.statusCode, tickets.body).toBe(200);
        const records = recordListResponseSchema.parse(tickets.json()).records;
        const red = records.filter((record) => record.meta?.color?.row === rules?.[0]?.id);
        expect(red.length).toBeGreaterThan(0);
        for (const record of records) {
          expect(record.meta?.color?.row !== undefined).toBe(
            record.fields[DEMO_COLOR_RULE.field] === true,
          );
        }
      });

      it('computed fields by reader: P34-like lock, P36 strict setting (T464)', async () => {
        const names = DEMO_COMPUTED_FIELDS.orders;
        const fieldsOf = async (key: DemoUserKey) => {
          const response = await call(key, 'GET', `/tables/${tables.Orders}/fields?limit=100`);
          expect(response.statusCode, response.body).toBe(200);
          return new Map(
            fieldListSchema.parse(response.json()).items.map((field) => [field.name, field]),
          );
        };
        const recordsOf = async (key: DemoUserKey) => {
          const response = await orderQuery(key);
          expect(response.statusCode, response.body).toBe(200);
          return recordListResponseSchema.parse(response.json()).records;
        };

        // The editor reads everything: values as stored.
        for (const record of await recordsOf('u_editor')) {
          expect(record.fields[names.margin]).toBe(
            Number(record.fields['amount']) - Number(record.fields['cost']),
          );
          expect(record.fields[names.linesTotal]).toEqual(expect.any(Number));
        }
        // u_sales1: the margin reads `cost` (no_perm) on the same record → shown;
        // the lines total reads a table Sales cannot read → null + locked (P34).
        const sales = await fieldsOf('u_sales1');
        expect(sales.get(names.margin)).toMatchObject({ locked: false });
        expect(sales.get(names.linesTotal)).toMatchObject({ locked: true });
        expect(sales.get(names.linesTotal)?.options).not.toHaveProperty('from');
        const own = await recordsOf('u_sales1');
        expect(own.length).toBeGreaterThan(0);
        for (const record of own) {
          expect(record.fields[names.margin]).toEqual(expect.any(Number));
          expect(record.fields[names.linesTotal]).toBeNull();
        }
        expectProblem(
          await orderQuery('u_sales1', {
            filter: { field: sales.get(names.linesTotal)?.id, operator: 'is_not_empty' },
          }),
          422,
          'INVALID_FILTER',
        );

        // P36: strict_computed_permissions hides the margin from Sales only.
        const strict = async (on: boolean) => {
          const response = await call('u_admin', 'PATCH', `/bases/${baseId}`, {
            settings: { strict_computed_permissions: on },
          });
          expect(response.statusCode, response.body).toBe(200);
        };
        await strict(true);
        try {
          expect((await fieldsOf('u_sales1')).get(names.margin)).toMatchObject({ locked: true });
          for (const record of await recordsOf('u_sales1')) {
            expect(record.fields[names.margin]).toBeNull();
          }
          for (const record of await recordsOf('u_editor')) {
            expect(record.fields[names.margin]).toEqual(expect.any(Number));
          }
        } finally {
          await strict(false);
        }
        expect((await recordsOf('u_sales1'))[0]?.fields[names.margin]).toEqual(expect.any(Number));
      });
    });

    // T800: one organization per E2E worker, next to the default one.
    it('seeds another demo organization with tagged emails; again changes nothing (T800)', async () => {
      const tagged = demoUsersOf({ orgName: 'e2e-w1', emailTag: 'w1' });
      const run = await seed(database.url, ['--org', 'e2e-w1', '--email-tag', 'w1']);
      expect(run.err.join('\n')).not.toMatch(/fail/i);
      expect(run.code).toBe(0);
      const summary = run.out.join('\n');
      expect(summary).toContain('Organization: e2e-w1');
      for (const user of tagged) {
        expect(user.email).toMatch(/^[a-z0-9]+\+w1@demo\.cellhive\.local$/u);
        expect(run.out.find((line) => line.includes(user.email))).toContain(DEMO_PASSWORD);
      }

      const org = await db.kysely
        .selectFrom('meta.organizations')
        .select(['id', 'slug'])
        .where('name', '=', 'e2e-w1')
        .executeTakeFirstOrThrow();
      expect(org.slug).toBe('e2e-w1');
      const members = await db.kysely
        .selectFrom('meta.org_members as m')
        .innerJoin('meta.users as u', 'u.id', 'm.user_id')
        .select(['u.email', 'm.role'])
        .where('m.organization_id', '=', org.id)
        .execute();
      expect(members.map((row) => row.email).sort()).toEqual(
        tagged.map((user) => user.email).sort(),
      );
      const bases = await db.kysely
        .selectFrom('meta.bases')
        .select('name')
        .where('organization_id', '=', org.id)
        .execute();
      expect(bases.map((base) => base.name)).toEqual([DEMO_BASE.name]);
      // The default organization keeps its own users.
      const defaultMembers = await db.kysely
        .selectFrom('meta.org_members as m')
        .innerJoin('meta.organizations as o', 'o.id', 'm.organization_id')
        .select('m.user_id')
        .where('o.name', '=', DEMO_ORG.name)
        .execute();
      expect(defaultMembers).toHaveLength(DEMO_USERS.length);

      const users = async () =>
        (await db.kysely.selectFrom('meta.users').select('id').execute()).length;
      const before = await users();
      const again = await seed(database.url, ['--org', 'e2e-w1', '--email-tag', 'w1']);
      expect(again.code).toBe(0);
      expect(again.err.join('\n')).toContain('already exists');
      expect(await users()).toBe(before);
    });

    it('refuses --org without --email-tag and a tag that is not an email tag (T800)', async () => {
      const alone = await seed(database.url, ['--org', 'e2e-w2']);
      expect(alone.code).toBe(1);
      expect(alone.err.join('\n')).toContain('--org and --email-tag go together');
      const bad = await seed(database.url, ['--org', 'e2e-w2', '--email-tag', 'W 2']);
      expect(bad.code).toBe(1);
      expect(bad.err.join('\n')).toContain('--email-tag must be');
      const orgs = await db.kysely
        .selectFrom('meta.organizations')
        .select('id')
        .where('name', '=', 'e2e-w2')
        .execute();
      expect(orgs).toHaveLength(0);
    });

    it('changes nothing when run again', async () => {
      const countRows = async () => ({
        users: (await db.kysely.selectFrom('meta.users').select('id').execute()).length,
        events: (await db.kysely.selectFrom('meta.events').select('id').execute()).length,
        bases: (await db.kysely.selectFrom('meta.bases').select('id').execute()).length,
      });
      const before = await countRows();
      const again = await seed(database.url);
      expect(again.code).toBe(0);
      expect(again.err.join('\n')).toContain('already exists');
      expect(again.out.join('\n')).toContain(DEMO_USERS[0]?.email);
      // Share link tokens are never stored, so a re-run cannot print them.
      expect(again.out.join('\n')).not.toMatch(/\/s\/[A-Za-z0-9_-]{43}/);
      expect(again.out.join('\n')).toContain('Share links: their URLs were printed');
      // Nor the Bearer token of the sample webhook (stored as a hash only).
      expect(again.out.join('\n')).not.toMatch(/Token {2}/u);
      expect(again.out.join('\n')).toContain(
        'the Bearer token was printed by the run that created it',
      );
      // Nor the API token of u_admin (T719).
      expect(again.out.join('\n')).not.toMatch(/cht_/u);
      expect(again.out.join('\n')).toContain(
        `API token "${DEMO_API_TOKEN.name}": the value was printed`,
      );
      expect(await countRows()).toEqual(before);
    });

    // Last in this block: it breaks the seeded data.
    it('treats data without the final Sales assignment as interrupted', async () => {
      await db.kysely
        .deleteFrom('meta.base_role_members')
        .where('principal_type', '=', 'group')
        .execute();
      const run = await seed(database.url);
      expect(run.code).toBe(1);
      expect(run.err.join('\n')).toMatch(/Some demo data exists.*Sales/);
    });
  });

  it('refuses half-created demo data', async () => {
    const database = await createMigratedDatabase();
    const db = createTestDb(database.url);
    try {
      // A demo email taken by someone outside the demo organization.
      await db.kysely
        .insertInto('meta.users')
        .values({
          id: newId('usr'),
          email: DEMO_USERS[1]?.email ?? '',
          display_name: 'Someone',
          password_hash: null,
        })
        .execute();
      const run = await seed(database.url);
      expect(run.code).toBe(1);
      expect(run.err.join('\n')).toMatch(/Some demo data exists/);
      expect(run.err.join('\n')).toContain('pnpm dev:infra:down');
      const orgs = await db.kysely.selectFrom('meta.organizations').select('id').execute();
      expect(orgs).toHaveLength(0);
    } finally {
      await db.destroy();
      await database.drop();
    }
  });

  describe('in production', () => {
    let database: TestDatabase;
    let db: Db;

    beforeAll(async () => {
      database = await createMigratedDatabase();
      db = createTestDb(database.url);
    });

    afterAll(async () => {
      await db.destroy();
      await database.drop();
    });

    it('refuses without --force and creates nothing', async () => {
      const run = await seed(database.url, [], { NODE_ENV: 'production' });
      expect(run.code).toBe(1);
      expect(run.err.join('\n')).toContain('--force');
      expect(run.out).toEqual([]);
      expect(await db.kysely.selectFrom('meta.users').select('id').execute()).toHaveLength(0);
    });

    it('with --force, never uses the demo password', async () => {
      const run = await seed(database.url, ['--force'], { NODE_ENV: 'production' });
      expect(run.code).toBe(0);
      expect(run.out.join('\n')).not.toContain(DEMO_PASSWORD);
      // The sample webhook exists, but its Bearer token is never printed in production.
      expect(run.out.join('\n')).toContain('Token  not printed in production');
      expect(run.out.join('\n')).not.toMatch(/Token {2}[A-Za-z0-9_-]{43}/u);
      const users = await db.kysely
        .selectFrom('meta.users')
        .select(['email', 'password_hash'])
        .execute();
      expect(users).toHaveLength(DEMO_USERS.length);
      const hasher = new PasswordHasher();
      for (const user of users) {
        expect(await hasher.verify(user.password_hash ?? '', DEMO_PASSWORD)).toBe(false);
        // The printed random password is the real one.
        const row = run.out.find((line) => line.includes(user.email)) ?? '';
        // base64url may end in `-` or `_`: delimit by spaces, not word boundaries.
        const password = /(?:^|\s)(Ob-[A-Za-z0-9_-]{24})(?:\s|$)/.exec(row)?.[1] ?? '';
        expect(await hasher.verify(user.password_hash ?? '', password)).toBe(true);
      }
    });
  });

  it('points to the migrations when the database is not migrated', async () => {
    const database = await createMigratedDatabase();
    const db = createTestDb(database.url);
    try {
      await db.kysely.schema.dropSchema('meta').cascade().execute();
      const run = await seed(database.url);
      expect(run.code).toBe(1);
      expect(run.err.join('\n')).toContain('pnpm db:migrate');
    } finally {
      await db.destroy();
      await database.drop();
    }
  });
});
