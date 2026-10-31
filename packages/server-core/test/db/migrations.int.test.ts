import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  GLOBAL_TABLES,
  GlobalRepository,
  JOB_STATEMENT_TIMEOUT_MS,
  migrateToLatest,
  MIGRATION_TABLE,
  TENANT_TABLES,
  TenantRepository,
  type Db,
  type GlobalTableName,
  type TenantTableName,
} from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';

class AnyGlobalRepository extends GlobalRepository<GlobalTableName> {
  constructor(table: GlobalTableName, db: Db) {
    super(db, table);
  }
}

class AnyTenantRepository extends TenantRepository<TenantTableName> {
  constructor(table: TenantTableName, db: Db) {
    super(db, table);
  }
}

/** `YYYYMM` of the UTC month `offset` months from now. */
function monthSuffix(offset: number): string {
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `${String(month.getUTCFullYear())}${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
}

describe('meta migrations on an empty PostgreSQL 18 database', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('applies every migration as a non-superuser owner, and a second run is a no-op', async () => {
    expect(await migrateToLatest(db.kysely)).toEqual([
      '0001_initial',
      '0002_partition_retention',
      '0003_tables_fields',
      '0004_audit_log_indexes',
      '0005_idempotency_claim_id',
      '0006_password_reset_source',
      '0007_views',
      '0008_share_links',
      '0009_form_submissions',
      '0010_imports',
      '0011_link_fields',
      '0012_attachments',
      '0013_field_conversions',
      '0014_parent_fields',
      '0015_link_conversions',
      '0016_attachment_thumbnails',
      '0017_attachment_record_purges',
      '0018_form_uploads',
      '0019_form_covers',
      '0020_table_purges',
      '0021_fx_functions',
      '0022_computed_fields',
      '0023_fx_text_contain',
      '0024_computed_recompute_queue',
      '0025_fx_date_text_args',
      '0026_computed_tenant_fks',
      '0027_automations',
      '0028_notifications',
      '0029_email_identities',
      '0030_computed_recompute_causation',
      '0031_automation_run_timing',
      '0032_automation_run_reruns',
      '0033_automation_time_triggers',
      '0034_button_fields',
      '0035_email_assets',
      '0036_secrets',
      '0037_events_entity_index',
      '0038_notification_buffer',
      '0039_record_follows',
      '0040_user_channels',
      '0041_date_reminder_cursors',
      '0042_http_allowlist',
      '0043_incoming_webhooks',
      '0044_http_deliveries',
      '0045_webhook_actor_type',
      '0046_telegram_webhooks',
      '0047_secrets_http_kinds',
      '0048_automation_runs_event_index',
      '0049_api_tokens',
      '0050_user_identities_details',
      '0051_secrets_allowed_hosts',
      '0052_audit_logs_actor_action_idx',
      '0053_dashboards',
      '0054_ai_settings',
      '0055_canonical_time_zones',
      '0056_ai_generation_queue',
    ]);
    expect(await migrateToLatest(db.kysely)).toEqual([]);

    const { rows } = await sql<{ name: string }>`
      SELECT name FROM ${sql.table(MIGRATION_TABLE)} ORDER BY name
    `.execute(db.kysely);
    expect(rows.map((row) => row.name)).toEqual([
      '0001_initial',
      '0002_partition_retention',
      '0003_tables_fields',
      '0004_audit_log_indexes',
      '0005_idempotency_claim_id',
      '0006_password_reset_source',
      '0007_views',
      '0008_share_links',
      '0009_form_submissions',
      '0010_imports',
      '0011_link_fields',
      '0012_attachments',
      '0013_field_conversions',
      '0014_parent_fields',
      '0015_link_conversions',
      '0016_attachment_thumbnails',
      '0017_attachment_record_purges',
      '0018_form_uploads',
      '0019_form_covers',
      '0020_table_purges',
      '0021_fx_functions',
      '0022_computed_fields',
      '0023_fx_text_contain',
      '0024_computed_recompute_queue',
      '0025_fx_date_text_args',
      '0026_computed_tenant_fks',
      '0027_automations',
      '0028_notifications',
      '0029_email_identities',
      '0030_computed_recompute_causation',
      '0031_automation_run_timing',
      '0032_automation_run_reruns',
      '0033_automation_time_triggers',
      '0034_button_fields',
      '0035_email_assets',
      '0036_secrets',
      '0037_events_entity_index',
      '0038_notification_buffer',
      '0039_record_follows',
      '0040_user_channels',
      '0041_date_reminder_cursors',
      '0042_http_allowlist',
      '0043_incoming_webhooks',
      '0044_http_deliveries',
      '0045_webhook_actor_type',
      '0046_telegram_webhooks',
      '0047_secrets_http_kinds',
      '0048_automation_runs_event_index',
      '0049_api_tokens',
      '0050_user_identities_details',
      '0051_secrets_allowed_hosts',
      '0052_audit_logs_actor_action_idx',
      '0053_dashboards',
      '0054_ai_settings',
      '0055_canonical_time_zones',
      '0056_ai_generation_queue',
    ]);
  });

  it('creates the extensions and the meta, data and fx schemas', async () => {
    const extensions = await sql<{ extname: string }>`
      SELECT extname FROM pg_extension ORDER BY extname
    `.execute(db.kysely);
    expect(extensions.rows.map((row) => row.extname)).toEqual(
      expect.arrayContaining(['citext', 'pg_trgm', 'pgcrypto', 'unaccent']),
    );
    const schemas = await sql<{ nspname: string }>`
      SELECT nspname FROM pg_namespace WHERE nspname IN ('meta', 'data', 'fx') ORDER BY nspname
    `.execute(db.kysely);
    expect(schemas.rows.map((row) => row.nspname)).toEqual(['data', 'fx', 'meta']);
  });

  it('meta.f_unaccent strips Vietnamese diacritics and is IMMUTABLE', async () => {
    const { rows } = await sql<{ plain: string; volatility: string }>`
      SELECT meta.f_unaccent('Nguyễn Văn Ánh') AS plain,
             (SELECT provolatile FROM pg_proc WHERE oid = 'meta.f_unaccent(text)'::regprocedure) AS volatility
    `.execute(db.kysely);
    expect(rows[0]).toEqual({ plain: 'Nguyen Van Anh', volatility: 'i' });
    // Usable in an index expression.
    await db.withTx(async (tx) => {
      await sql`CREATE TEMP TABLE unaccent_probe (name text)`.execute(tx);
      await sql`CREATE INDEX ON unaccent_probe (meta.f_unaccent(name))`.execute(tx);
    });
  });

  describe('tenant and global tables', () => {
    let tables: { name: string; hasOrganizationId: boolean }[];

    beforeAll(async () => {
      // Regular and partitioned tables of `meta`, without partitions.
      const { rows } = await sql<{ name: string; has_organization_id: boolean }>`
        SELECT c.relname AS name,
               EXISTS (
                 SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
               ) AS has_organization_id
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'meta' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
         ORDER BY c.relname
      `.execute(db.kysely);
      tables = rows.map((row) => ({ name: row.name, hasOrganizationId: row.has_organization_id }));
    });

    it('has exactly the tables of the registry (global + tenant)', () => {
      expect(tables.map((table) => table.name)).toEqual(
        [...GLOBAL_TABLES, ...TENANT_TABLES].sort(),
      );
    });

    it('gives every table outside the global list an organization_id column', () => {
      const global = new Set<string>(GLOBAL_TABLES);
      const missing = tables.filter((table) => !global.has(table.name) && !table.hasOrganizationId);
      expect(missing).toEqual([]);
    });

    it('keeps global tables free of organization_id', () => {
      const global = new Set<string>(GLOBAL_TABLES);
      expect(tables.filter((table) => global.has(table.name) && table.hasOrganizationId)).toEqual(
        [],
      );
    });

    it('GlobalRepository accepts exactly the global tables', () => {
      const accepted = tables
        .map((table) => table.name)
        .filter((name) => {
          try {
            new AnyGlobalRepository(name as GlobalTableName, db);
            return true;
          } catch {
            return false;
          }
        });
      expect(accepted).toEqual([...GLOBAL_TABLES].sort());
    });

    it('TenantRepository accepts exactly the other tables', () => {
      const accepted = tables
        .map((table) => table.name)
        .filter((name) => {
          try {
            new AnyTenantRepository(name as TenantTableName, db);
            return true;
          } catch {
            return false;
          }
        });
      expect(accepted).toEqual([...TENANT_TABLES].sort());
    });
  });

  it('partitions events and audit_logs by month with PK (id, created_at)', async () => {
    const partitions = await sql<{ parent: string; child: string }>`
      SELECT parent.relname AS parent, child.relname AS child
        FROM pg_inherits i
        JOIN pg_class parent ON parent.oid = i.inhparent
        JOIN pg_class child ON child.oid = i.inhrelid
        JOIN pg_namespace n ON n.oid = parent.relnamespace
       WHERE n.nspname = 'meta' AND child.relkind = 'r'
       ORDER BY 1, 2
    `.execute(db.kysely);
    const current = monthSuffix(0);
    const next = monthSuffix(1);
    expect(partitions.rows).toEqual([
      { parent: 'audit_logs', child: `audit_logs_p${current}` },
      { parent: 'audit_logs', child: `audit_logs_p${next}` },
      { parent: 'events', child: `events_p${current}` },
      { parent: 'events', child: `events_p${next}` },
    ]);

    const keys = await sql<{ table: string; columns: string[] }>`
      SELECT c.relname AS table, array_agg(a.attname ORDER BY k.ord)::text[] AS columns
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
       WHERE n.nspname = 'meta' AND con.contype = 'p' AND c.relname IN ('events', 'audit_logs')
       GROUP BY c.relname
       ORDER BY 1
    `.execute(db.kysely);
    expect(keys.rows).toEqual([
      { table: 'audit_logs', columns: ['id', 'created_at'] },
      { table: 'events', columns: ['id', 'created_at'] },
    ]);

    // Idempotent: asking again for an existing month changes nothing.
    await sql`SELECT meta.create_monthly_partition('events', current_date)`.execute(db.kysely);
    await expect(
      sql`SELECT meta.create_monthly_partition('users', current_date)`.execute(db.kysely),
    ).rejects.toThrow(/unsupported table/);
  });

  it('creates the audit_logs indexes (ADR-23; 0004: organization/base lists; 0052: actor/action)', async () => {
    const { rows } = await sql<{ indexname: string; indexdef: string }>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'meta' AND tablename = 'audit_logs' AND indexname <> 'audit_logs_pkey'
       ORDER BY indexname
    `.execute(db.kysely);
    expect(rows.map((row) => row.indexdef.replace(/^.* USING btree /, ''))).toEqual([
      '(organization_id, action, created_at DESC, id DESC)',
      '(organization_id, actor_id, created_at DESC, id DESC)',
      '(organization_id, base_id, created_at DESC, id DESC) WHERE (base_id IS NOT NULL)',
      '(organization_id, batch_id) WHERE (batch_id IS NOT NULL)',
      '(organization_id, entity_type, entity_id, created_at DESC)',
      '(organization_id, created_at DESC, id DESC)',
      '(organization_id, table_id, created_at DESC)',
    ]);
  });

  it('refreshes updated_at on UPDATE', async () => {
    await sql`
      INSERT INTO meta.organizations (id, name, slug, created_at, updated_at)
      VALUES ('org_UpdatedAtProbe01', 'Probe', 'probe', now() - interval '1 day', now() - interval '1 day')
    `.execute(db.kysely);
    const updated = await db.kysely
      .updateTable('meta.organizations')
      .set({ name: 'Probe 2' })
      .where('id', '=', 'org_UpdatedAtProbe01')
      .returning(['created_at', 'updated_at'])
      .executeTakeFirstOrThrow();
    expect(updated.updated_at.getTime()).toBeGreaterThan(updated.created_at.getTime());
  });

  describe('connections', () => {
    it('run in UTC with the configured type parsers', async () => {
      const { rows } = await sql<{
        tz: string;
        day: unknown;
        days: unknown;
        big: unknown;
        bigs: unknown;
        exact: unknown;
        ts: unknown;
      }>`
        SELECT current_setting('TimeZone') AS tz,
               date '2026-01-31' AS day,
               ARRAY[date '2026-01-31', NULL] AS days,
               9007199254740993::int8 AS big,
               ARRAY[1, NULL, 9007199254740993]::int8[] AS bigs,
               1.10::numeric AS exact,
               timestamptz '2026-09-20 03:15:00+00' AS ts
      `.execute(db.kysely);
      expect(rows[0]).toEqual({
        tz: 'UTC',
        day: '2026-01-31',
        days: ['2026-01-31', null],
        big: 9007199254740993n,
        bigs: [1n, null, 9007199254740993n],
        exact: '1.10',
        ts: new Date('2026-09-20T03:15:00.000Z'),
      });
    });

    it('default to the 10 s request statement_timeout outside transactions', async () => {
      const { rows } = await sql<{
        timeout: string;
      }>`SELECT current_setting('statement_timeout') AS timeout`.execute(db.kysely);
      expect(rows[0]?.timeout).toBe('10s');
    });

    it('withTx sets statement_timeout for the transaction only', async () => {
      const inside = await db.withTx(async (tx) => {
        const { rows } = await sql<{
          timeout: string;
        }>`SELECT current_setting('statement_timeout') AS timeout`.execute(tx);
        return rows[0]?.timeout;
      });
      expect(inside).toBe('10s');
      const job = await db.withTx(
        async (tx) => {
          const { rows } = await sql<{
            timeout: string;
          }>`SELECT current_setting('statement_timeout') AS timeout`.execute(tx);
          return rows[0]?.timeout;
        },
        { timeoutMs: JOB_STATEMENT_TIMEOUT_MS },
      );
      expect(job).toBe('1min');
      const after = await sql<{
        timeout: string;
      }>`SELECT current_setting('statement_timeout') AS timeout`.execute(db.kysely);
      expect(after.rows[0]?.timeout).toBe('10s');
    });

    it('withTx turns a statement timeout into 504 QUERY_TIMEOUT', async () => {
      const error: unknown = await db
        .withTx(
          async (tx) => {
            await sql`SELECT pg_sleep(2)`.execute(tx);
          },
          { timeoutMs: 100 },
        )
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'QUERY_TIMEOUT', status: 504 });
    });

    it('withTx rolls back when the callback throws', async () => {
      await expect(
        db.withTx(async (tx) => {
          await tx
            .insertInto('meta.organizations')
            .values({ id: 'org_RolledBack000001', name: 'x', slug: 'rolled-back' })
            .execute();
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      const row = await db.kysely
        .selectFrom('meta.organizations')
        .select('id')
        .where('id', '=', 'org_RolledBack000001')
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });
  });
});
