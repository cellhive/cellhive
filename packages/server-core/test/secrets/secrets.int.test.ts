import { Buffer } from 'node:buffer';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deriveSecretKey, sealSecret, unsealSecret } from '../../src/auth/index.js';
import { AutomationsRepository } from '../../src/automation/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { SecretsRepository, SecretUsageRepository } from '../../src/secrets/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_SecretRepoOrgA01';
const ORG_B = 'org_SecretRepoOrgB01';
const KEY = deriveSecretKey(Buffer.alloc(32, 5), 'org-secret');
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';

describe('secret repositories (BACKLOG T516)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  const otherBaseA: Id<'bse'> = 'bse_SecretRepoBase02';
  const secrets = () => new SecretsRepository(db);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
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

  it('keeps every secret inside its organization (tenant isolation)', async () => {
    const scopeA = orgScope(ORG_A);
    const scopeB = orgScope(ORG_B);
    const botA = await secrets().create(scopeA, {
      id: 'sec_SecretRepoBotA01',
      kind: 'telegram_bot',
      name: 'Bot IT',
      ciphertext: sealSecret(KEY, TOKEN),
      created_by: a.userId,
    });
    await secrets().create(scopeB, {
      id: 'sec_SecretRepoBotB01',
      kind: 'telegram_bot',
      name: 'Bot IT',
      ciphertext: sealSecret(KEY, TOKEN),
      created_by: b.userId,
    });
    expect(unsealSecret(KEY, botA.ciphertext)).toBe(TOKEN);
    expect(botA.ciphertext).not.toContain(TOKEN);

    expect((await secrets().list(scopeA)).map((row) => row.id)).toEqual(['sec_SecretRepoBotA01']);
    const [listed] = await secrets().list(scopeA);
    expect(listed).not.toHaveProperty('ciphertext');
    expect(listed).not.toHaveProperty('previous_ciphertext');
    expect(listed?.created_by_name).toBe(a.userId.replace('usr_', ''));
    expect(await secrets().findById(scopeB, botA.id)).toBeUndefined();
    expect(await secrets().update(scopeB, botA.id, { name: 'x' })).toBeUndefined();
    expect(await secrets().delete(scopeB, botA.id)).toBe(false);
    expect(await secrets().findUsable(scopeB, botA.id, b.baseId, 'telegram_bot')).toBeUndefined();
    expect(await secrets().count(scopeA)).toBe(1);
    expect(await secrets().existingBaseIds(scopeB, [a.baseId])).toEqual(new Set());
  });

  it('refuses a duplicate name (any case) and a base of another organization', async () => {
    const scopeA = orgScope(ORG_A);
    await expect(
      secrets().create(scopeA, {
        id: 'sec_SecretRepoDupl01',
        kind: 'telegram_bot',
        name: 'bot it',
        ciphertext: sealSecret(KEY, TOKEN),
      }),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      secrets().replaceBases(scopeA, 'sec_SecretRepoBotA01', [b.baseId]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('scopes a secret to the selected bases', async () => {
    const scopeA = orgScope(ORG_A);
    const id: Id<'sec'> = 'sec_SecretRepoSales1';
    await secrets().create(scopeA, {
      id,
      kind: 'telegram_bot',
      name: 'Bot Sales',
      ciphertext: sealSecret(KEY, TOKEN),
      base_scope: 'selected',
    });
    await secrets().replaceBases(scopeA, id, [otherBaseA]);
    expect((await secrets().listUsableInBase(scopeA, a.baseId)).map((row) => row.name)).toEqual([
      'Bot IT',
    ]);
    expect(
      (await secrets().listUsableInBase(scopeA, otherBaseA, 'telegram_bot')).map((row) => row.name),
    ).toEqual(['Bot IT', 'Bot Sales']);
    expect(await secrets().findUsable(scopeA, id, a.baseId, 'telegram_bot')).toBeUndefined();
    expect((await secrets().findUsable(scopeA, id, otherBaseA, 'telegram_bot'))?.id).toBe(id);
    expect(await secrets().baseIdsOf(scopeA, [id])).toEqual(new Map([[id, [otherBaseA]]]));

    // Deleting the base drops it from the scope (composite foreign key, cascade).
    await sql`DELETE FROM meta.bases WHERE id = ${otherBaseA}`.execute(db.kysely);
    expect(await secrets().baseIdsOf(scopeA, [id])).toEqual(new Map());
  });

  it('lists the automations whose steps use a secret, branches included', async () => {
    const scopeA = orgScope(ORG_A);
    const automations = new AutomationsRepository(db);
    const step = (secretId: string) => ({
      id: 'act_tg',
      type: 'send_telegram',
      config: { secret_id: secretId, chat_id: { literal: '1' }, text: { template: 'x' } },
    });
    const insert = (id: Id<'aut'>, tenant: SeededTenant, actions: unknown[]) =>
      automations.insert(orgScope(tenant.orgId), {
        id,
        baseId: tenant.baseId,
        name: id,
        description: '',
        enabled: false,
        definition: { trigger: { type: 'schedule', cron: '0 8 * * *' }, actions } as never,
        triggerType: 'schedule',
        triggerTableId: null,
        createdBy: tenant.userId,
      });
    await insert('aut_SecretRepoUses01', a, [step('sec_SecretRepoBotA01')]);
    await insert('aut_SecretRepoUses02', a, [
      { id: 'act_if', type: 'if', config: { then: [], else: [step('sec_SecretRepoBotA01')] } },
    ]);
    await insert('aut_SecretRepoOther1', a, [step('sec_SecretRepoSales1')]);
    await insert('aut_SecretRepoOrgB01', b, [step('sec_SecretRepoBotA01')]);
    const usages = new SecretUsageRepository(db);
    expect(
      (await usages.list(scopeA, 'sec_SecretRepoBotA01')).map((row) => row.automationId),
    ).toEqual(['aut_SecretRepoUses01', 'aut_SecretRepoUses02']);
    await sql`UPDATE meta.automations SET deleted_at = now() WHERE id = 'aut_SecretRepoUses02'`.execute(
      db.kysely,
    );
    expect(
      (await usages.list(scopeA, 'sec_SecretRepoBotA01')).map((row) => row.automationId),
    ).toEqual(['aut_SecretRepoUses01']);
  });
});
