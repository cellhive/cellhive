import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orgScope, type Db } from '../../src/db/index.js';
import { SystemSenderUsageRepository } from '../../src/mail/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { JsonObject } from '../../src/db/schema.js';
import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_SysSenderOrgA001';
const ORG_B = 'org_SysSenderOrgB001';

function sendEmail(id: string, identityId?: string | null): JsonObject {
  return {
    id,
    type: 'send_email',
    config: identityId === undefined ? { to: [] } : { identity_id: identityId, to: [] },
  };
}

function definition(actions: JsonObject[]): JsonObject {
  return { trigger: { type: 'record.created', table_id: 'tbl_X' }, condition: null, actions };
}

describe('SystemSenderUsageRepository (T531)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  let counter = 0;
  const repository = () => new SystemSenderUsageRepository(db);

  async function automation(
    tenant: SeededTenant,
    actions: JsonObject[],
    options: { enabled?: boolean; deleted?: boolean } = {},
  ): Promise<void> {
    counter += 1;
    const id = `aut_SysSender${String(counter).padStart(7, '0')}` as Id<'aut'>;
    await db.kysely
      .insertInto('meta.automations')
      .values({
        id,
        organization_id: tenant.orgId,
        base_id: tenant.baseId,
        name: `Automation ${String(counter)}`,
        enabled: options.enabled ?? false,
        definition: definition(actions),
        trigger_type: 'record.created',
        trigger_table_id: null,
        created_by: tenant.userId,
        updated_by: tenant.userId,
        run_as_user_id: tenant.userId,
        deleted_at: options.deleted === true ? new Date() : null,
      })
      .execute();
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

  it('counts automations sending with the system sender, top level or in an if branch', async () => {
    const scope = orgScope(ORG_A);
    expect(await repository().count(scope)).toEqual({ automations: 0, enabledAutomations: 0 });

    // Counted: null identity (enabled), absent identity, in `then`, in `else`.
    await automation(a, [sendEmail('act_1', null)], { enabled: true });
    await automation(a, [sendEmail('act_1')]);
    await automation(a, [
      { id: 'act_1', type: 'if', config: { then: [sendEmail('act_2', null)], else: [] } },
    ]);
    await automation(
      a,
      [{ id: 'act_1', type: 'if', config: { then: [], else: [sendEmail('act_3', null)] } }],
      { enabled: true },
    );
    // Not counted: identity set, other actions, deleted.
    await automation(a, [sendEmail('act_1', 'eid_SysSenderIdent01')], { enabled: true });
    await automation(a, [{ id: 'act_1', type: 'delay', config: { identity_id: null } }]);
    await automation(a, [sendEmail('act_1', null)], { deleted: true });

    expect(await repository().count(scope)).toEqual({ automations: 4, enabledAutomations: 2 });
  });

  it('is isolated per organization', async () => {
    await automation(b, [sendEmail('act_1', null)], { enabled: true });
    expect(await repository().count(orgScope(ORG_B))).toEqual({
      automations: 1,
      enabledAutomations: 1,
    });
    expect(await repository().count(orgScope(ORG_A))).toEqual({
      automations: 4,
      enabledAutomations: 2,
    });
    expect(await repository().count(orgScope('org_SysSenderNone001'))).toEqual({
      automations: 0,
      enabledAutomations: 0,
    });
  });

  it('requires an OrgScope', async () => {
    await expect(
      repository().count({ organizationId: ORG_A } as unknown as ReturnType<typeof orgScope>),
    ).rejects.toThrow(TypeError);
  });
});
