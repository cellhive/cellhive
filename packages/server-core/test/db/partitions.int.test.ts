import { newId } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createMonthlyPartition,
  dropMonthlyPartitionsBefore,
  migrateToLatest,
  type Db,
  type PartitionedTable,
} from '../../src/db/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';

const ORG = 'org_PartitionOrg0001';

describe('meta.drop_monthly_partitions_before', () => {
  let database: TestDatabase;
  let db: Db;

  async function partitions(table: PartitionedTable): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`
      SELECT child.relname AS name
        FROM pg_inherits i
        JOIN pg_class child ON child.oid = i.inhrelid
        JOIN pg_class parent ON parent.oid = i.inhparent
        JOIN pg_namespace n ON n.oid = parent.relnamespace
       WHERE n.nspname = 'meta' AND parent.relname = ${table}
       ORDER BY 1
    `.execute(db.kysely);
    return rows.map((row) => row.name);
  }

  async function insertEvent(createdAt: string, dispatched: boolean): Promise<void> {
    await db.kysely
      .insertInto('meta.events')
      .values({
        id: newId('evt'),
        organization_id: ORG,
        type: 'record.created',
        entity_type: 'record',
        entity_id: 'rec_PartitionRec0001',
        actor_type: 'system',
        created_at: createdAt,
        dispatched_at: dispatched ? createdAt : null,
      })
      .execute();
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateToLatest(db.kysely);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('drops audit partitions whose whole month ends before the cutoff', async () => {
    for (const month of ['2024-01-01', '2024-02-01', '2024-03-01']) {
      await createMonthlyPartition(db.kysely, 'audit_logs', month);
    }
    await db.kysely
      .insertInto('meta.audit_logs')
      .values({
        id: newId('aud'),
        organization_id: ORG,
        actor_type: 'system',
        action: 'setup.completed',
        entity_type: 'organization',
        created_at: '2024-02-10T00:00:00Z',
      })
      .execute();

    // 2024-02 ends on 2024-03-01T00:00Z: dropped exactly at that cutoff, not a
    // millisecond before. A non-UTC session must not shift the boundaries.
    const dropInNewYork = (cutoff: string) =>
      db.withTx(async (tx) => {
        await sql`SET LOCAL timezone = 'America/New_York'`.execute(tx);
        return dropMonthlyPartitionsBefore(tx, 'audit_logs', new Date(cutoff));
      });
    expect(await dropInNewYork('2024-02-29T23:59:59.999Z')).toEqual([
      { partition: 'audit_logs_p202401', dropped: true },
    ]);
    expect(await dropInNewYork('2024-03-01T00:00:00.000Z')).toEqual([
      { partition: 'audit_logs_p202402', dropped: true },
    ]);

    const remaining = await partitions('audit_logs');
    expect(remaining).toContain('audit_logs_p202403');
    expect(remaining).not.toContain('audit_logs_p202402');
    const { rows } = await sql<{ n: bigint }>`SELECT count(*) AS n FROM meta.audit_logs`.execute(
      db.kysely,
    );
    expect(rows[0]?.n).toBe(0n);
  });

  it('keeps an events partition that still has events not dispatched', async () => {
    await createMonthlyPartition(db.kysely, 'events', '2024-05-01');
    await createMonthlyPartition(db.kysely, 'events', '2024-06-01');
    await insertEvent('2024-05-03T10:00:00Z', true);
    await insertEvent('2024-06-03T10:00:00Z', false);

    expect(
      await dropMonthlyPartitionsBefore(db.kysely, 'events', new Date('2024-08-01T00:00:00Z')),
    ).toEqual([
      { partition: 'events_p202405', dropped: true },
      { partition: 'events_p202406', dropped: false },
    ]);
    expect(await partitions('events')).toContain('events_p202406');
  });

  it('rejects other tables', async () => {
    await expect(
      sql`SELECT * FROM meta.drop_monthly_partitions_before('bases', now())`.execute(db.kysely),
    ).rejects.toThrow(/unsupported table bases/);
  });
});
