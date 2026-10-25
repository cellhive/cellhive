import { sql, type Kysely } from 'kysely';

/**
 * Migration 0026 (BACKLOG T501, `docs/reviews/S4b-decisions-followup.md`
 * §2.3): the two computed tables reference their fields with a composite
 * foreign key `(organization_id, …)`, like every other tenant child table
 * (SPEC §5.10), instead of the single-column `→ meta.fields (id)` of 0022
 * and 0024.
 *
 * - `meta.fields` gains `UNIQUE (organization_id, id)` (it only had
 *   `(organization_id, table_id, id)`; neither computed table has a
 *   `table_id`).
 * - Rows whose organization disagrees with their field's are repaired first
 *   (impossible since T471 filters by organization in the repositories, but
 *   the migration must run on such data without losing pending work):
 *   a queue row takes its field's organization (the field decides the table,
 *   so a foreign record id is a no-op when recomputed); a dependency takes
 *   the organization and base of its computed field (`field_id`), then an
 *   edge whose `depends_on_field_id` belongs to another organization is
 *   deleted (a cross-tenant edge is meaningless; the field is checked again
 *   at its next save/backfill).
 * - `computed_recompute_queue_field_fkey`, `field_dependencies_field_fkey`
 *   and `field_dependencies_depends_on_fkey` are replaced by composite
 *   foreign keys of the same names, still `ON DELETE CASCADE`. Primary keys
 *   are unchanged. The cascades use `computed_recompute_queue_org_idx`,
 *   `field_dependencies_depends_on_idx` and `field_dependencies_pkey`.
 *
 * Static DDL on `meta.*` only (no `data.*`), run in the migrator's single
 * transaction before api/worker take traffic (SPEC §20). Self-contained.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `ALTER TABLE meta.fields
     ADD CONSTRAINT fields_organization_id_id_key UNIQUE (organization_id, id)`,

  // Repair rows of another organization than their field (see above).
  `UPDATE meta.computed_recompute_queue q
      SET organization_id = f.organization_id
     FROM meta.fields f
    WHERE f.id = q.field_id AND q.organization_id <> f.organization_id`,
  `UPDATE meta.field_dependencies d
      SET organization_id = f.organization_id, base_id = t.base_id
     FROM meta.fields f
     JOIN meta.tables t ON t.organization_id = f.organization_id AND t.id = f.table_id
    WHERE f.id = d.field_id AND d.organization_id <> f.organization_id`,
  `DELETE FROM meta.field_dependencies d
    USING meta.fields f
    WHERE f.id = d.depends_on_field_id AND d.organization_id <> f.organization_id`,

  `ALTER TABLE meta.computed_recompute_queue
     DROP CONSTRAINT computed_recompute_queue_field_fkey,
     ADD CONSTRAINT computed_recompute_queue_field_fkey FOREIGN KEY (organization_id, field_id)
       REFERENCES meta.fields (organization_id, id) ON DELETE CASCADE`,
  `ALTER TABLE meta.field_dependencies
     DROP CONSTRAINT field_dependencies_field_fkey,
     DROP CONSTRAINT field_dependencies_depends_on_fkey,
     ADD CONSTRAINT field_dependencies_field_fkey FOREIGN KEY (organization_id, field_id)
       REFERENCES meta.fields (organization_id, id) ON DELETE CASCADE,
     ADD CONSTRAINT field_dependencies_depends_on_fkey
       FOREIGN KEY (organization_id, depends_on_field_id)
       REFERENCES meta.fields (organization_id, id) ON DELETE CASCADE`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
