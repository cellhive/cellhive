import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AutomationsRepository } from '../../src/automation/index.js';
import {
  listExpiredEmailAssets,
  orgScope,
  withTxScope,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import {
  checkSignatureAssets,
  emailAssetObjectKey,
  EmailAssetsRepository,
} from '../../src/mail/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A: Id<'org'> = 'org_EmailAssetOrgA01';
const ORG_B: Id<'org'> = 'org_EmailAssetOrgB01';
const AUT_A: Id<'aut'> = 'aut_EmailAssetAutA01';
const AUT_B: Id<'aut'> = 'aut_EmailAssetAutB01';
const SHA = 'c'.repeat(64);
const LATER = () => new Date(Date.now() + 3_600_000);

interface Tenant extends SeededTenant {
  readonly scope: OrgScope;
}

/**
 * `EmailAssetsRepository` (migration 0035, T534): every method is scoped by
 * organization (AGENTS.md rule 5); an asset is kept while a signature (the
 * organization default, a sender identity) or its automation's definition
 * says `asset:<id>` — in its own organization only — and the cleanup's
 * cross-tenant lookup lists exactly the others.
 */
describe('EmailAssetsRepository (T534)', () => {
  let database: TestDatabase;
  let db: Db;
  let repo: EmailAssetsRepository;
  let a: Tenant;
  let b: Tenant;

  async function tenant(orgId: Id<'org'>, automationId: Id<'aut'>): Promise<Tenant> {
    const seeded = await seedTenant(db, orgId);
    const scope = orgScope(orgId);
    await new AutomationsRepository(db).insert(scope, {
      id: automationId,
      baseId: seeded.baseId,
      name: 'Mail',
      description: '',
      enabled: false,
      definition: { trigger: { type: 'schedule' }, actions: [] },
      triggerType: 'schedule',
      triggerTableId: null,
      createdBy: seeded.userId,
    });
    return { ...seeded, scope };
  }

  const signatureAsset = (t: Tenant) =>
    repo.create(t.scope, {
      kind: 'signature',
      automationId: null,
      createdBy: t.userId,
      filename: 'logo.png',
      mime: 'image/png',
      size: 10,
    });
  const automationAsset = (t: Tenant, automationId: Id<'aut'>) =>
    repo.create(t.scope, {
      kind: 'automation',
      automationId,
      createdBy: t.userId,
      filename: 'ảnh.jpg',
      mime: 'image/jpeg',
      size: 10,
    });
  const ready = (t: Tenant, id: Id<'att'>) =>
    repo.markReady(t.scope, id, { mime: 'image/png', size: 8, sha256: SHA, width: 4, height: 2 });

  const setDefaultSignature = (orgId: Id<'org'>, markdown: string | null) =>
    sql`UPDATE meta.organizations
           SET settings = jsonb_build_object('email',
             jsonb_build_object('default_signature_md', ${markdown}::text))
         WHERE id = ${orgId}`.execute(db.kysely);
  const setDefinition = (automationId: Id<'aut'>, body: string) =>
    sql`UPDATE meta.automations
           SET definition = jsonb_build_object('actions', jsonb_build_array(
             jsonb_build_object('type', 'send_email', 'config',
               jsonb_build_object('body', jsonb_build_object('template', ${body}::text)))))
         WHERE id = ${automationId}`.execute(db.kysely);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    repo = new EmailAssetsRepository(db);
    a = await tenant(ORG_A, AUT_A);
    b = await tenant(ORG_B, AUT_B);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('stores assets under {organization_id}/{id}, pending until processed', async () => {
    const row = await automationAsset(a, AUT_A);
    expect(row).toMatchObject({
      object_key: emailAssetObjectKey(ORG_A, row.id),
      kind: 'automation',
      automation_id: AUT_A,
      status: 'pending_upload',
      width: null,
    });
    expect(await repo.getReady(a.scope, [row.id])).toEqual([]);
    expect(await ready(a, row.id)).toMatchObject({
      status: 'ready',
      mime: 'image/png',
      size: 8n,
      width: 4,
      height: 2,
    });
    expect(await ready(a, row.id)).toBeUndefined();
    expect((await repo.getReady(a.scope, [row.id])).map((item) => item.id)).toEqual([row.id]);
    expect(await repo.deleteByIds(a.scope, [row.id])).toBe(1);
  });

  it('never reads, changes, locks or deletes an asset of another organization', async () => {
    const other = await signatureAsset(b);
    await ready(b, other.id);
    expect(await repo.getById(a.scope, other.id)).toBeUndefined();
    expect(await repo.getReady(a.scope, [other.id])).toEqual([]);
    expect(await ready(a, other.id)).toBeUndefined();
    expect(await repo.isReferenced(a.scope, other.id)).toBe(false);
    expect(await db.withTx((tx) => repo.lockById(withTxScope(a.scope, tx), other.id))).toBe(
      undefined,
    );
    expect(await repo.lockUnreferenced(a.scope, [other.id], LATER())).toEqual([]);
    expect(await repo.deleteByIds(a.scope, [other.id])).toBe(0);
    // A signature of organization A naming B's asset does not make it usable in A.
    await expect(
      checkSignatureAssets(repo, a.scope, `![x](asset:${other.id})`, 'signature_md'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'signature_md', code: 'EMAIL_IMAGE_NOT_FOUND' }],
    });
    await expect(
      checkSignatureAssets(repo, b.scope, `![x](asset:${other.id})`, 'signature_md'),
    ).resolves.toBeUndefined();
    expect(await repo.deleteByIds(b.scope, [other.id])).toBe(1);
  });

  it('keeps assets their own signatures or automation reference; lists the others', async () => {
    const byDefault = await signatureAsset(a);
    const byIdentity = await signatureAsset(a);
    const byAutomation = await automationAsset(a, AUT_A);
    const unused = await signatureAsset(a);
    const wrongAutomation = await automationAsset(a, AUT_A);
    const foreign = await signatureAsset(b);
    await setDefaultSignature(ORG_A, `**A** ![logo](asset:${byDefault.id} =120)`);
    await db.kysely
      .insertInto('meta.email_identities')
      .values({
        id: 'eid_EmailAssetIdent01',
        organization_id: ORG_A,
        email: 'hr@a.example',
        display_name: 'HR',
        transport: 'system',
        mode: 'on_behalf',
        signature_md: `![x](asset:${byIdentity.id})`,
      })
      .execute();
    await setDefinition(AUT_A, `Hi ![p](asset:${byAutomation.id})`);
    // Another automation, and another organization, naming an asset do not keep it.
    await setDefinition(AUT_B, `![p](asset:${wrongAutomation.id}) ![q](asset:${unused.id})`);
    await setDefaultSignature(ORG_B, `![q](asset:${unused.id})`);

    expect(await repo.isReferenced(a.scope, byDefault.id)).toBe(true);
    expect(await repo.isReferenced(a.scope, byIdentity.id)).toBe(true);
    expect(await repo.isReferenced(a.scope, byAutomation.id)).toBe(true);
    expect(await repo.isReferenced(a.scope, unused.id)).toBe(false);
    expect(await repo.isReferenced(a.scope, wrongAutomation.id)).toBe(false);

    const expired = await listExpiredEmailAssets(db.kysely, { createdBefore: LATER(), limit: 50 });
    const ids = expired.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([unused.id, wrongAutomation.id, foreign.id]));
    expect(ids).not.toContain(byDefault.id);
    expect(ids).not.toContain(byIdentity.id);
    expect(ids).not.toContain(byAutomation.id);
    expect(expired.find((item) => item.id === foreign.id)?.organizationId).toBe(ORG_B);
    // Recent uploads are kept.
    expect(
      await listExpiredEmailAssets(db.kysely, { createdBefore: new Date(0), limit: 50 }),
    ).toEqual([]);

    const locked = await db.withTx((tx) =>
      repo.lockUnreferenced(
        withTxScope(a.scope, tx),
        [byDefault.id, byIdentity.id, byAutomation.id, unused.id, wrongAutomation.id, foreign.id],
        LATER(),
      ),
    );
    expect(locked.map((row) => row.id).sort()).toEqual([unused.id, wrongAutomation.id].sort());
  });

  it('keeps the asset row when its automation goes, without automation (then unreferenced)', async () => {
    const id: Id<'aut'> = 'aut_EmailAssetGone001';
    await new AutomationsRepository(db).insert(a.scope, {
      id,
      baseId: a.baseId,
      name: 'Gone',
      description: '',
      enabled: false,
      definition: {},
      triggerType: 'schedule',
      triggerTableId: null,
      createdBy: a.userId,
    });
    const row = await automationAsset(a, id);
    await setDefinition(id, `![p](asset:${row.id})`);
    expect(await repo.isReferenced(a.scope, row.id)).toBe(true);
    await sql`DELETE FROM meta.automations WHERE id = ${id}`.execute(db.kysely);
    expect(await repo.getById(a.scope, row.id)).toMatchObject({
      kind: 'automation',
      automation_id: null,
    });
    expect(await repo.isReferenced(a.scope, row.id)).toBe(false);
  });

  it('stages copies of no automation (cleanup-listed) and attaches them once (T551)', async () => {
    const copyOf: Id<'aut'> = 'aut_EmailAssetCopy001';
    await new AutomationsRepository(db).insert(a.scope, {
      id: copyOf,
      baseId: a.baseId,
      name: 'Copy',
      description: '',
      enabled: false,
      definition: {},
      triggerType: 'schedule',
      triggerTableId: null,
      createdBy: a.userId,
    });
    const source = await automationAsset(a, AUT_A);
    const processed = await ready(a, source.id);
    if (processed === undefined) throw new Error('not ready');
    const copy = await repo.insertCopy(a.scope, processed, a.userId);
    expect(copy).toMatchObject({
      organization_id: ORG_A,
      kind: 'automation',
      automation_id: null,
      object_key: emailAssetObjectKey(ORG_A, copy.id),
      filename: processed.filename,
      mime: 'image/png',
      size: 8n,
      width: 4,
      height: 2,
      sha256: SHA,
      status: 'ready',
      created_by: a.userId,
    });
    expect(copy.id).not.toBe(source.id);
    // Nothing references a staged copy: the cleanup lists it (after 24 hours).
    expect(await repo.isReferenced(a.scope, copy.id)).toBe(false);
    expect(
      (await listExpiredEmailAssets(db.kysely, { createdBefore: LATER(), limit: 500 })).map(
        (item) => item.id,
      ),
    ).toContain(copy.id);

    // Another organization neither attaches nor sees it.
    expect(await repo.attachCopies(b.scope, [copy.id], AUT_B)).toBe(0);
    expect(await repo.getById(b.scope, copy.id)).toBeUndefined();
    // Only staged copies attach: not an asset that has an automation, not a signature asset.
    const signature = await signatureAsset(a);
    await ready(a, signature.id);
    expect(await repo.attachCopies(a.scope, [source.id, signature.id], copyOf)).toBe(0);
    expect(await repo.attachCopies(a.scope, [], copyOf)).toBe(0);
    expect(await repo.attachCopies(a.scope, [copy.id], copyOf)).toBe(1);
    expect(await repo.attachCopies(a.scope, [copy.id], AUT_A)).toBe(0);
    expect((await repo.getById(a.scope, copy.id))?.automation_id).toBe(copyOf);
    await setDefinition(copyOf, `![p](asset:${copy.id})`);
    expect(await repo.isReferenced(a.scope, copy.id)).toBe(true);
    expect(await repo.deleteByIds(a.scope, [signature.id])).toBe(1);
  });

  it('never stages a copy into another organization (T551)', async () => {
    const source = await automationAsset(b, AUT_B);
    const processed = await ready(b, source.id);
    if (processed === undefined) throw new Error('not ready');
    // The scope decides the organization and the key, whatever row is passed.
    const copy = await repo.insertCopy(a.scope, processed, a.userId);
    expect(copy.organization_id).toBe(ORG_A);
    expect(copy.object_key).toBe(emailAssetObjectKey(ORG_A, copy.id));
    expect(await repo.getById(b.scope, copy.id)).toBeUndefined();
    expect(await repo.deleteByIds(b.scope, [copy.id])).toBe(0);
    expect(await repo.deleteByIds(a.scope, [copy.id])).toBe(1);
  });

  it('refuses a signature asset with an automation and unknown kinds', async () => {
    await expect(
      sql`INSERT INTO meta.email_assets (id, organization_id, kind, automation_id, object_key,
            filename, mime, size)
          VALUES ('att_EmailAssetBad0001', ${ORG_A}, 'signature', ${AUT_A}, 'k', 'a.png',
            'image/png', 1)`.execute(db.kysely),
    ).rejects.toThrow(/email_assets_signature_check/u);
    await expect(
      sql`INSERT INTO meta.email_assets (id, organization_id, kind, object_key, filename, mime, size)
          VALUES ('att_EmailAssetBad0002', ${ORG_A}, 'signature', 'k', 'a.svg',
            'image/svg+xml', 1)`.execute(db.kysely),
    ).rejects.toThrow(/email_assets_mime_check/u);
  });
});
