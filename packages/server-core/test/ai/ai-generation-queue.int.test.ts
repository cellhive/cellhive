import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AiGenerationQueueRepository,
  listAiGenerationRescueOrganizations,
  measureAiGenerationQueue,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
} from '../../src/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A: Id<'org'> = 'org_AiQueueOrgAAAAA1';
const ORG_B: Id<'org'> = 'org_AiQueueOrgBBBBB1';
const REC_1: Id<'rec'> = 'rec_AiQueueRecord001';
const REC_2: Id<'rec'> = 'rec_AiQueueRecord002';
const REC_3: Id<'rec'> = 'rec_AiQueueRecord003';

/**
 * BACKLOG T910 (migration 0056): `meta.ai_generation_queue` stays inside its
 * organization (tenant isolation of `AiGenerationQueueRepository`), rows
 * merge when queued again, only the holder of a lease finishes a row (a row
 * queued again meanwhile is generated again), retries wait, pause/resume,
 * and the two cross-tenant lookups of the rescue cron and the gauge.
 */
describe('AI generation queue (T910)', () => {
  let database: TestDatabase;
  let db: Db;
  let fieldA: Id<'fld'>;
  let fieldB: Id<'fld'>;
  const queue = () => new AiGenerationQueueRepository(db);
  const scopeA = () => orgScope(ORG_A);
  const scopeB = () => orgScope(ORG_B);

  const textField = async (orgId: Id<'org'>, baseId: Id<'bse'>): Promise<Id<'fld'>> => {
    const schema = new SchemaService(db, { maxFieldsPerTable: 50 });
    const { table } = await schema.createTable(
      orgScope(orgId),
      { baseId, name: 'Tickets', primaryFieldName: 'Title' },
      systemAuditContext(),
    );
    const field = await schema.addField(
      orgScope(orgId),
      table.id,
      { name: 'Summary', type: 'text' },
      systemAuditContext(),
    );
    return field.id;
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    const a = await seedTenant(db, ORG_A);
    const b = await seedTenant(db, ORG_B);
    fieldA = await textField(ORG_A, a.baseId);
    fieldB = await textField(ORG_B, b.baseId);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('keeps rows inside their organization (tenant isolation)', async () => {
    expect(await queue().enqueue(scopeA(), fieldA, [REC_1, REC_2, REC_1])).toBe(2);
    // Another organization cannot queue rows of A's field (composite FK) …
    await expect(queue().enqueue(scopeB(), fieldA, [REC_3])).rejects.toThrow();
    // … nor see, take, pause, finish or clear A's rows.
    expect((await queue().statesOf(scopeB(), [fieldA])).get(fieldA)).toEqual({
      queued: 0,
      failed: 0,
      paused: 0,
      paused_reason: null,
    });
    expect(await queue().cellStates(scopeB(), [fieldA], [REC_1, REC_2])).toEqual([]);
    expect(await queue().take(scopeB(), fieldA, 20)).toEqual([]);
    expect(await queue().pause(scopeB(), 'quota')).toEqual([]);
    expect(await queue().dueFields(scopeB())).toEqual([]);
    expect(await queue().recordIdsOf(scopeB(), fieldA, 'queued')).toEqual([]);
    await queue().clear(scopeB(), fieldA);
    expect(await queue().recordIdsOf(scopeA(), fieldA, 'queued')).toEqual([REC_1, REC_2]);
    expect((await queue().statesOf(scopeA(), [fieldA])).get(fieldA)?.queued).toBe(2);
    await queue().enqueue(scopeB(), fieldB, [REC_3]);
    expect(await queue().recordIdsOf(scopeA(), fieldB, 'queued')).toEqual([]);
    await queue().clear(scopeA(), fieldA);
    await queue().clear(scopeB(), fieldB);
  });

  it('lets only the holder of a lease finish a row; a row queued again meanwhile stays', async () => {
    await queue().enqueue(scopeA(), fieldA, [REC_1, REC_2]);
    const taken = await queue().take(scopeA(), fieldA, 20);
    expect(taken.map((row) => [row.recordId, row.attempts])).toEqual([
      [REC_1, 1],
      [REC_2, 1],
    ]);
    // Nothing more to take while they run.
    expect(await queue().take(scopeA(), fieldA, 20)).toEqual([]);
    // A source of REC_2 changes during the call: the row is queued again.
    await queue().enqueue(scopeA(), fieldA, [REC_2]);
    await queue().finish(scopeA(), fieldA, taken);
    expect(await queue().recordIdsOf(scopeA(), fieldA, 'queued')).toEqual([REC_2]);
    expect(await queue().cellStates(scopeA(), [fieldA], [REC_1, REC_2])).toEqual([
      { field_id: fieldA, record_id: REC_2, status: 'queued' },
    ]);
    await queue().clear(scopeA(), fieldA);
  });

  it('waits before a retry, fails with a code, pauses and resumes', async () => {
    await queue().enqueue(scopeA(), fieldA, [REC_1, REC_2, REC_3]);
    const taken = await queue().take(scopeA(), fieldA, 20);
    expect(taken.map((row) => row.recordId)).toEqual([REC_1, REC_2, REC_3]);
    await queue().requeue(scopeA(), fieldA, taken.slice(0, 1), { delayMs: 60_000 });
    await queue().fail(scopeA(), fieldA, taken.slice(1, 2), 'invalid_output');
    await queue().requeue(scopeA(), fieldA, taken.slice(2), { refund: true });
    // REC_1 waits a minute; REC_3 is due now with its try given back.
    const due = await queue().take(scopeA(), fieldA, 20);
    expect(due.map((row) => [row.recordId, row.attempts])).toEqual([[REC_3, 1]]);
    await queue().requeue(scopeA(), fieldA, due);
    expect(await queue().recordIdsOf(scopeA(), fieldA, 'failed')).toEqual([REC_2]);

    expect(await queue().pause(scopeA(), 'quota')).toEqual([fieldA]);
    expect((await queue().statesOf(scopeA(), [fieldA])).get(fieldA)).toEqual({
      queued: 0,
      failed: 1,
      paused: 2,
      paused_reason: 'quota',
    });
    // Another reason does not resume them.
    expect(await queue().resume(scopeA(), ['ai_disabled'])).toEqual([]);
    expect(await queue().resume(scopeA(), ['quota'], fieldA)).toEqual([fieldA]);
    expect(await queue().recordIdsOf(scopeA(), fieldA, 'queued')).toEqual([REC_1, REC_3]);
    await queue().clear(scopeA(), fieldA);
  });

  it('gives expired leases back and lists the organizations the rescue must visit', async () => {
    await queue().enqueue(scopeA(), fieldA, [REC_1]);
    await queue().take(scopeA(), fieldA, 20, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A running row past its lease, and queued rows of B without an `ai.generate` job.
    await queue().enqueue(scopeB(), fieldB, [REC_2]);
    const listed = await listAiGenerationRescueOrganizations(db.kysely, {
      now: new Date(),
      limit: 10,
    });
    expect(listed).toEqual([ORG_A, ORG_B]);
    expect(await measureAiGenerationQueue(db)).toEqual({
      queued: 1,
      running: 1,
      failed: 0,
      paused: 0,
    });
    expect(await queue().releaseExpired(scopeB())).toEqual([]);
    expect(await queue().releaseExpired(scopeA())).toEqual([fieldA]);
    expect(await queue().recordIdsOf(scopeA(), fieldA, 'queued')).toEqual([REC_1]);
    await queue().clear(scopeA(), fieldA);
    await queue().clear(scopeB(), fieldB);
  });
});
