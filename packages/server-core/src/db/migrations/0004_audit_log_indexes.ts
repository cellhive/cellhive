import { sql, type Kysely } from 'kysely';

/**
 * Migration 0004 (BACKLOG T111): indexes for the audit log admin API
 * (CONTRACTS §11.4), which pages through an organization's or a base's
 * entries newest first with a keyset cursor on `(created_at, id)`.
 *
 * - `audit_logs_org_created_idx`: the organization list and export without
 *   a narrower filter;
 * - `audit_logs_base_idx`: the base list (`GET /bases/:id/audit-logs`) and
 *   the organization list filtered by `base_id`.
 *
 * Record history keeps using `audit_logs_entity_idx` (0001) and batch sizes
 * `audit_logs_batch_idx` (0001). Indexes on the partitioned parent are
 * created on every partition, including future ones.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE INDEX audit_logs_org_created_idx
     ON meta.audit_logs (organization_id, created_at DESC, id DESC)`,
  `CREATE INDEX audit_logs_base_idx
     ON meta.audit_logs (organization_id, base_id, created_at DESC, id DESC)
     WHERE base_id IS NOT NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
