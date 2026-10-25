import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigrator, migrateToLatest, type Db } from '../../src/db/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

/**
 * Foreign keys of `meta` tenant tables that do not carry `organization_id`
 * although they reference a tenant table, by constraint name. Every entry is
 * a known debt with a reason; the list must only shrink.
 */
const SINGLE_COLUMN_TENANT_FK_EXCEPTIONS: readonly string[] = [
  // 0009: `meta.views` has no `UNIQUE (organization_id, id)` yet. Debt from
  // `docs/reviews/S4b-decisions-followup.md` §2.3.4: fixed together with the
  // first S5 table referencing a view (`form.submitted`) or in S9.
  'form_submissions.form_submissions_view_fkey',
];

/**
 * `table.constraint` of every foreign key from a `meta` table with an
 * `organization_id` column to a `meta` table with one (a tenant table,
 * SPEC §5.10) whose columns do not pair `organization_id` with
 * `organization_id`. Partitions are skipped (their keys are clones of the
 * parent's).
 */
async function tenantFksWithoutOrganization<DB>(db: Kysely<DB>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    SELECT src.relname || '.' || con.conname AS name
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
      JOIN pg_class dst ON dst.oid = con.confrelid
      JOIN pg_namespace dst_ns ON dst_ns.oid = dst.relnamespace
      JOIN pg_attribute src_org
        ON src_org.attrelid = src.oid AND src_org.attname = 'organization_id'
       AND NOT src_org.attisdropped
      JOIN pg_attribute dst_org
        ON dst_org.attrelid = dst.oid AND dst_org.attname = 'organization_id'
       AND NOT dst_org.attisdropped
     WHERE con.contype = 'f'
       AND con.conparentid = 0
       AND src_ns.nspname = 'meta'
       AND dst_ns.nspname = 'meta'
       AND NOT src.relispartition
       AND NOT EXISTS (
         SELECT 1
           FROM unnest(con.conkey, con.confkey) AS pair(src_attnum, dst_attnum)
          WHERE pair.src_attnum = src_org.attnum AND pair.dst_attnum = dst_org.attnum
       )
     ORDER BY 1
  `.execute(db);
  return rows.map((row) => row.name);
}

/** Rolls back whatever `fn` did. */
async function inRolledBackTx<DB, T>(db: Kysely<DB>, fn: (tx: Kysely<DB>) => Promise<T>) {
  const rollback = new Error('rollback');
  let result: T | undefined;
  await expect(
    db.transaction().execute(async (tx) => {
      result = await fn(tx);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  return result as T;
}

describe('composite tenant foreign keys (SPEC §5.10, BACKLOG T501)', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateToLatest(db.kysely);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('every FK from a meta tenant table to a tenant table includes organization_id', async () => {
    expect(await tenantFksWithoutOrganization(db.kysely)).toEqual([
      ...SINGLE_COLUMN_TENANT_FK_EXCEPTIONS,
    ]);
  });

  it('every meta table carries organization_id, except the global tables (SPEC §5.10, T528)', async () => {
    // The FK check above only sees tables with an organization_id column: a
    // new table without one would escape it (and rule 5 of AGENTS.md).
    const { rows } = await sql<{ name: string }>`
      SELECT c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'meta'
         AND c.relkind IN ('r', 'p')
         AND NOT c.relispartition
         AND NOT EXISTS (
           SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
         )
       ORDER BY 1
    `.execute(db.kysely);
    // Exactly the closed list of GlobalRepository (SPEC §5.10).
    expect(rows.map((row) => row.name)).toEqual([
      'organizations',
      'password_resets',
      'sessions',
      'user_identities',
      'users',
    ]);
  });

  it('catches a single-column FK added to a tenant table', async () => {
    const found = await inRolledBackTx(db.kysely, async (tx) => {
      await sql`
        ALTER TABLE meta.field_conversions
          ADD CONSTRAINT field_conversions_probe_fkey FOREIGN KEY (field_id)
          REFERENCES meta.fields (id)
      `.execute(tx);
      // Composite but pairing organization_id with another column: still wrong.
      await sql`
        ALTER TABLE meta.field_dependencies
          ADD CONSTRAINT field_dependencies_probe_fkey FOREIGN KEY (field_id, organization_id)
          REFERENCES meta.fields (organization_id, id)
      `.execute(tx);
      return tenantFksWithoutOrganization(tx);
    });
    expect(found).toEqual(
      [
        ...SINGLE_COLUMN_TENANT_FK_EXCEPTIONS,
        'field_conversions.field_conversions_probe_fkey',
        'field_dependencies.field_dependencies_probe_fkey',
      ].sort(),
    );
  });

  it('puts the date reminder cursors on a composite key to meta.fields (T547, migration 0041)', async () => {
    const { rows } = await sql<{ name: string; definition: string }>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'meta.date_reminder_cursors'::regclass AND contype IN ('f', 'p')
       ORDER BY conname
    `.execute(db.kysely);
    expect(rows).toEqual([
      {
        name: 'date_reminder_cursors_field_fkey',
        definition:
          'FOREIGN KEY (organization_id, field_id) REFERENCES meta.fields(organization_id, id) ON DELETE CASCADE',
      },
      { name: 'date_reminder_cursors_pkey', definition: 'PRIMARY KEY (organization_id, field_id)' },
    ]);
  });

  it('ties the HTTP allowlist to its organization and creator member (T600, migration 0042)', async () => {
    const { rows } = await sql<{ name: string; definition: string }>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'meta.http_allowlist'::regclass AND contype IN ('f', 'u')
       ORDER BY conname
    `.execute(db.kysely);
    expect(rows).toEqual([
      {
        name: 'http_allowlist_creator_fkey',
        definition:
          'FOREIGN KEY (organization_id, created_by) REFERENCES meta.org_members(organization_id, user_id) ON DELETE SET NULL (created_by)',
      },
      {
        name: 'http_allowlist_org_fkey',
        definition:
          'FOREIGN KEY (organization_id) REFERENCES meta.organizations(id) ON DELETE CASCADE',
      },
      { name: 'http_allowlist_organization_id_id_key', definition: 'UNIQUE (organization_id, id)' },
      {
        name: 'http_allowlist_organization_id_pattern_key',
        definition: 'UNIQUE (organization_id, pattern)',
      },
    ]);
  });

  it('ties API tokens to their owner member, cascading, and their revoker (T703, migration 0049)', async () => {
    const { rows } = await sql<{ name: string; definition: string }>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'meta.api_tokens'::regclass AND contype IN ('f', 'u')
       ORDER BY conname
    `.execute(db.kysely);
    expect(rows).toEqual([
      {
        name: 'api_tokens_org_fkey',
        definition:
          'FOREIGN KEY (organization_id) REFERENCES meta.organizations(id) ON DELETE CASCADE',
      },
      { name: 'api_tokens_organization_id_id_key', definition: 'UNIQUE (organization_id, id)' },
      {
        name: 'api_tokens_owner_fkey',
        definition:
          'FOREIGN KEY (organization_id, user_id) REFERENCES meta.org_members(organization_id, user_id) ON DELETE CASCADE',
      },
      {
        name: 'api_tokens_revoked_by_fkey',
        definition:
          'FOREIGN KEY (organization_id, revoked_by) REFERENCES meta.org_members(organization_id, user_id) ON DELETE SET NULL (revoked_by)',
      },
      { name: 'api_tokens_token_hash_key', definition: 'UNIQUE (token_hash)' },
    ]);
  });

  it('ties incoming webhooks to their base and members, requests to their hook (T602, migration 0043)', async () => {
    const constraints = async (table: string) =>
      (
        await sql<{ name: string; definition: string }>`
          SELECT conname AS name, pg_get_constraintdef(oid) AS definition
            FROM pg_constraint
           WHERE conrelid = ${table}::regclass AND contype IN ('f', 'u')
           ORDER BY conname
        `.execute(db.kysely)
      ).rows;
    expect(await constraints('meta.incoming_webhooks')).toEqual([
      {
        name: 'incoming_webhooks_base_fkey',
        definition:
          'FOREIGN KEY (organization_id, base_id) REFERENCES meta.bases(organization_id, id) ON DELETE CASCADE',
      },
      {
        name: 'incoming_webhooks_creator_fkey',
        definition:
          'FOREIGN KEY (organization_id, created_by) REFERENCES meta.org_members(organization_id, user_id) ON DELETE SET NULL (created_by)',
      },
      {
        name: 'incoming_webhooks_listener_fkey',
        definition:
          'FOREIGN KEY (organization_id, listened_by) REFERENCES meta.org_members(organization_id, user_id) ON DELETE SET NULL (listened_by)',
      },
      {
        name: 'incoming_webhooks_org_fkey',
        definition:
          'FOREIGN KEY (organization_id) REFERENCES meta.organizations(id) ON DELETE CASCADE',
      },
      {
        name: 'incoming_webhooks_organization_id_id_key',
        definition: 'UNIQUE (organization_id, id)',
      },
      { name: 'incoming_webhooks_token_hash_key', definition: 'UNIQUE (token_hash)' },
    ]);
    expect(await constraints('meta.incoming_webhook_requests')).toEqual([
      {
        name: 'incoming_webhook_requests_hook_fkey',
        definition:
          'FOREIGN KEY (organization_id, incoming_webhook_id) REFERENCES meta.incoming_webhooks(organization_id, id) ON DELETE CASCADE',
      },
      {
        name: 'incoming_webhook_requests_message_key',
        definition: 'UNIQUE (organization_id, incoming_webhook_id, message_id)',
      },
      {
        name: 'incoming_webhook_requests_org_fkey',
        definition:
          'FOREIGN KEY (organization_id) REFERENCES meta.organizations(id) ON DELETE CASCADE',
      },
      {
        name: 'incoming_webhook_requests_organization_id_id_key',
        definition: 'UNIQUE (organization_id, id)',
      },
    ]);
  });

  it('ties HTTP deliveries to their organization, run, automation, requester and secrets (T605, migration 0044)', async () => {
    const { rows } = await sql<{ name: string; definition: string }>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'meta.http_deliveries'::regclass AND contype IN ('f', 'u')
       ORDER BY conname
    `.execute(db.kysely);
    expect(rows).toEqual([
      {
        name: 'http_deliveries_auth_secret_fkey',
        definition:
          'FOREIGN KEY (organization_id, auth_secret_id) REFERENCES meta.secrets(organization_id, id) ON DELETE SET NULL (auth_secret_id)',
      },
      {
        name: 'http_deliveries_automation_fkey',
        definition:
          'FOREIGN KEY (organization_id, automation_id) REFERENCES meta.automations(organization_id, id) ON DELETE CASCADE',
      },
      {
        name: 'http_deliveries_idempotency_key',
        definition: 'UNIQUE (organization_id, idempotency_key)',
      },
      {
        name: 'http_deliveries_org_fkey',
        definition:
          'FOREIGN KEY (organization_id) REFERENCES meta.organizations(id) ON DELETE CASCADE',
      },
      {
        name: 'http_deliveries_organization_id_id_key',
        definition: 'UNIQUE (organization_id, id)',
      },
      {
        name: 'http_deliveries_requester_fkey',
        definition:
          'FOREIGN KEY (organization_id, requested_by) REFERENCES meta.org_members(organization_id, user_id) ON DELETE SET NULL (requested_by)',
      },
      {
        name: 'http_deliveries_run_fkey',
        definition:
          'FOREIGN KEY (organization_id, run_id) REFERENCES meta.automation_runs(organization_id, id) ON DELETE CASCADE',
      },
      {
        name: 'http_deliveries_signing_secret_fkey',
        definition:
          'FOREIGN KEY (organization_id, signing_secret_id) REFERENCES meta.secrets(organization_id, id) ON DELETE SET NULL (signing_secret_id)',
      },
    ]);
  });

  it('ties a notification bot webhook to its organization and secret (T609, migration 0046)', async () => {
    const { rows } = await sql<{ name: string; definition: string }>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'meta.telegram_webhooks'::regclass AND contype IN ('f', 'u', 'p')
       ORDER BY conname
    `.execute(db.kysely);
    expect(rows).toEqual([
      {
        name: 'telegram_webhooks_org_fkey',
        definition:
          'FOREIGN KEY (organization_id) REFERENCES meta.organizations(id) ON DELETE CASCADE',
      },
      {
        name: 'telegram_webhooks_path_token_hash_key',
        definition: 'UNIQUE (path_token_hash)',
      },
      { name: 'telegram_webhooks_pkey', definition: 'PRIMARY KEY (organization_id)' },
      {
        name: 'telegram_webhooks_secret_fkey',
        definition:
          'FOREIGN KEY (organization_id, secret_id) REFERENCES meta.secrets(organization_id, id) ON DELETE CASCADE',
      },
    ]);
  });

  it('puts the computed tables on composite keys to meta.fields (organization_id, id)', async () => {
    const { rows } = await sql<{ name: string; definition: string }>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname IN (
         'computed_recompute_queue_field_fkey',
         'field_dependencies_field_fkey',
         'field_dependencies_depends_on_fkey',
         'fields_organization_id_id_key'
       )
       ORDER BY conname
    `.execute(db.kysely);
    expect(rows).toEqual([
      {
        name: 'computed_recompute_queue_field_fkey',
        definition:
          'FOREIGN KEY (organization_id, field_id) REFERENCES meta.fields(organization_id, id) ON DELETE CASCADE',
      },
      {
        name: 'field_dependencies_depends_on_fkey',
        definition:
          'FOREIGN KEY (organization_id, depends_on_field_id) REFERENCES meta.fields(organization_id, id) ON DELETE CASCADE',
      },
      {
        name: 'field_dependencies_field_fkey',
        definition:
          'FOREIGN KEY (organization_id, field_id) REFERENCES meta.fields(organization_id, id) ON DELETE CASCADE',
      },
      { name: 'fields_organization_id_id_key', definition: 'UNIQUE (organization_id, id)' },
    ]);
  });
});

describe('migration 0026_computed_tenant_fks on rows of the wrong organization', () => {
  let database: TestDatabase;
  let db: Db;
  let orgA: SeededTenant;
  let orgB: SeededTenant;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    const { error } = await createMigrator(db.kysely).migrateTo('0025_fx_date_text_args');
    expect(error).toBeUndefined();
    orgA = await seedTenant(db, 'org_MigrTwentySixAAA');
    orgB = await seedTenant(db, 'org_MigrTwentySixBBB');
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  /** One table with fields `fld_<prefix>1…n` (numbers) in the tenant's base. */
  async function seedFields(tenant: SeededTenant, prefix: string, count: number): Promise<void> {
    const tableId = `tbl_${prefix}Table000000`;
    await db.withTx(async (tx) => {
      await sql`
        INSERT INTO meta.tables (id, organization_id, base_id, name, db_table_name, "collation")
        VALUES (${tableId}, ${tenant.orgId}, ${tenant.baseId}, ${prefix},
                ${`t_${prefix.toLowerCase()}00000000`}, 'und-x-icu')
      `.execute(tx);
      for (let i = 1; i <= count; i += 1) {
        await sql`
          INSERT INTO meta.fields (id, organization_id, table_id, name, type, db_column_name)
          VALUES (${`fld_${prefix}Field0000${String(i)}`}, ${tenant.orgId}, ${tableId},
                  ${`F${String(i)}`}, 'number', ${`f_${prefix.toLowerCase()}0000000${String(i)}`})
        `.execute(tx);
      }
    });
  }

  it('repairs queue and dependency rows, drops cross-tenant edges, keeps pending work', async () => {
    await seedFields(orgA, 'Aaaa', 3);
    await seedFields(orgB, 'Bbbb', 1);
    const a1 = 'fld_AaaaField00001';
    const a2 = 'fld_AaaaField00002';
    const a3 = 'fld_AaaaField00003';
    const b1 = 'fld_BbbbField00001';

    // Queue: one row filed under the wrong organization, one right.
    await sql`
      INSERT INTO meta.computed_recompute_queue (organization_id, field_id, record_id, after_auto)
      VALUES (${orgB.orgId}, ${a1}, 'rec_MigrRecord000001', 0),
             (${orgA.orgId}, ${a2}, '*', 42)
    `.execute(db.kysely);
    // Dependencies: a1 → a2 filed under org B (repaired), a1 → a3 right,
    // a2 → b1 crosses tenants (deleted), b1 → a3 crosses tenants (deleted).
    await sql`
      INSERT INTO meta.field_dependencies
        (organization_id, base_id, field_id, depends_on_field_id, kind)
      VALUES (${orgB.orgId}, ${orgB.baseId}, ${a1}, ${a2}, 'same_row'),
             (${orgA.orgId}, ${orgA.baseId}, ${a1}, ${a3}, 'same_row'),
             (${orgA.orgId}, ${orgA.baseId}, ${a2}, ${b1}, 'cross_table'),
             (${orgB.orgId}, ${orgB.baseId}, ${b1}, ${a3}, 'cross_table')
    `.execute(db.kysely);

    expect(await migrateToLatest(db.kysely)).toContain('0026_computed_tenant_fks');

    const queue = await sql<{
      organization_id: string;
      field_id: string;
      record_id: string;
      after_auto: string;
    }>`
      SELECT organization_id, field_id, record_id, after_auto::text
        FROM meta.computed_recompute_queue ORDER BY field_id
    `.execute(db.kysely);
    expect(queue.rows).toEqual([
      {
        organization_id: orgA.orgId,
        field_id: a1,
        record_id: 'rec_MigrRecord000001',
        after_auto: '0',
      },
      { organization_id: orgA.orgId, field_id: a2, record_id: '*', after_auto: '42' },
    ]);
    const edges = await sql<{
      organization_id: string;
      base_id: string;
      field_id: string;
      depends_on_field_id: string;
    }>`
      SELECT organization_id, base_id, field_id, depends_on_field_id
        FROM meta.field_dependencies ORDER BY field_id, depends_on_field_id
    `.execute(db.kysely);
    expect(edges.rows).toEqual([
      { organization_id: orgA.orgId, base_id: orgA.baseId, field_id: a1, depends_on_field_id: a2 },
      { organization_id: orgA.orgId, base_id: orgA.baseId, field_id: a1, depends_on_field_id: a3 },
    ]);
  });

  it('then rejects rows of another organization than their field and still cascades', async () => {
    await expect(
      sql`
        INSERT INTO meta.computed_recompute_queue (organization_id, field_id, record_id)
        VALUES (${orgB.orgId}, 'fld_AaaaField00003', '*')
      `.execute(db.kysely),
    ).rejects.toMatchObject({ code: '23503', constraint: 'computed_recompute_queue_field_fkey' });
    await expect(
      sql`
        INSERT INTO meta.field_dependencies
          (organization_id, base_id, field_id, depends_on_field_id, kind)
        VALUES (${orgA.orgId}, ${orgA.baseId}, 'fld_AaaaField00003', 'fld_BbbbField00001', 'cross_table')
      `.execute(db.kysely),
    ).rejects.toMatchObject({ code: '23503', constraint: 'field_dependencies_depends_on_fkey' });

    await sql`DELETE FROM meta.fields WHERE id = 'fld_AaaaField00002'`.execute(db.kysely);
    const left = await sql<{ queue: string; edges: string }>`
      SELECT (SELECT count(*) FROM meta.computed_recompute_queue)::text AS queue,
             (SELECT count(*) FROM meta.field_dependencies)::text AS edges
    `.execute(db.kysely);
    expect(left.rows).toEqual([{ queue: '1', edges: '1' }]);
  });
});
