import { randomInt } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

/**
 * Migration 0007 (BACKLOG T301): `meta.views` (SPEC §5.10, §8) and a
 * default grid view for every existing table (trash included).
 *
 * Additions to SPEC §5.10 (reported in T301):
 * - `meta.views.locked`: a locked shared view keeps its config until someone
 *   with schema rights on the table unlocks it (BACKLOG S3 decision 4);
 * - names are unique, case-insensitively, among the shared views of a table
 *   and among the personal views of one owner on a table (`NAME_CONFLICT`);
 * - a personal view has an owner, a shared view has none and is never
 *   locked by a personal owner (CHECK).
 *
 * The default view has the config every new view starts from; its id is
 * drawn with a CSPRNG like application ids (CONTRACTS §1.2), so the
 * migration does not depend on application code that may change later.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.views (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     table_id text NOT NULL,
     type text NOT NULL,
     name text NOT NULL,
     config jsonb NOT NULL DEFAULT '{}'::jsonb,
     position integer NOT NULL DEFAULT 0,
     is_personal boolean NOT NULL DEFAULT false,
     owner_id text,
     locked boolean NOT NULL DEFAULT false,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT views_table_fkey FOREIGN KEY (organization_id, table_id)
       REFERENCES meta.tables (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT views_owner_fkey FOREIGN KEY (owner_id)
       REFERENCES meta.users (id) ON DELETE CASCADE,
     CONSTRAINT views_type_check CHECK (type IN ('grid', 'kanban', 'form')),
     CONSTRAINT views_personal_check CHECK (
       (is_personal AND owner_id IS NOT NULL AND NOT locked)
       OR (NOT is_personal AND owner_id IS NULL)
     ),
     CONSTRAINT views_position_check CHECK (position >= 0)
   )`,
  `CREATE UNIQUE INDEX views_shared_name_key
     ON meta.views (table_id, lower(name)) WHERE NOT is_personal`,
  `CREATE UNIQUE INDEX views_personal_name_key
     ON meta.views (table_id, owner_id, lower(name)) WHERE is_personal`,
  'CREATE INDEX views_table_idx ON meta.views (organization_id, table_id, position)',
  `CREATE TRIGGER views_set_updated_at BEFORE UPDATE ON meta.views
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
];

/** Config of the default grid view (every key of `StoredViewConfig` at its default). */
const DEFAULT_GRID_CONFIG = {
  filter: null,
  sort: [],
  group: [],
  hidden_fields: [],
  field_order: [],
  column_widths: {},
  frozen_count: 1,
  row_height: 'short',
  tree: { enabled: false, show_ancestors: true },
};

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** `viw_` + 16 base62 characters from a CSPRNG (`randomInt` is unbiased). */
function viewId(): string {
  let id = 'viw_';
  for (let index = 0; index < 16; index += 1) id += BASE62.charAt(randomInt(BASE62.length));
  return id;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
  const { rows } = await sql<{ id: string; organization_id: string }>`
    SELECT id, organization_id FROM meta.tables ORDER BY id
  `.execute(db);
  for (const table of rows) {
    await sql`
      INSERT INTO meta.views (id, organization_id, table_id, type, name, config, position)
      VALUES (${viewId()}, ${table.organization_id}, ${table.id}, 'grid', 'Grid view',
              ${JSON.stringify(DEFAULT_GRID_CONFIG)}::jsonb, 0)
    `.execute(db);
  }
}
