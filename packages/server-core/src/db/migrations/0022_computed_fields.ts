import { sql, type Kysely } from 'kysely';

/**
 * Migration 0022 (BACKLOG T456): computed fields — `formula` and `lookup`
 * (SPEC §5.8, §5.9, §9).
 *
 * - `meta.fields.result_type` (jsonb): the formula type of the value
 *   (`{ "kind": "number" }`, `{ "kind": "list", "element": … }`), from the
 *   typecheck; the stored column's PostgreSQL type follows from it.
 * - `meta.fields.compute_state`: `ready` | `backfilling` | `recomputing` |
 *   `error`; `compute_error` (jsonb): `null` or `{ code, refs }` (`REF`,
 *   `CIRCLE`, `TIMEOUT`; T460). `compute_mode` (migration 0003) is `stored`
 *   or `virtual`. The four are set exactly on formula/lookup fields.
 * - `meta.field_dependencies` (SPEC §5.9, §5.10): one row per computed
 *   field and field it reads (primary key `(field_id, depends_on_field_id)`),
 *   `kind` = the closest way it is reached (`same_row` < `via_link` <
 *   `cross_table`) and `paths` = every way (`[{ kind, link_path,
 *   condition_refs }]`, the dependencies of `analyze`, T452) for the
 *   incremental recompute (T458). `base_id` loads the graph of a base in
 *   one query (cycle detection); rows follow their fields
 *   (`ON DELETE CASCADE`), soft-deleted fields keep theirs (`#REF`, T460).
 *
 * Addition to SPEC §5.10 (reported in T456). Self-contained: no function or
 * table of a later migration is used, so its number can change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  'ALTER TABLE meta.fields ADD COLUMN result_type jsonb',
  'ALTER TABLE meta.fields ADD COLUMN compute_state text',
  'ALTER TABLE meta.fields ADD COLUMN compute_error jsonb',
  `ALTER TABLE meta.fields ADD CONSTRAINT fields_compute_state_check
     CHECK (compute_state IN ('ready', 'backfilling', 'recomputing', 'error'))`,
  `ALTER TABLE meta.fields ADD CONSTRAINT fields_computed_check CHECK (
     CASE WHEN type IN ('formula', 'lookup')
       THEN compute_mode IS NOT NULL AND compute_state IS NOT NULL AND result_type IS NOT NULL
       ELSE compute_mode IS NULL AND compute_state IS NULL AND result_type IS NULL
            AND compute_error IS NULL
     END
   )`,
  `CREATE TABLE meta.field_dependencies (
     organization_id text NOT NULL,
     base_id text NOT NULL,
     field_id text NOT NULL,
     depends_on_field_id text NOT NULL,
     kind text NOT NULL,
     paths jsonb NOT NULL DEFAULT '[]'::jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT field_dependencies_pkey PRIMARY KEY (field_id, depends_on_field_id),
     CONSTRAINT field_dependencies_field_fkey FOREIGN KEY (field_id)
       REFERENCES meta.fields (id) ON DELETE CASCADE,
     CONSTRAINT field_dependencies_depends_on_fkey FOREIGN KEY (depends_on_field_id)
       REFERENCES meta.fields (id) ON DELETE CASCADE,
     CONSTRAINT field_dependencies_kind_check
       CHECK (kind IN ('same_row', 'via_link', 'cross_table')),
     CONSTRAINT field_dependencies_paths_check CHECK (jsonb_typeof(paths) = 'array')
   )`,
  `CREATE INDEX field_dependencies_base_idx
     ON meta.field_dependencies (organization_id, base_id)`,
  `CREATE INDEX field_dependencies_depends_on_idx
     ON meta.field_dependencies (organization_id, depends_on_field_id)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
