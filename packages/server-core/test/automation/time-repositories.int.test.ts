import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AutomationRunsRepository,
  AutomationsRepository,
  AutomationTimeCursorsRepository,
} from '../../src/automation/index.js';
import {
  listTimeTriggerAutomations,
  orgScope,
  withTxScope,
  type Db,
  type OrgScope,
} from '../../src/db/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_TimeRepoOrgA0001';
const ORG_B = 'org_TimeRepoOrgB0001';
const AUT_A: Id<'aut'> = 'aut_TimeRepoAutA0001';
const AUT_B: Id<'aut'> = 'aut_TimeRepoAutB0001';
const AUT_OFF: Id<'aut'> = 'aut_TimeRepoAutOff01';
const AUT_REC: Id<'aut'> = 'aut_TimeRepoAutRec01';

async function seedAutomation(
  db: Db,
  tenant: SeededTenant,
  id: Id<'aut'>,
  options: { readonly enabled: boolean; readonly type?: string },
): Promise<void> {
  const type = options.type ?? 'schedule';
  await new AutomationsRepository(db).insert(orgScope(tenant.orgId), {
    id,
    baseId: tenant.baseId,
    name: id,
    description: '',
    enabled: options.enabled,
    definition: { trigger: { type: 'schedule', cron: '0 9 * * *' } },
    triggerType: type,
    triggerTableId: null,
    createdBy: tenant.userId,
  });
}

/**
 * BACKLOG T508: the cursors of the time scanner, the keyed runs and the
 * cross-tenant lookup of time-trigger automations stay inside their
 * organization (AGENTS.md rule 5); `trigger_armed_at` follows the
 * enabled transitions (migration 0033).
 */
describe('time trigger repositories (BACKLOG T508)', () => {
  let database: TestDatabase;
  let db: Db;
  let cursors: AutomationTimeCursorsRepository;
  let runs: AutomationRunsRepository;
  let scopeA: OrgScope;
  let scopeB: OrgScope;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    const a = await seedTenant(db, ORG_A);
    const b = await seedTenant(db, ORG_B);
    await seedAutomation(db, a, AUT_A, { enabled: true });
    await seedAutomation(db, b, AUT_B, { enabled: true });
    await seedAutomation(db, a, AUT_OFF, { enabled: false });
    await seedAutomation(db, a, AUT_REC, { enabled: true, type: 'record.created' });
    scopeA = orgScope(ORG_A);
    scopeB = orgScope(ORG_B);
    cursors = new AutomationTimeCursorsRepository(db);
    runs = new AutomationRunsRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('cursors: created once, locked, moved forward only, per organization', async () => {
    const start = new Date('2026-10-05T08:00:00Z');
    await db.withTx(async (tx) => {
      expect(await cursors.lock(withTxScope(scopeA, tx), AUT_A, start)).toEqual(start);
    });
    await db.withTx(async (tx) => {
      // Existing: the initial value is ignored.
      expect(await cursors.lock(withTxScope(scopeA, tx), AUT_A, new Date(0))).toEqual(start);
    });
    // Another organization cannot read, lock or move it.
    expect(await cursors.get(scopeB, AUT_A)).toBeUndefined();
    await expect(
      db.withTx((tx) => cursors.lock(withTxScope(scopeB, tx), AUT_A, start)),
    ).rejects.toThrow();
    await cursors.advance(scopeB, AUT_A, new Date('2026-10-06T00:00:00Z'));
    expect(await cursors.get(scopeA, AUT_A)).toEqual(start);

    const later = new Date('2026-10-05T08:05:00Z');
    await cursors.advance(scopeA, AUT_A, later);
    await cursors.advance(scopeA, AUT_A, start);
    expect(await cursors.get(scopeA, AUT_A)).toEqual(later);
    await expect(db.withTx(async () => cursors.lock(scopeA, AUT_A, start))).rejects.toThrow(
      /transaction/,
    );
  });

  it('keyed runs: one per (automation, key), queued, without an event', async () => {
    const input = {
      automationId: AUT_A,
      automationVersion: 1,
      triggerKey: `${AUT_A}:2026-10-05T01:00:00.000Z`,
      triggerUnit: 'schedule:2026-10-05T01:00:00.000Z',
      depth: 0,
      input: {},
    };
    const first = await runs.insertKeyed(scopeA, { ...input, id: 'run_TimeRepoRunA0001' });
    expect(first).toMatchObject({
      status: 'queued',
      trigger_event_id: null,
      trigger_key: input.triggerKey,
      organization_id: ORG_A,
    });
    expect(await runs.insertKeyed(scopeA, { ...input, id: 'run_TimeRepoRunA0002' })).toBe(
      undefined,
    );
    // The same key on another automation is another run.
    expect(
      await runs.insertKeyed(scopeB, {
        ...input,
        automationId: AUT_B,
        id: 'run_TimeRepoRunB0001',
      }),
    ).toMatchObject({ organization_id: ORG_B });
    // An automation of another organization cannot get a run in this scope.
    await expect(
      runs.insertKeyed(scopeB, { ...input, triggerKey: 'x', id: 'run_TimeRepoRunX0001' }),
    ).rejects.toThrow();
  });

  it('lists enabled time-trigger automations of every organization, ids only, by page', async () => {
    const all = await listTimeTriggerAutomations(db.kysely, {
      type: 'schedule',
      after: null,
      limit: 10,
    });
    expect(all).toEqual([
      { organizationId: ORG_A, automationId: AUT_A },
      { organizationId: ORG_B, automationId: AUT_B },
    ]);
    expect(
      await listTimeTriggerAutomations(db.kysely, {
        type: 'schedule',
        after: { organizationId: ORG_A, automationId: AUT_A },
        limit: 10,
      }),
    ).toEqual([{ organizationId: ORG_B, automationId: AUT_B }]);
    expect(
      await listTimeTriggerAutomations(db.kysely, {
        type: 'record.date_reached',
        after: null,
        limit: 10,
      }),
    ).toEqual([]);
  });

  it('trigger_armed_at is set when the automation is turned on, kept otherwise', async () => {
    const armedOf = async (id: Id<'aut'>) =>
      (
        await db.kysely
          .selectFrom('meta.automations')
          .select('trigger_armed_at')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).trigger_armed_at;
    const armed = await armedOf(AUT_A);
    expect(armed).toBeInstanceOf(Date);
    expect(await armedOf(AUT_OFF)).toBeNull();

    // A change while enabled (name, definition) keeps it.
    await db.kysely
      .updateTable('meta.automations')
      .set({
        name: 'renamed',
        definition: sql`'{"trigger":{"type":"schedule","cron":"0 10 * * *"}}'::jsonb`,
      })
      .where('id', '=', AUT_A)
      .execute();
    expect(await armedOf(AUT_A)).toEqual(armed);

    // Off, then on again: armed again (later).
    await db.kysely
      .updateTable('meta.automations')
      .set({ enabled: false })
      .where('id', '=', AUT_A)
      .execute();
    expect(await armedOf(AUT_A)).toEqual(armed);
    await db.kysely
      .updateTable('meta.automations')
      .set({ enabled: true })
      .where('id', '=', AUT_A)
      .execute();
    const again = await armedOf(AUT_A);
    expect(again?.getTime()).toBeGreaterThan(armed?.getTime() ?? Infinity);
  });
});
