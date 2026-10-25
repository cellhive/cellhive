import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RecipientMembersRepository } from '../../src/automation/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { EmailIdentityUsageRepository } from '../../src/mail/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { JsonObject } from '../../src/db/schema.js';
import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_SendMailOrgA0001';
const ORG_B = 'org_SendMailOrgB0001';
const EID_A: Id<'eid'> = 'eid_SendMailIdentA01';
const EID_B: Id<'eid'> = 'eid_SendMailIdentB01';

function sendEmail(id: string, config: JsonObject): JsonObject {
  return { id, type: 'send_email', config: { to: [], ...config } };
}

/**
 * BACKLOG T514 repositories: recipients as active members of the
 * organization, and the automations using a sender identity — both scoped
 * to their organization (AGENTS.md rule 5).
 */
describe('send_email repositories (T514)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  let counter = 0;

  async function user(
    tenant: SeededTenant | null,
    email: string,
    status: 'active' | 'disabled' = 'active',
  ): Promise<Id<'usr'>> {
    counter += 1;
    const id = `usr_SendMailUser${String(counter).padStart(4, '0')}` as Id<'usr'>;
    await db.kysely
      .insertInto('meta.users')
      .values({ id, email, display_name: `User ${String(counter)}`, status })
      .execute();
    if (tenant !== null) {
      await db.kysely
        .insertInto('meta.org_members')
        .values({ organization_id: tenant.orgId, user_id: id, role: 'member' })
        .execute();
    }
    return id;
  }

  async function automation(
    tenant: SeededTenant,
    name: string,
    actions: JsonObject[],
    deleted = false,
  ): Promise<Id<'aut'>> {
    counter += 1;
    const id = `aut_SendMail${String(counter).padStart(8, '0')}` as Id<'aut'>;
    await db.kysely
      .insertInto('meta.automations')
      .values({
        id,
        organization_id: tenant.orgId,
        base_id: tenant.baseId,
        name,
        enabled: !deleted,
        definition: {
          trigger: { type: 'record.created', table_id: 'tbl_X' },
          condition: null,
          actions,
        },
        trigger_type: 'record.created',
        trigger_table_id: null,
        created_by: tenant.userId,
        updated_by: tenant.userId,
        run_as_user_id: tenant.userId,
        deleted_at: deleted ? new Date() : null,
      })
      .execute();
    return id;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('RecipientMembersRepository: active members of this organization only', async () => {
    const active = await user(a, 'Lan@Corp.test');
    const disabled = await user(a, 'old@corp.test', 'disabled');
    const elsewhere = await user(b, 'b@corp.test');
    const nobody = await user(null, 'nobody@corp.test');
    const repository = new RecipientMembersRepository(db);

    const members = await repository.activeMembers(orgScope(ORG_A), [
      active,
      disabled,
      elsewhere,
      nobody,
    ]);
    expect([...members.keys()]).toEqual([active]);
    expect(members.get(active)).toMatchObject({ email: 'Lan@Corp.test' });
    expect((await repository.activeMembers(orgScope(ORG_B), [active])).size).toBe(0);

    expect(
      await repository.memberAddresses(orgScope(ORG_A), [
        'lan@corp.test',
        'old@corp.test',
        'b@corp.test',
        'nobody@corp.test',
      ]),
    ).toEqual(new Set(['lan@corp.test']));
    expect(await repository.memberAddresses(orgScope(ORG_B), ['lan@corp.test'])).toEqual(new Set());
    expect(await repository.activeMembers(orgScope(ORG_A), [])).toEqual(new Map());
  });

  it('EmailIdentityUsageRepository: sender or Reply-To, if branches, not deleted, this organization', async () => {
    const asSender = await automation(a, 'B sender', [sendEmail('act_1', { identity_id: EID_A })]);
    const asReplyTo = await automation(a, 'A reply', [
      sendEmail('act_1', { identity_id: null, reply_to: { identity_id: EID_A } }),
    ]);
    const inBranch = await automation(a, 'C branch', [
      {
        id: 'act_if',
        type: 'if',
        config: { conditions: [], then: [], else: [sendEmail('act_2', { identity_id: EID_A })] },
      },
    ]);
    await automation(a, 'D other identity', [sendEmail('act_1', { identity_id: EID_B })]);
    await automation(a, 'E deleted', [sendEmail('act_1', { identity_id: EID_A })], true);
    await automation(a, 'F not email', [
      { id: 'act_1', type: 'create_record', config: { identity_id: EID_A } },
    ]);
    await automation(b, 'G other org', [sendEmail('act_1', { identity_id: EID_A })]);

    const repository = new EmailIdentityUsageRepository(db);
    const rows = await repository.list(orgScope(ORG_A), EID_A);
    expect(rows.map((row) => [row.name, row.automationId])).toEqual([
      ['A reply', asReplyTo],
      ['B sender', asSender],
      ['C branch', inBranch],
    ]);
    expect(rows[0]).toMatchObject({ baseId: a.baseId, triggerTableId: null, enabled: true });
    expect((await repository.list(orgScope(ORG_B), EID_A)).map((row) => row.name)).toEqual([
      'G other org',
    ]);
    // A quote in the id is a value, never part of the path.
    expect(await repository.list(orgScope(ORG_A), 'eid_" || true || "x')).toEqual([]);
  });
});
