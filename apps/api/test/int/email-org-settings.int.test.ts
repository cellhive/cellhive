import { emailIdentityMutationSchema, emailSettingsSchema, type Id } from '@cellhive/contracts';
import { orgEmailSettingsOf, type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser, seedOrg, seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/**
 * Automation email settings of the organization (BACKLOG T531, CONTRACTS
 * §23.4): footer policy, default signature, system sender — `GET|PATCH
 * /orgs/:orgId/email-settings`, plus the signature rules of sender
 * identities.
 */
describe('automation email settings (T531)', () => {
  let database: TestDatabase;
  let db: Db;
  let app: TestApp;
  let orgPolicyApp: TestApp;
  /** Instance caps raised to the ceilings (T532). */
  let capsApp: TestApp;
  let org: Id<'org'>;
  let otherOrg: Id<'org'>;
  let owner: SeededUser;
  let admin: SeededUser;
  let member: SeededUser;
  let stranger: SeededUser;
  const browsers = new Map<string, Browser>();

  async function as(user: SeededUser, target: TestApp = app): Promise<Browser> {
    const key = `${user.id}:${target === app ? 'a' : target === capsApp ? 'c' : 'b'}`;
    const known = browsers.get(key);
    if (known !== undefined) return known;
    const browser = new Browser(target.app);
    expect((await browser.login(user.email)).statusCode).toBe(204);
    browsers.set(key, browser);
    return browser;
  }

  async function call(
    user: SeededUser,
    method: 'GET' | 'PATCH' | 'POST',
    url: string,
    payload?: object,
    target: TestApp = app,
  ): Promise<LightMyRequestResponse> {
    const browser = await as(user, target);
    return browser.request({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function storedSettings(id: Id<'org'>) {
    const row = await db.kysely
      .selectFrom('meta.organizations')
      .select('settings')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return row.settings as Record<string, unknown>;
  }

  async function auditRows(id: Id<'org'>) {
    const { rows } = await sql<{ before: unknown; after: unknown }>`
      SELECT before, after FROM meta.audit_logs
       WHERE organization_id = ${id} AND action = 'org.updated'
       ORDER BY created_at, id
    `.execute(db.kysely);
    return rows;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    app = await startTestApp({ DATABASE_URL: database.url });
    orgPolicyApp = await startTestApp({
      DATABASE_URL: database.url,
      EMAIL_AUTOMATION_FOOTER: 'org',
    });
    capsApp = await startTestApp({
      DATABASE_URL: database.url,
      EMAIL_MAX_ATTACHMENTS: '20',
      EMAIL_MAX_ATTACHMENT_BYTES: String(30 * 1024 * 1024),
    });
    org = await seedOrg(db, 'Mail Settings');
    otherOrg = await seedOrg(db, 'Other Mail');
    owner = await seedUser(db, { memberships: [{ orgId: org, role: 'owner' }] });
    admin = await seedUser(db, { memberships: [{ orgId: org, role: 'admin' }] });
    member = await seedUser(db, { memberships: [{ orgId: org, role: 'member' }] });
    stranger = await seedUser(db, { memberships: [{ orgId: otherOrg, role: 'owner' }] });
  });

  afterAll(async () => {
    await app.close();
    await orgPolicyApp.close();
    await capsApp.close();
    await db.destroy();
    await database.drop();
  });

  it('returns the defaults: footer required, no signature, system sender on', async () => {
    const response = await call(owner, 'GET', `/orgs/${org}/email-settings`);
    expect(response.statusCode).toBe(200);
    expect(emailSettingsSchema.parse(response.json()).automation).toEqual({
      instance_footer_policy: 'required',
      footer_policy: 'required',
      footer_none_allowed: false,
      default_signature_md: null,
      system_sender_enabled: true,
      max_attachments: 10,
      max_attachment_bytes: 15 * 1024 * 1024,
      attachment_limits_custom: false,
      system_sender_usage: { automations: 0, enabled_automations: 0 },
    });
  });

  it('is for organization owners/admins: members 403, other organizations 404', async () => {
    const before = await storedSettings(org);
    for (const [user, status] of [
      [member, 403],
      [stranger, 404],
    ] as const) {
      expect((await call(user, 'GET', `/orgs/${org}/email-settings`)).statusCode).toBe(status);
      const patch = await call(user, 'PATCH', `/orgs/${org}/email-settings`, {
        system_sender_enabled: false,
      });
      expect(patch.statusCode).toBe(status);
    }
    expect(await storedSettings(org)).toEqual(before);
    expect(await auditRows(org)).toHaveLength(0);
  });

  it('changes the settings, keeps the other settings, audits org.updated', async () => {
    const response = await call(admin, 'PATCH', `/orgs/${org}/email-settings`, {
      footer_policy: 'author_choice',
      default_signature_md: '**Acme HR** · [acme.example](https://acme.example)',
      system_sender_enabled: false,
    });
    expect(response.statusCode).toBe(200);
    const body = emailSettingsSchema.parse(response.json());
    expect(body.automation).toMatchObject({
      instance_footer_policy: 'required',
      footer_policy: 'author_choice',
      // The instance still requires a footer.
      footer_none_allowed: false,
      default_signature_md: '**Acme HR** · [acme.example](https://acme.example)',
      system_sender_enabled: false,
    });
    const settings = await storedSettings(org);
    expect(settings).toMatchObject({ locale: 'vi', timezone: 'Asia/Ho_Chi_Minh' });
    expect(orgEmailSettingsOf(settings as never)).toEqual({
      footerPolicy: 'author_choice',
      defaultSignatureMd: '**Acme HR** · [acme.example](https://acme.example)',
      systemSenderEnabled: false,
      maxAttachments: null,
      maxAttachmentBytes: null,
    });
    // `GET /orgs/:id` is unchanged by the email settings.
    const organization = await call(owner, 'GET', `/orgs/${org}`);
    expect(organization.json()).toMatchObject({ settings: { locale: 'vi' } });

    const rows = await auditRows(org);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      before: {
        settings: {
          email: {
            footer_policy: 'required',
            default_signature_md: null,
            system_sender_enabled: true,
            max_attachments: null,
            max_attachment_bytes: null,
          },
        },
      },
      after: {
        settings: {
          email: {
            footer_policy: 'author_choice',
            default_signature_md: '**Acme HR** · [acme.example](https://acme.example)',
            system_sender_enabled: false,
            max_attachments: null,
            max_attachment_bytes: null,
          },
        },
      },
    });
    const { rows: events } = await sql<{ payload: { changes?: Record<string, unknown> } }>`
      SELECT payload FROM meta.events WHERE organization_id = ${org} AND type = 'org.updated'
    `.execute(db.kysely);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]?.payload.changes ?? {}).sort()).toEqual([
      'settings.email.default_signature_md',
      'settings.email.footer_policy',
      'settings.email.system_sender_enabled',
    ]);

    // Same values again: nothing to record.
    const again = await call(owner, 'PATCH', `/orgs/${org}/email-settings`, {
      system_sender_enabled: false,
    });
    expect(again.statusCode).toBe(200);
    expect(await auditRows(org)).toHaveLength(1);

    // A blank or null signature removes it; a partial change keeps the rest.
    const cleared = await call(owner, 'PATCH', `/orgs/${org}/email-settings`, {
      default_signature_md: '   ',
    });
    expect(emailSettingsSchema.parse(cleared.json()).automation).toMatchObject({
      footer_policy: 'author_choice',
      default_signature_md: null,
      system_sender_enabled: false,
    });
  });

  it('lets automations drop the footer only when EMAIL_AUTOMATION_FOOTER=org', async () => {
    const response = await call(
      owner,
      'GET',
      `/orgs/${org}/email-settings`,
      undefined,
      orgPolicyApp,
    );
    expect(emailSettingsSchema.parse(response.json()).automation).toMatchObject({
      instance_footer_policy: 'org',
      footer_policy: 'author_choice',
      footer_none_allowed: true,
    });
    const required = await call(
      owner,
      'PATCH',
      `/orgs/${org}/email-settings`,
      { footer_policy: 'required' },
      orgPolicyApp,
    );
    expect(emailSettingsSchema.parse(required.json()).automation.footer_none_allowed).toBe(false);
  });

  it('refuses signatures with placeholders or above 2,000 characters, and bad bodies', async () => {
    const cases: [object, string, string][] = [
      [
        { default_signature_md: 'Regards, {{ [Name] }}' },
        'default_signature_md',
        'PLACEHOLDER_NOT_ALLOWED',
      ],
      [{ default_signature_md: 'x'.repeat(2001) }, 'default_signature_md', 'TOO_BIG'],
      [{}, '', ''],
      [{ footer_policy: 'none' }, 'footer_policy', ''],
      [{ smtp_url: 'smtp://x' }, '', ''],
    ];
    const before = await storedSettings(org);
    for (const [payload, path, code] of cases) {
      const response = await call(owner, 'PATCH', `/orgs/${org}/email-settings`, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(422);
      const problem = problemOf(response.body);
      expect(problem['code']).toBe('VALIDATION_FAILED');
      if (code !== '') {
        expect(problem['errors']).toEqual([expect.objectContaining({ path, code }) as unknown]);
      }
    }
    expect(await storedSettings(org)).toEqual(before);
  });

  it('counts the automations that send with the system sender', async () => {
    const workspaceId: Id<'wsp'> = 'wsp_EmailSettings001';
    const baseId: Id<'bse'> = 'bse_EmailSettings001';
    await db.kysely
      .insertInto('meta.workspaces')
      .values({ id: workspaceId, organization_id: org, name: 'Main', slug: 'main-email' })
      .execute();
    await db.kysely
      .insertInto('meta.bases')
      .values({
        id: baseId,
        organization_id: org,
        workspace_id: workspaceId,
        owner_id: owner.id,
        name: 'B',
      })
      .execute();
    const insert = (id: Id<'aut'>, enabled: boolean, identityId: string | null) =>
      db.kysely
        .insertInto('meta.automations')
        .values({
          id,
          organization_id: org,
          base_id: baseId,
          name: id,
          enabled,
          definition: {
            trigger: { type: 'record.created' },
            actions: [{ id: 'act_1', type: 'send_email', config: { identity_id: identityId } }],
          },
          trigger_type: 'record.created',
          trigger_table_id: null,
          created_by: owner.id,
          updated_by: owner.id,
          run_as_user_id: owner.id,
        })
        .execute();
    await insert('aut_EmailSettings001', true, null);
    await insert('aut_EmailSettings002', false, null);
    await insert('aut_EmailSettings003', true, 'eid_EmailSettings001');
    const response = await call(admin, 'GET', `/orgs/${org}/email-settings`);
    expect(emailSettingsSchema.parse(response.json()).automation.system_sender_usage).toEqual({
      automations: 2,
      enabled_automations: 1,
    });
    // Another organization sees none of them.
    const other = await call(stranger, 'GET', `/orgs/${otherOrg}/email-settings`);
    expect(emailSettingsSchema.parse(other.json()).automation.system_sender_usage).toEqual({
      automations: 0,
      enabled_automations: 0,
    });
  });

  it('attachment limits (T532): within the instance caps, audited, null = the caps', async () => {
    const MIB = 1024 * 1024;
    const limitsOrg = await seedOrg(db, 'Attachment Limits');
    const boss = await seedUser(db, { memberships: [{ orgId: limitsOrg, role: 'owner' }] });
    const worker = await seedUser(db, { memberships: [{ orgId: limitsOrg, role: 'member' }] });
    const path = `/orgs/${limitsOrg}/email-settings`;
    const automationOf = (response: LightMyRequestResponse) =>
      emailSettingsSchema.parse(response.json()).automation;

    const initial = emailSettingsSchema.parse((await call(boss, 'GET', path)).json());
    expect(initial.limits).toMatchObject({ max_attachments: 10, max_attachment_bytes: 15 * MIB });

    // Members 403, other organizations 404, nothing stored.
    expect((await call(worker, 'PATCH', path, { max_attachments: 2 })).statusCode).toBe(403);
    expect((await call(stranger, 'PATCH', path, { max_attachments: 2 })).statusCode).toBe(404);

    // Above the instance caps: 422 TOO_BIG with the cap.
    const tooMany = await call(boss, 'PATCH', path, {
      max_attachments: 11,
      max_attachment_bytes: 16 * MIB,
    });
    expect(tooMany.statusCode).toBe(422);
    expect(problemOf(tooMany.body)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [
        { path: 'max_attachments', code: 'TOO_BIG', params: { maximum: 10 } },
        { path: 'max_attachment_bytes', code: 'TOO_BIG', params: { maximum: 15 * MIB } },
      ],
    });
    // Below the hard minimum: zod.
    expect((await call(boss, 'PATCH', path, { max_attachment_bytes: 1000 })).statusCode).toBe(422);
    expect(await auditRows(limitsOrg)).toHaveLength(0);

    const lowered = await call(boss, 'PATCH', path, {
      max_attachments: 5,
      max_attachment_bytes: 8 * MIB,
    });
    expect(lowered.statusCode, lowered.body).toBe(200);
    expect(automationOf(lowered)).toMatchObject({
      max_attachments: 5,
      max_attachment_bytes: 8 * MIB,
      attachment_limits_custom: true,
    });
    const [row] = await auditRows(limitsOrg);
    expect(row?.after).toMatchObject({
      settings: { email: { max_attachments: 5, max_attachment_bytes: 8 * MIB } },
    });
    expect(row?.before).toMatchObject({
      settings: { email: { max_attachments: null, max_attachment_bytes: null } },
    });

    // An instance with higher caps lets the organization raise them; an
    // instance with lower caps applies its own (the operator wins).
    const raised = await call(
      boss,
      'PATCH',
      path,
      { max_attachments: 20, max_attachment_bytes: 30 * MIB },
      capsApp,
    );
    expect(raised.statusCode, raised.body).toBe(200);
    expect(automationOf(raised)).toMatchObject({
      max_attachments: 20,
      max_attachment_bytes: 30 * MIB,
    });
    expect(automationOf(await call(boss, 'GET', path))).toMatchObject({
      max_attachments: 10,
      max_attachment_bytes: 15 * MIB,
      attachment_limits_custom: true,
    });

    const reset = await call(boss, 'PATCH', path, {
      max_attachments: null,
      max_attachment_bytes: null,
    });
    expect(automationOf(reset)).toMatchObject({
      max_attachments: 10,
      max_attachment_bytes: 15 * MIB,
      attachment_limits_custom: false,
    });
    expect(orgEmailSettingsOf((await storedSettings(limitsOrg)) as never)).toMatchObject({
      maxAttachments: null,
      maxAttachmentBytes: null,
    });
    expect(await auditRows(limitsOrg)).toHaveLength(3);
  });

  it('applies the same signature rules to sender identities', async () => {
    const created = await call(owner, 'POST', `/orgs/${org}/email-identities`, {
      email: 'hr@acme.example',
      display_name: 'HR',
      transport: 'system',
      signature_md: 'HR {{ [Name] }}',
    });
    expect(created.statusCode).toBe(422);
    expect(problemOf(created.body)['errors']).toEqual([
      expect.objectContaining({ path: 'signature_md', code: 'PLACEHOLDER_NOT_ALLOWED' }) as unknown,
    ]);

    // T534: a remote image is refused when saved (images are uploaded signature assets).
    const remote = await call(owner, 'POST', `/orgs/${org}/email-identities`, {
      email: 'hr@acme.example',
      display_name: 'HR',
      transport: 'system',
      signature_md: 'Phòng Nhân sự ![logo](https://acme.example/logo.png)',
    });
    expect(remote.statusCode).toBe(422);
    expect(problemOf(remote.body)['errors']).toEqual([
      expect.objectContaining({
        path: 'signature_md',
        code: 'IMAGE_SOURCE_NOT_ALLOWED',
      }) as unknown,
    ]);

    const valid = await call(owner, 'POST', `/orgs/${org}/email-identities`, {
      email: 'hr@acme.example',
      display_name: 'HR',
      transport: 'system',
      signature_md: 'Phòng **Nhân sự**',
    });
    expect(valid.statusCode).toBe(201);
    const { identity } = emailIdentityMutationSchema.parse(valid.json());
    expect(identity.signature_md).toBe('Phòng **Nhân sự**');

    const patched = await call(owner, 'PATCH', `/email-identities/${identity.id}`, {
      signature_md: '{{x}}',
    });
    expect(patched.statusCode).toBe(422);
    expect(problemOf(patched.body)['errors']).toEqual([
      expect.objectContaining({ path: 'signature_md', code: 'PLACEHOLDER_NOT_ALLOWED' }) as unknown,
    ]);
  });
});
