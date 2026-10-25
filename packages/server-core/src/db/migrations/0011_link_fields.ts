import { sql, type Kysely } from 'kysely';

/**
 * Migration 0011 (BACKLOG T401): where a `link` field keeps its values.
 *
 * A link field has no column in its table: its values are the rows of the
 * junction `data.l_<shortId>` (SPEC §5.6), created by `SchemaService` with
 * the field. The two fields of a two-way link share one junction and read
 * it from opposite sides.
 *
 * - `meta.fields.link_junction`: the junction's table name (`l_<12 base36>`).
 * - `meta.fields.link_side`: `a` for the field whose table is `a_id` (the
 *   field that created the junction), `b` for the reverse field (`b_id`).
 * - Both are set exactly on `link` fields, and at most one field per side
 *   of a junction exists (trash included).
 *
 * Addition to SPEC §5.10 (reported in T401). Self-contained: no function or
 * table of a later migration is used, so its number can change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `ALTER TABLE meta.fields
     ADD COLUMN link_junction text,
     ADD COLUMN link_side text`,
  `ALTER TABLE meta.fields
     ADD CONSTRAINT fields_link_junction_check CHECK (link_junction ~ '^l_[0-9a-z]{12}$'),
     ADD CONSTRAINT fields_link_side_check CHECK (link_side IN ('a', 'b')),
     ADD CONSTRAINT fields_link_state_check CHECK (
       (type = 'link') = (link_junction IS NOT NULL AND link_side IS NOT NULL)
       AND (link_junction IS NULL) = (link_side IS NULL)
     )`,
  `CREATE UNIQUE INDEX fields_link_junction_side_key
     ON meta.fields (link_junction, link_side) WHERE link_junction IS NOT NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
