import { sql } from 'kysely';
import { expect } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';

import type { Db, OrgScope } from '../../src/db/index.js';
import type { SchemaService } from '../../src/schema/index.js';
import type { Id } from '@cellhive/contracts';

/** An audit context of a user action (the actor of events and audit rows). */
export function userContext(userId: Id<'usr'>): AuditContext {
  return { ...systemAuditContext(), actor: { type: 'user', id: userId } };
}

/** `information_schema` and meta of the table agree exactly (T102 acceptance). */
export async function expectConsistent(
  schema: SchemaService,
  scope: OrgScope,
  tableId: Id<'tbl'>,
): Promise<void> {
  expect(await schema.checkConsistency(scope, tableId)).toEqual([]);
}

export interface QueuedJob {
  readonly task_identifier: string;
  readonly payload: Record<string, unknown>;
  readonly queue_name: string | null;
  readonly key: string | null;
}

/** Pending graphile-worker jobs of one task. */
export async function queuedJobs(db: Db, task: string): Promise<QueuedJob[]> {
  const { rows } = await sql<QueuedJob>`
    SELECT jobs.task_identifier, payload, queue_name, jobs.key
      FROM graphile_worker.jobs JOIN graphile_worker._private_jobs USING (id)
     WHERE jobs.task_identifier = ${task}
     ORDER BY id
  `.execute(db.kysely);
  return rows;
}

/** Live column names of `data.<table>` (information_schema). */
export async function physicalColumns(db: Db, table: string): Promise<string[]> {
  const { rows } = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'data' AND table_name = ${table}
     ORDER BY ordinal_position
  `.execute(db.kysely);
  return rows.map((row) => row.column_name);
}
