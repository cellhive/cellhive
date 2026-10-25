import { newId } from '@cellhive/contracts';
import { createMonthlyPartition, type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { maintainPartitions } from '../../src/index.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './support.js';

const ORG = 'org_PartitionJobOrg1';

describe('partitions.maintain', () => {
  let database: TestDatabase;
  let db: Db;

  async function partitions(): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`
      SELECT child.relname AS name
        FROM pg_inherits i
        JOIN pg_class child ON child.oid = i.inhrelid
        JOIN pg_class parent ON parent.oid = i.inhparent
       WHERE parent.relnamespace = 'meta'::regnamespace
         AND parent.relname IN ('events', 'audit_logs')
       ORDER BY 1
    `.execute(db.kysely);
    return rows.map((row) => row.name);
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    // Old partitions, as if the instance had been running since 2024.
    for (const month of ['2024-01-01', '2024-02-01', '2024-03-01', '2024-10-01']) {
      await createMonthlyPartition(db.kysely, 'audit_logs', month);
      await createMonthlyPartition(db.kysely, 'events', month);
    }
    await db.kysely
      .insertInto('meta.audit_logs')
      .values({
        id: newId('aud'),
        organization_id: ORG,
        actor_type: 'system',
        action: 'setup.completed',
        entity_type: 'organization',
        created_at: '2024-01-15T08:00:00Z',
      })
      .execute();
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('with AUDIT_RETENTION_DAYS=0 creates partitions but keeps every audit partition', async () => {
    const result = await maintainPartitions(db, {
      now: new Date('2025-01-20T00:00:00Z'),
      auditRetentionDays: 0,
      eventRetentionDays: 36_500,
    });
    expect(result.dropped).toEqual([]);
    expect(result.ensured).toEqual([
      'events_p202501',
      'events_p202502',
      'events_p202503',
      'audit_logs_p202501',
      'audit_logs_p202502',
      'audit_logs_p202503',
    ]);
    expect(await partitions()).toContain('audit_logs_p202401');
  });

  it('creates the next-next month partition and drops partitions past retention', async () => {
    // 2025-02-15 with 365 days of audit retention: the cutoff is 2024-02-16,
    // so only 2024-01 has fully expired. Events keep 90 days (cutoff 2024-11-17).
    const result = await maintainPartitions(db, {
      now: new Date('2025-02-15T12:00:00Z'),
      auditRetentionDays: 365,
    });
    expect(result.ensured).toContain('events_p202504');
    expect(result.ensured).toContain('audit_logs_p202504');
    expect([...result.dropped].sort()).toEqual([
      'audit_logs_p202401',
      'events_p202401',
      'events_p202402',
      'events_p202403',
      'events_p202410',
    ]);
    expect(result.kept).toEqual([]);

    const remaining = await partitions();
    expect(remaining).toEqual(
      expect.arrayContaining(['audit_logs_p202402', 'audit_logs_p202403', 'audit_logs_p202504']),
    );
    expect(remaining).not.toContain('audit_logs_p202401');
    expect(remaining).not.toContain('events_p202410');

    // Idempotent.
    const again = await maintainPartitions(db, {
      now: new Date('2025-02-15T12:00:00Z'),
      auditRetentionDays: 365,
    });
    expect(again.dropped).toEqual([]);
  });
});
