import {
  acceptInvitationResponseSchema,
  createdInvitationSchema,
  invitationListSchema,
  invitationPreviewSchema,
  invitationSchema,
  organizationListSchema,
  workspaceSchema,
  type Id,
} from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Browser,
  decodeQuotedPrintable,
  PASSWORD,
  seedOrg,
  seedUser,
  startSmtpCapture,
  uniqueIp,
  waitFor,
  type SeededUser,
  type SmtpCapture,
} from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';
import type { LightMyRequestResponse } from 'fastify';

const INVITE_URL = new RegExp(`^${TEST_PUBLIC_URL}/invite/([A-Za-z0-9_-]{43})$`);
const NEW_PASSWORD = 'Brand-New-Secret-2026';

function tokenOf(url: string): string {
  const match = INVITE_URL.exec(url);
  if (match?.[1] === undefined) throw new Error(`not an invite URL: ${url}`);
  return match[1];
}

/** Invitations (SPEC §14.1A, T008): create, preview, accept, reuse, revoke, expiry. */
describe('invitations (T008)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let smtp: SmtpCapture;
  let org: Id<'org'>;
  let owner: SeededUser;
  let member: SeededUser;
  /** Has an account but is not in `org`. */
  let existing: SeededUser;
  let stranger: SeededUser;
  let workspaceId: Id<'wsp'>;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    smtp = await startSmtpCapture();
    t = await startTestApp({
      DATABASE_URL: database.url,
      SMTP_URL: smtp.url,
      SMTP_ALLOW_INSECURE: 'true',
      SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
    });
    org = await seedOrg(db, 'Invite');
    const otherOrg = await seedOrg(db, 'Elsewhere');
    owner = await seedUser(db, { memberships: [{ orgId: org, role: 'owner' }] });
    member = await seedUser(db, { memberships: [{ orgId: org, role: 'member' }] });
    existing = await seedUser(db, { memberships: [{ orgId: otherOrg, role: 'member' }] });
    stranger = await seedUser(db, { memberships: [{ orgId: otherOrg, role: 'owner' }] });
  });

  afterAll(async () => {
    await t.close();
    await smtp.close();
    await db.destroy();
    await database.drop();
  });

  async function signedIn(user: SeededUser): Promise<Browser> {
    const browser = new Browser(t.app);
    expect((await browser.login(user.email)).statusCode).toBe(204);
    return browser;
  }

  function expectProblem(response: LightMyRequestResponse, status: number, code: string): void {
    expect({ status: response.statusCode, code: problemOf(response.body).code }).toEqual({
      status,
      code,
    });
  }

  async function invite(
    email: string,
    extra: object = {},
  ): Promise<{ id: Id<'inv'>; token: string; response: LightMyRequestResponse }> {
    const browser = await signedIn(owner);
    const response = await browser.request({
      method: 'POST',
      url: `/api/v1/orgs/${org}/invitations`,
      payload: { email, ...extra },
    });
    expect(response.statusCode).toBe(201);
    const body = createdInvitationSchema.parse(response.json());
    return { id: body.id, token: tokenOf(body.invite_url), response };
  }

  function accept(token: string, payload?: object, browser?: Browser) {
    const options = {
      method: 'POST' as const,
      url: `/api/v1/invitations/${token}/accept`,
      ...(payload === undefined ? {} : { payload }),
    };
    return browser === undefined
      ? t.app.inject({ ...options, remoteAddress: uniqueIp() })
      : browser.request(options);
  }

  it('creates an invitation: link returned once, stored hashed, emailed, never logged', async () => {
    const owners = await signedIn(owner);
    workspaceId = workspaceSchema.parse(
      (
        await owners.request({
          method: 'POST',
          url: `/api/v1/orgs/${org}/workspaces`,
          payload: { name: 'Main' },
        })
      ).json(),
    ).id;
    const { id, token, response } = await invite('New.Person@Example.test', {
      role: 'admin',
      workspace_id: workspaceId,
    });
    const body = createdInvitationSchema.parse(response.json());
    expect(body).toMatchObject({
      role: 'admin',
      status: 'pending',
      workspace_id: workspaceId,
      inviter_id: owner.id,
      email_sent: true,
    });
    const days = (Date.parse(body.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);

    const row = await db.kysely
      .selectFrom('meta.invitations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.token_hash).not.toContain(token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const invited = (mail: { to: readonly string[] }) =>
      mail.to.some((to) => to.toLowerCase() === 'new.person@example.test');
    await waitFor(() => smtp.messages.some(invited));
    const mail = smtp.messages.find(invited);
    expect(decodeQuotedPrintable(mail?.raw ?? '')).toContain(token);

    // Never logged, audited or stored in events.
    expect(t.logs.raw()).not.toContain(token);
    const raw = JSON.stringify([
      await db.kysely.selectFrom('meta.audit_logs').selectAll().execute(),
      await db.kysely.selectFrom('meta.events').selectAll().execute(),
    ]);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(row.token_hash);
    // Get/list never show the link.
    const read = await owners.request({
      method: 'GET',
      url: `/api/v1/orgs/${org}/invitations/${id}`,
    });
    expect(invitationSchema.strict().safeParse(read.json()).success).toBe(true);
    expect(read.body).not.toContain(token);
  });

  it('only org owners/admins manage invitations; others get 403, outsiders 404', async () => {
    const members = await signedIn(member);
    expectProblem(
      await members.request({
        method: 'POST',
        url: `/api/v1/orgs/${org}/invitations`,
        payload: { email: 'x@example.test' },
      }),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await members.request({ method: 'GET', url: `/api/v1/orgs/${org}/invitations` }),
      403,
      'PERMISSION_DENIED',
    );
    const strangers = await signedIn(stranger);
    expectProblem(
      await strangers.request({ method: 'GET', url: `/api/v1/orgs/${org}/invitations` }),
      404,
      'NOT_FOUND',
    );
    // Inviting a current member is refused.
    const owners = await signedIn(owner);
    const again = await owners.request({
      method: 'POST',
      url: `/api/v1/orgs/${org}/invitations`,
      payload: { email: member.email.toUpperCase() },
    });
    expectProblem(again, 422, 'VALIDATION_FAILED');
    expect(problemOf(again.body).errors).toEqual([
      expect.objectContaining({ path: 'email', code: 'ALREADY_MEMBER' }),
    ]);
  });

  it('a new user accepts with a display name and password, joins org and workspace; reuse is 410', async () => {
    const email = 'fresh@example.test';
    const { id, token } = await invite(email, { workspace_id: workspaceId });

    const preview = await t.app.inject({ method: 'GET', url: `/api/v1/invitations/${token}` });
    expect(preview.statusCode).toBe(200);
    expect(invitationPreviewSchema.parse(preview.json())).toMatchObject({
      organization: { id: org },
      email,
      role: 'member',
      account_exists: false,
    });

    const missing = await accept(token, {});
    expectProblem(missing, 422, 'VALIDATION_FAILED');
    const weak = await accept(token, { display_name: 'Fresh', password: 'password123' });
    expectProblem(weak, 422, 'VALIDATION_FAILED');

    const accepted = await accept(token, {
      display_name: 'Trần Thị Mới',
      password: NEW_PASSWORD,
      locale: 'vi',
    });
    expect(accepted.statusCode).toBe(200);
    const body = acceptInvitationResponseSchema.parse(accepted.json());
    expect(body).toMatchObject({
      organization: { id: org },
      user: { email, display_name: 'Trần Thị Mới' },
      role: 'member',
      workspace_id: workspaceId,
    });

    // The new user can sign in and is a member of the org and the workspace.
    const browser = new Browser(t.app);
    expect((await browser.login(email, NEW_PASSWORD)).statusCode).toBe(204);
    const me = (await browser.request({ method: 'GET', url: '/api/v1/me' })).json<{
      orgs: { id: string; role: string }[];
    }>();
    expect(me.orgs).toEqual([expect.objectContaining({ id: org, role: 'member' })]);
    const workspace = await browser.request({
      method: 'GET',
      url: `/api/v1/orgs/${org}/workspaces/${workspaceId}`,
    });
    expect(workspaceSchema.parse(workspace.json()).role).toBe('member');

    // Second use of the same link.
    expectProblem(
      await accept(token, { display_name: 'Again', password: NEW_PASSWORD }),
      410,
      'INVITATION_INVALID',
    );
    expectProblem(
      await t.app.inject({ method: 'GET', url: `/api/v1/invitations/${token}` }),
      410,
      'INVITATION_INVALID',
    );

    const events = await db.kysely
      .selectFrom('meta.events')
      .select(['type', 'actor_id'])
      .where('organization_id', '=', org)
      .where('actor_id', '=', body.user.id)
      .orderBy('type')
      .execute();
    expect(events.map((event) => event.type)).toEqual([
      'invitation.accepted',
      'org_member.added',
      'workspace_member.added',
    ]);
    const audits = await db.kysely
      .selectFrom('meta.audit_logs')
      .select(['action', 'entity_id'])
      .where('organization_id', '=', org)
      .where('action', 'in', ['invitation.created', 'invitation.accepted'])
      .where('entity_id', '=', id)
      .orderBy('action')
      .execute();
    expect(audits.map((entry) => entry.action)).toEqual([
      'invitation.accepted',
      'invitation.created',
    ]);
    // The password never reaches the audit log.
    const raw = JSON.stringify(await db.kysely.selectFrom('meta.audit_logs').selectAll().execute());
    expect(raw).not.toContain(NEW_PASSWORD);
    expect(raw).not.toContain('argon2');
  });

  it('an existing user must sign in as the invited email; another user gets 410', async () => {
    const { token } = await invite(existing.email);
    const preview = invitationPreviewSchema.parse(
      (await t.app.inject({ method: 'GET', url: `/api/v1/invitations/${token}` })).json(),
    );
    expect(preview.account_exists).toBe(true);
    // Without a session: sign in first.
    expectProblem(
      await accept(token, { display_name: 'X', password: NEW_PASSWORD }),
      401,
      'UNAUTHENTICATED',
    );
    // Signed in as someone else: indistinguishable from a bad link.
    const other = await signedIn(stranger);
    expectProblem(await accept(token, undefined, other), 410, 'INVITATION_INVALID');
    // CSRF is enforced on the public route for cookie sessions.
    const self = await signedIn(existing);
    const noCsrf = await self.request({
      method: 'POST',
      url: `/api/v1/invitations/${token}/accept`,
      csrf: false,
    });
    expectProblem(noCsrf, 403, 'CSRF_INVALID');
    const accepted = await accept(token, undefined, self);
    expect(accepted.statusCode).toBe(200);
    expect(acceptInvitationResponseSchema.parse(accepted.json())).toMatchObject({
      user: { id: existing.id },
      role: 'member',
      workspace_id: null,
    });
    const orgs = await self.request({ method: 'GET', url: '/api/v1/orgs' });
    expect(organizationListSchema.parse(orgs.json()).total).toBe(2);
    // The same user still signs in with the old password.
    expect((await new Browser(t.app).login(existing.email, PASSWORD)).statusCode).toBe(204);
  });

  it('revoked, expired and unknown links are 410', async () => {
    const owners = await signedIn(owner);
    const revoked = await invite('revoked@example.test');
    const revoke = await owners.request({
      method: 'DELETE',
      url: `/api/v1/orgs/${org}/invitations/${revoked.id}`,
    });
    expect(revoke.statusCode).toBe(204);
    expectProblem(
      await accept(revoked.token, { display_name: 'R', password: NEW_PASSWORD }),
      410,
      'INVITATION_INVALID',
    );
    // Revoking again is a no-op.
    expect(
      (
        await owners.request({
          method: 'DELETE',
          url: `/api/v1/orgs/${org}/invitations/${revoked.id}`,
        })
      ).statusCode,
    ).toBe(204);

    const expired = await invite('expired@example.test');
    await db.kysely
      .updateTable('meta.invitations')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', expired.id)
      .execute();
    expectProblem(
      await accept(expired.token, { display_name: 'E', password: NEW_PASSWORD }),
      410,
      'INVITATION_INVALID',
    );

    expectProblem(
      await accept('A'.repeat(43), { display_name: 'U', password: NEW_PASSWORD }),
      410,
      'INVITATION_INVALID',
    );
    expectProblem(await accept('short', {}), 410, 'INVITATION_INVALID');

    const list = invitationListSchema.parse(
      (
        await owners.request({
          method: 'GET',
          url: `/api/v1/orgs/${org}/invitations?status=revoked`,
        })
      ).json(),
    );
    expect(list.items.map((item) => item.id)).toEqual([revoked.id]);
    const expiredList = invitationListSchema.parse(
      (
        await owners.request({
          method: 'GET',
          url: `/api/v1/orgs/${org}/invitations?status=expired`,
        })
      ).json(),
    );
    expect(expiredList.items.map((item) => item.id)).toEqual([expired.id]);
    const event = await db.kysely
      .selectFrom('meta.events')
      .select('type')
      .where('type', '=', 'invitation.revoked')
      .execute();
    expect(event).toHaveLength(1);
  });

  describe('invitations do not outlive the inviter', () => {
    /** An admin of `org` that invites people, with a signed-in browser. */
    async function inviterAdmin(): Promise<{ user: SeededUser; browser: Browser }> {
      const user = await seedUser(db, { memberships: [{ orgId: org, role: 'admin' }] });
      return { user, browser: await signedIn(user) };
    }

    async function inviteAs(browser: Browser, email: string, role: 'admin' | 'member') {
      const response = await browser.request({
        method: 'POST',
        url: `/api/v1/orgs/${org}/invitations`,
        payload: { email, role },
      });
      expect(response.statusCode).toBe(201);
      const body = createdInvitationSchema.parse(response.json());
      return { id: body.id, token: tokenOf(body.invite_url) };
    }

    async function stateOf(id: Id<'inv'>): Promise<string> {
      const owners = await signedIn(owner);
      const response = await owners.request({
        method: 'GET',
        url: `/api/v1/orgs/${org}/invitations/${id}`,
      });
      return invitationSchema.parse(response.json()).status;
    }

    async function revokedEvents(id: Id<'inv'>) {
      return db.kysely
        .selectFrom('meta.audit_logs')
        .select(['actor_id', 'after'])
        .where('organization_id', '=', org)
        .where('action', '=', 'invitation.revoked')
        .where('entity_id', '=', id)
        .execute();
    }

    it('demoting an admin to member revokes their pending invitations in the same transaction', async () => {
      const inviter = await inviterAdmin();
      const asAdmin = await inviteAs(inviter.browser, 'demoted-admin-invite@example.test', 'admin');
      const asMember = await inviteAs(
        inviter.browser,
        'demoted-member-invite@example.test',
        'member',
      );
      const owners = await signedIn(owner);
      const demote = await owners.request({
        method: 'PATCH',
        url: `/api/v1/orgs/${org}/members/${inviter.user.id}`,
        payload: { role: 'member' },
      });
      expect(demote.statusCode).toBe(200);

      for (const invitation of [asAdmin, asMember]) {
        expect(await stateOf(invitation.id)).toBe('revoked');
        expectProblem(
          await t.app.inject({
            method: 'GET',
            url: `/api/v1/invitations/${invitation.token}`,
            remoteAddress: uniqueIp(),
          }),
          410,
          'INVITATION_INVALID',
        );
        expectProblem(
          await accept(invitation.token, { display_name: 'X', password: NEW_PASSWORD }),
          410,
          'INVITATION_INVALID',
        );
        expect(await revokedEvents(invitation.id)).toEqual([
          { actor_id: owner.id, after: { reason: 'inviter_demoted' } },
        ]);
      }
      // Nobody joined.
      const joined = await db.kysely
        .selectFrom('meta.users')
        .select('id')
        .where('email', 'in', [
          'demoted-admin-invite@example.test',
          'demoted-member-invite@example.test',
        ])
        .execute();
      expect(joined).toEqual([]);
    });

    it('an admin promoted to owner keeps their invitations', async () => {
      const inviter = await inviterAdmin();
      const invitation = await inviteAs(inviter.browser, 'promoted@example.test', 'admin');
      const owners = await signedIn(owner);
      const promote = await owners.request({
        method: 'PATCH',
        url: `/api/v1/orgs/${org}/members/${inviter.user.id}`,
        payload: { role: 'owner' },
      });
      expect(promote.statusCode).toBe(200);
      expect(await stateOf(invitation.id)).toBe('pending');
    });

    it('removing the inviter (or the inviter leaving) revokes their pending invitations', async () => {
      const removed = await inviterAdmin();
      const byRemoved = await inviteAs(removed.browser, 'removed-inviter@example.test', 'admin');
      const owners = await signedIn(owner);
      const remove = await owners.request({
        method: 'DELETE',
        url: `/api/v1/orgs/${org}/members/${removed.user.id}`,
      });
      expect(remove.statusCode).toBe(204);
      expect(await stateOf(byRemoved.id)).toBe('revoked');
      expectProblem(
        await accept(byRemoved.token, { display_name: 'X', password: NEW_PASSWORD }),
        410,
        'INVITATION_INVALID',
      );
      expect(await revokedEvents(byRemoved.id)).toEqual([
        { actor_id: owner.id, after: { reason: 'inviter_removed' } },
      ]);

      const leaving = await inviterAdmin();
      const byLeaving = await inviteAs(leaving.browser, 'left-inviter@example.test', 'member');
      const leave = await leaving.browser.request({
        method: 'DELETE',
        url: `/api/v1/orgs/${org}/members/${leaving.user.id}`,
      });
      expect(leave.statusCode).toBe(204);
      expect(await stateOf(byLeaving.id)).toBe('revoked');
    });

    it('accept re-checks the inviter: an inviter who lost the right to invite makes the link 410', async () => {
      const inviter = await inviterAdmin();
      const invitation = await inviteAs(inviter.browser, 'recheck@example.test', 'admin');
      // Simulates a demotion that raced with the acceptance (no revocation ran).
      await db.kysely
        .updateTable('meta.org_members')
        .set({ role: 'member' })
        .where('organization_id', '=', org)
        .where('user_id', '=', inviter.user.id)
        .execute();
      expect(await stateOf(invitation.id)).toBe('pending');
      expectProblem(
        await t.app.inject({
          method: 'GET',
          url: `/api/v1/invitations/${invitation.token}`,
          remoteAddress: uniqueIp(),
        }),
        410,
        'INVITATION_INVALID',
      );
      expectProblem(
        await accept(invitation.token, { display_name: 'X', password: NEW_PASSWORD }),
        410,
        'INVITATION_INVALID',
      );
      // Restored rights: the link works again.
      await db.kysely
        .updateTable('meta.org_members')
        .set({ role: 'admin' })
        .where('organization_id', '=', org)
        .where('user_id', '=', inviter.user.id)
        .execute();
      const accepted = await accept(invitation.token, {
        display_name: 'Recheck',
        password: NEW_PASSWORD,
      });
      expect(accepted.statusCode).toBe(200);
      expect(acceptInvitationResponseSchema.parse(accepted.json()).role).toBe('admin');
    });
  });
});
