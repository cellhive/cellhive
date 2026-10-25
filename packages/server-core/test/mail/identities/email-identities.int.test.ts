import { Buffer } from 'node:buffer';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deriveSecretKey, sealSecret } from '../../../src/auth/index.js';
import { orgScope, type Db } from '../../../src/db/index.js';
import {
  createMailService,
  EmailIdentitiesRepository,
  EmailIdentityVerificationsRepository,
  EmailSendError,
  identityTransportOf,
  issueVerification,
  parseVerificationToken,
  recordIdentitySendOutcome,
  resolveSender,
  type Mailer,
  type MailTransportRef,
  type NewEmailIdentity,
} from '../../../src/mail/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../../support/postgres.js';
import { startTestSmtp, type TestSmtpServer } from '../../support/smtp-test-server.js';
import { seedTenant, type SeededTenant } from '../../support/tenant.js';

import type { MailConfig } from '../../../src/config/index.js';
import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_IdentRepoOrgA001';
const ORG_B = 'org_IdentRepoOrgB001';
const MASTER = Buffer.alloc(32, 9);
const SMTP_KEY = deriveSecretKey(MASTER, 'email-identity-smtp');
const CODE_KEY = deriveSecretKey(MASTER, 'email-identity-code');
const PASSWORD = 'correct-horse-smtp';

const MAIL: MailConfig = {
  url: 'smtp://relay.cellhive.test:587',
  from: 'Cellhive <noreply@cellhive.test>',
  fromAddress: 'noreply@cellhive.test',
  fromName: 'Cellhive',
  allowedFromDomains: ['cellhive.test', 'corp.test'],
  allowInsecure: true,
};

function systemIdentity(id: Id<'eid'>, email: string): NewEmailIdentity {
  return { id, email, display_name: 'HR', transport: 'system', mode: 'send_as' };
}

describe('email identity repositories (T530)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  let otherBaseA: Id<'bse'>;
  const identities = () => new EmailIdentitiesRepository(db);
  const verifications = () => new EmailIdentityVerificationsRepository(db);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    otherBaseA = 'bse_IdentRepoBase002';
    await db.kysely
      .insertInto('meta.bases')
      .values({
        id: otherBaseA,
        organization_id: ORG_A,
        workspace_id: a.workspaceId,
        owner_id: a.userId,
        name: 'Second',
      })
      .execute();
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('keeps every identity inside its organization (tenant isolation)', async () => {
    const scopeA = orgScope(ORG_A);
    const scopeB = orgScope(ORG_B);
    const hrA = await identities().create(
      scopeA,
      systemIdentity('eid_IsolationHrA0001', 'hr@corp.test'),
    );
    // The same address in another organization is another identity.
    await identities().create(scopeB, systemIdentity('eid_IsolationHrB0001', 'hr@corp.test'));
    await expect(
      identities().create(scopeA, systemIdentity('eid_IsolationDup0001', 'hr@corp.test')),
    ).rejects.toMatchObject({ code: '23505' });

    expect(await identities().findById(scopeB, hrA.id)).toBeUndefined();
    expect(await identities().findByEmail(scopeA, 'hr@corp.test')).toMatchObject({ id: hrA.id });
    expect((await identities().list(scopeB)).map((row) => row.id)).toEqual([
      'eid_IsolationHrB0001',
    ]);
    expect(await identities().update(scopeB, hrA.id, { display_name: 'Hijack' })).toBeUndefined();
    expect(await identities().delete(scopeB, hrA.id)).toBe(false);
    expect(await identities().findById(scopeA, hrA.id)).toMatchObject({ display_name: 'HR' });
    expect(await identities().count(scopeA)).toBe(1);

    // A base of another organization is not a base of this one.
    expect(await identities().existingBaseIds(scopeA, [a.baseId, b.baseId])).toEqual(
      new Set([a.baseId]),
    );
    await expect(identities().replaceBases(scopeA, hrA.id, [b.baseId])).rejects.toMatchObject({
      code: '23503',
      constraint: 'email_identity_bases_base_fkey',
    });
    expect((await identities().baseIdsOf(scopeB, [hrA.id])).size).toBe(0);
  });

  it('lists the identities usable in a base: verified and in scope', async () => {
    const scope = orgScope(ORG_A);
    const all = await identities().create(scope, {
      ...systemIdentity('eid_ScopeAllVerified', 'all@corp.test'),
      status: 'verified',
      verified_at: new Date(),
      verified_via: 'code',
    });
    const selected = await identities().create(scope, {
      ...systemIdentity('eid_ScopeSelected001', 'sel@corp.test'),
      status: 'verified',
      verified_at: new Date(),
      verified_via: 'link',
      base_scope: 'selected',
    });
    await identities().replaceBases(scope, selected.id, [otherBaseA]);
    await identities().create(scope, systemIdentity('eid_ScopePending0001', 'pending@corp.test'));

    expect((await identities().listUsableInBase(scope, a.baseId)).map((row) => row.id)).toEqual([
      all.id,
    ]);
    expect((await identities().listUsableInBase(scope, otherBaseA)).map((row) => row.id)).toEqual([
      all.id,
      selected.id,
    ]);
    expect(await identities().findUsable(scope, selected.id, a.baseId)).toBeUndefined();
    expect(await identities().findUsable(scope, 'eid_ScopePending0001', a.baseId)).toBeUndefined();
    expect(await identities().findUsable(orgScope(ORG_B), all.id, b.baseId)).toBeUndefined();

    // resolveSender: same answer for every reason it is not usable.
    const deps = { identities: identities(), mail: MAIL, smtpKey: SMTP_KEY };
    for (const [identityId, baseId] of [
      [selected.id, a.baseId],
      ['eid_ScopePending0001', a.baseId],
      ['eid_DoesNotExist0001', a.baseId],
    ] as const) {
      expect(
        await resolveSender(deps, scope, {
          identityId,
          baseId,
          locale: 'en',
          systemSenderEnabled: true,
        }),
      ).toEqual({ ok: false, code: 'email_identity_unavailable' });
    }
    expect(
      await resolveSender(deps, orgScope(ORG_B), {
        identityId: all.id,
        baseId: b.baseId,
        locale: 'en',
        systemSenderEnabled: true,
      }),
    ).toEqual({ ok: false, code: 'email_identity_unavailable' });
    const resolved = await resolveSender(deps, scope, {
      identityId: all.id,
      baseId: a.baseId,
      locale: 'en',
      // Only the system sender depends on the toggle (T531).
      systemSenderEnabled: false,
    });
    expect(resolved).toMatchObject({
      ok: true,
      sender: {
        identityId: all.id,
        mode: 'send_as',
        from: { address: 'all@corp.test', name: 'HR' },
        transport: { kind: 'instance' },
        signatureMd: null,
      },
    });
    // The system sender: allowed by default, `email_identity_unavailable` once disabled (T531).
    expect(
      await resolveSender(deps, scope, {
        identityId: null,
        baseId: a.baseId,
        locale: 'en',
        systemSenderEnabled: true,
      }),
    ).toMatchObject({ ok: true, sender: { identityId: null, signatureMd: null } });
    expect(
      await resolveSender(deps, scope, {
        identityId: null,
        baseId: a.baseId,
        locale: 'en',
        systemSenderEnabled: false,
      }),
    ).toEqual({ ok: false, code: 'email_identity_unavailable' });

    // Deleting a base removes it from scopes (composite FK cascade).
    await db.kysely.deleteFrom('meta.bases').where('id', '=', otherBaseA).execute();
    expect((await identities().baseIdsOf(scope, [selected.id])).size).toBe(0);
  });

  it('keeps verifications per organization and replaces them on a new send', async () => {
    const scopeA = orgScope(ORG_A);
    const scopeB = orgScope(ORG_B);
    const identity = await identities().create(
      scopeA,
      systemIdentity('eid_VerifyIdentity01', 'verify@corp.test'),
    );
    const first = issueVerification(CODE_KEY, ORG_A, identity.id);
    await verifications().issue(scopeA, {
      identityId: identity.id,
      email: identity.email,
      tokenHash: first.tokenHash,
      codeHash: first.codeHash,
      requestedBy: a.userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const parsed = parseVerificationToken(first.token);
    expect(parsed?.organizationId).toBe(ORG_A);
    expect(await verifications().findByTokenHash(scopeA, parsed?.tokenHash ?? '')).toMatchObject({
      identity_id: identity.id,
    });
    // The same hash looked up in another organization finds nothing.
    expect(await verifications().findByTokenHash(scopeB, parsed?.tokenHash ?? '')).toBeUndefined();
    expect(await verifications().findByIdentity(scopeB, identity.id)).toBeUndefined();

    expect(await verifications().recordFailedAttempt(scopeA, identity.id)).toBe(1);
    expect(await verifications().recordFailedAttempt(scopeB, identity.id)).toBe(0);

    const second = issueVerification(CODE_KEY, ORG_A, identity.id);
    await verifications().issue(scopeA, {
      identityId: identity.id,
      email: identity.email,
      tokenHash: second.tokenHash,
      codeHash: second.codeHash,
      requestedBy: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await verifications().findByTokenHash(scopeA, first.tokenHash)).toBeUndefined();
    expect(await verifications().findByIdentity(scopeA, identity.id)).toMatchObject({
      token_hash: second.tokenHash,
      failed_attempts: 0,
    });
    await verifications().delete(scopeB, identity.id);
    expect(await verifications().findByIdentity(scopeA, identity.id)).toBeDefined();
    // Deleting the identity deletes its verification.
    await identities().delete(scopeA, identity.id);
    expect(await verifications().findByIdentity(scopeA, identity.id)).toBeUndefined();
  });

  it('puts every child table on composite keys with organization_id', async () => {
    const { rows } = await sql<{ name: string; definition: string }>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid IN ('meta.email_identity_bases'::regclass,
                          'meta.email_identity_verifications'::regclass)
         AND contype = 'f'
       ORDER BY conname
    `.execute(db.kysely);
    expect(rows).toEqual([
      {
        name: 'email_identity_bases_base_fkey',
        definition:
          'FOREIGN KEY (organization_id, base_id) REFERENCES meta.bases(organization_id, id) ON DELETE CASCADE',
      },
      {
        name: 'email_identity_bases_identity_fkey',
        definition:
          'FOREIGN KEY (organization_id, identity_id) REFERENCES meta.email_identities(organization_id, id) ON DELETE CASCADE',
      },
      {
        name: 'email_identity_verifications_identity_fkey',
        definition:
          'FOREIGN KEY (organization_id, identity_id) REFERENCES meta.email_identities(organization_id, id) ON DELETE CASCADE',
      },
      {
        name: 'email_identity_verifications_requested_by_fkey',
        definition: 'FOREIGN KEY (requested_by) REFERENCES meta.users(id) ON DELETE SET NULL',
      },
    ]);
  });

  it('rejects SMTP settings that do not match the transport', async () => {
    const scope = orgScope(ORG_A);
    await expect(
      identities().create(scope, {
        ...systemIdentity('eid_BadSmtpSettings1', 'bad1@corp.test'),
        smtp_host: 'mail.corp.test',
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'email_identities_smtp_check' });
    await expect(
      identities().create(scope, {
        ...systemIdentity('eid_BadSmtpSettings2', 'bad2@corp.test'),
        transport: 'smtp',
        smtp_host: 'mail.corp.test',
        smtp_port: 2526,
        smtp_security: 'tls',
        smtp_username: 'u',
        smtp_password_enc: 'x',
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'email_identities_smtp_check' });
    await expect(
      identities().create(scope, {
        ...systemIdentity('eid_BadSmtpSettings3', 'Upper@corp.test'),
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'email_identities_email_check' });
  });

  describe('repeated authentication failures while sending (ADR-33 §1A)', () => {
    let smtp: TestSmtpServer;
    let mailer: Mailer;

    beforeAll(async () => {
      smtp = await startTestSmtp({ auth: { user: 'it@corp.test', pass: PASSWORD } });
      mailer = createMailService(
        {
          mail: null,
          email: {
            maxPerHourPerOrg: 500,
            maxRecipients: 50,
            maxPerSecond: 1000,
            testSendsPerMinute: 5,
            maxHtmlBytes: 100_000,
            allowPrivateSmtpHosts: true,
            maxPerHourPerIdentity: 100,
            automationFooter: 'required',
            maxAttachments: 10,
            maxAttachmentBytes: 15 * 1024 * 1024,
            maxInlineImages: 5,
          },
        },
        {},
      );
    });

    afterAll(async () => {
      mailer.close();
      await smtp.close();
    });

    /** Rows hold an allowed port (2525); the test server listens on a random one. */
    function onTestPort(transport: MailTransportRef): MailTransportRef {
      return transport.kind === 'identity'
        ? { ...transport, endpoint: { ...transport.endpoint, port: smtp.port } }
        : transport;
    }

    it('moves a verified identity to error after 3 refusals in a row, audited once', async () => {
      const scope = orgScope(ORG_A);
      const row = await identities().create(scope, {
        ...systemIdentity('eid_AuthFailures0001', 'it@corp.test'),
        transport: 'smtp',
        status: 'verified',
        verified_at: new Date(),
        verified_via: 'code',
        smtp_host: '127.0.0.1',
        smtp_port: 2525,
        smtp_security: 'none',
        smtp_username: 'it@corp.test',
        // The server changed the password since.
        smtp_password_enc: sealSecret(SMTP_KEY, 'old-password'),
      });
      const deps = { db, identities: identities(), mailer };
      const send = async () => {
        const transport = onTestPort(
          identityTransportOf((await identities().findById(scope, row.id)) ?? row, SMTP_KEY),
        );
        let error: unknown = null;
        try {
          await mailer.send({
            to: 'someone@example.test',
            subject: 'Hi',
            text: 'Hi',
            html: '<p>Hi</p>',
            transport,
            origin: { kind: 'automation', organizationId: ORG_A, automationId: 'aut_x' },
          });
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(EmailSendError);
        return recordIdentitySendOutcome(deps, ORG_A, transport, error);
      };

      expect(await send()).toBe('auth_failed');
      expect(await send()).toBe('auth_failed');
      expect(await send()).toBe('identity_error');
      const after = await identities().findById(scope, row.id);
      expect(after).toMatchObject({
        status: 'error',
        error_reason: 'auth_failed',
        auth_failures: 3,
      });
      // Further failures are counted, not audited again; the identity is no longer usable.
      expect(await send()).toBe('auth_failed');
      expect(await identities().findUsable(scope, row.id, a.baseId)).toBeUndefined();

      const audit = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['action', 'after', 'actor_type'])
        .where('organization_id', '=', ORG_A)
        .where('entity_id', '=', row.id)
        .execute();
      expect(audit).toEqual([
        {
          action: 'email_identity.error',
          actor_type: 'system',
          after: {
            status: 'error',
            error_reason: 'auth_failed',
            smtp_code: 535,
            smtp_enhanced: null,
          },
        },
      ]);
      const events = await db.kysely
        .selectFrom('meta.events')
        .select(['type', 'entity_type'])
        .where('organization_id', '=', ORG_A)
        .where('entity_id', '=', row.id)
        .execute();
      expect(events).toEqual([{ type: 'email_identity.error', entity_type: 'email_identity' }]);
      expect(JSON.stringify(audit)).not.toContain('old-password');
      expect(smtp.messages).toHaveLength(0);
    });

    it('a successful send restarts the count', async () => {
      const scope = orgScope(ORG_A);
      const row = await identities().create(scope, {
        ...systemIdentity('eid_AuthRecovers0001', 'it2@corp.test'),
        transport: 'smtp',
        status: 'verified',
        verified_at: new Date(),
        verified_via: 'code',
        smtp_host: '127.0.0.1',
        smtp_port: 2525,
        smtp_security: 'none',
        smtp_username: 'it@corp.test',
        smtp_password_enc: sealSecret(SMTP_KEY, PASSWORD),
        auth_failures: 2,
      });
      const transport = onTestPort(identityTransportOf(row, SMTP_KEY));
      expect(
        await recordIdentitySendOutcome(
          { db, identities: identities(), mailer },
          ORG_A,
          transport,
          null,
        ),
      ).toBe('ok');
      expect(await identities().findById(scope, row.id)).toMatchObject({ auth_failures: 0 });
      // A failure of an older SMTP version (credentials changed since) is ignored.
      const stale = { ...transport, version: 99 } as typeof transport;
      const refused = new EmailSendError('smtp_rejected', 'x', {
        retryable: false,
        reason: 'auth_failed',
      });
      expect(
        await recordIdentitySendOutcome(
          { db, identities: identities(), mailer },
          ORG_A,
          stale,
          refused,
        ),
      ).toBe('other');
      expect(await identities().findById(scope, row.id)).toMatchObject({ auth_failures: 0 });
    });
  });
});
