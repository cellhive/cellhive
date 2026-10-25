import { sql, type Kysely } from 'kysely';

/**
 * Migration 0003 (BACKLOG T102): `meta.tables` and `meta.fields`
 * (SPEC §5.10), the metadata of the physical `data.t_<shortId>` tables that
 * `SchemaService` creates.
 *
 * Additions to SPEC §5.10 (reported in T102):
 * - `meta.tables.collation`: collation of every text column of the table,
 *   copied from the base (`settings.collation`) when the table is created, so
 *   all text columns of one table share it (the filter compiler relies on it).
 * - `meta.tables.schema_state`: `ready | compacting` (ADR-20); DDL on a table
 *   being compacted is refused with `409 SCHEMA_LOCKED`.
 * - `meta.fields.deleted_column_name`: physical name of a soft-deleted
 *   field's column (`f_<id>__deleted_<epoch>`); `db_column_name` keeps the
 *   canonical `f_<id>` so a restore renames it back.
 * - `meta.fields.purged_at`: the deleted field's column no longer exists
 *   (dropped by compaction); it cannot be restored any more.
 * - Names are unique per base (tables) and per table (fields) among rows
 *   outside the trash (`NAME_CONFLICT`).
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const FIELD_TYPES = `('text', 'number', 'select', 'datetime', 'checkbox', 'user', 'created_at',
  'updated_at', 'created_by', 'updated_by', 'auto_number', 'link', 'parent', 'lookup', 'formula',
  'attachment')`;

const STATEMENTS = [
  `CREATE TABLE meta.tables (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     base_id text NOT NULL,
     name text NOT NULL,
     description text,
     db_table_name text NOT NULL,
     "collation" text NOT NULL,
     primary_field_id text,
     data_version bigint NOT NULL DEFAULT 0,
     schema_state text NOT NULL DEFAULT 'ready',
     compacted_at timestamptz,
     position integer NOT NULL DEFAULT 0,
     deleted_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT tables_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT tables_db_table_name_key UNIQUE (db_table_name),
     CONSTRAINT tables_base_fkey FOREIGN KEY (organization_id, base_id)
       REFERENCES meta.bases (organization_id, id) ON DELETE RESTRICT,
     CONSTRAINT tables_db_table_name_check CHECK (db_table_name ~ '^t_[0-9a-z]{12}$'),
     CONSTRAINT tables_schema_state_check CHECK (schema_state IN ('ready', 'compacting')),
     CONSTRAINT tables_data_version_check CHECK (data_version >= 0)
   )`,
  `CREATE UNIQUE INDEX tables_base_name_key
     ON meta.tables (base_id, name) WHERE deleted_at IS NULL`,
  'CREATE INDEX tables_base_idx ON meta.tables (organization_id, base_id, position)',
  `CREATE TABLE meta.fields (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     table_id text NOT NULL,
     name text NOT NULL,
     type text NOT NULL,
     db_column_name text,
     compute_mode text,
     options jsonb NOT NULL DEFAULT '{}'::jsonb,
     is_primary boolean NOT NULL DEFAULT false,
     required boolean NOT NULL DEFAULT false,
     unique_values boolean NOT NULL DEFAULT false,
     description text,
     position integer NOT NULL DEFAULT 0,
     deleted_at timestamptz,
     deleted_column_name text,
     purged_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT fields_scope_key UNIQUE (organization_id, table_id, id),
     CONSTRAINT fields_table_db_column_name_key UNIQUE (table_id, db_column_name),
     CONSTRAINT fields_table_fkey FOREIGN KEY (organization_id, table_id)
       REFERENCES meta.tables (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT fields_type_check CHECK (type IN ${FIELD_TYPES}),
     CONSTRAINT fields_compute_mode_check CHECK (compute_mode IN ('stored', 'virtual')),
     CONSTRAINT fields_db_column_name_check CHECK (db_column_name ~ '^f_[0-9a-z]{12}$'),
     CONSTRAINT fields_deleted_column_name_check
       CHECK (deleted_column_name ~ '^f_[0-9a-z]{12}__deleted_[0-9]{1,12}$'),
     CONSTRAINT fields_deleted_state_check CHECK (
       (deleted_at IS NULL AND deleted_column_name IS NULL AND purged_at IS NULL)
       OR deleted_at IS NOT NULL
     ),
     CONSTRAINT fields_primary_not_deleted_check CHECK (NOT (is_primary AND deleted_at IS NOT NULL))
   )`,
  `CREATE UNIQUE INDEX fields_table_name_key
     ON meta.fields (table_id, name) WHERE deleted_at IS NULL`,
  'CREATE UNIQUE INDEX fields_table_primary_key ON meta.fields (table_id) WHERE is_primary',
  'CREATE INDEX fields_table_idx ON meta.fields (organization_id, table_id, position)',
  // The primary field belongs to the same table and organization. Deferred:
  // the table row is inserted before its primary field.
  `ALTER TABLE meta.tables
     ADD CONSTRAINT tables_primary_field_fkey
     FOREIGN KEY (organization_id, id, primary_field_id)
     REFERENCES meta.fields (organization_id, table_id, id)
     DEFERRABLE INITIALLY DEFERRED`,
  `CREATE TRIGGER tables_set_updated_at BEFORE UPDATE ON meta.tables
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
  `CREATE TRIGGER fields_set_updated_at BEFORE UPDATE ON meta.fields
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
