import { sql, type Kysely } from 'kysely';

/**
 * Migration 0002 (BACKLOG T010): retention for the monthly partitions of
 * `meta.events` and `meta.audit_logs` created by
 * `meta.create_monthly_partition` (0001).
 *
 * `meta.drop_monthly_partitions_before(table, cutoff)` drops every partition
 * `<table>_pYYYYMM` whose whole range ends at or before `cutoff`, oldest
 * first, and returns one row per partition it considered:
 * `(partition_name, dropped)`. An `events` partition that still holds an event
 * not dispatched yet is kept (`dropped = false`) so that no automation
 * trigger is lost silently; the caller logs it.
 *
 * Dropping a partition fires no row or TRUNCATE trigger, so this is the only
 * way audit rows leave the append-only table (ADR-23 §5).
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE FUNCTION meta.drop_monthly_partitions_before(p_table text, p_cutoff timestamptz)
   RETURNS TABLE (partition_name text, dropped boolean)
   LANGUAGE plpgsql
   SET search_path = pg_catalog, pg_temp
   AS $$
   DECLARE
     v_name text;
     v_month text;
     v_end timestamptz;
     v_pending boolean;
   BEGIN
     IF p_table IS NULL OR p_table NOT IN ('events', 'audit_logs') THEN
       RAISE EXCEPTION 'meta.drop_monthly_partitions_before: unsupported table %', p_table
         USING ERRCODE = 'invalid_parameter_value';
     END IF;
     IF p_cutoff IS NULL THEN
       RAISE EXCEPTION 'meta.drop_monthly_partitions_before: cutoff is required'
         USING ERRCODE = 'invalid_parameter_value';
     END IF;
     FOR v_name IN
       SELECT child.relname
         FROM pg_inherits i
         JOIN pg_class child ON child.oid = i.inhrelid
         JOIN pg_class parent ON parent.oid = i.inhparent
         JOIN pg_namespace ns ON ns.oid = parent.relnamespace
        WHERE ns.nspname = 'meta'
          AND parent.relname = p_table
          AND child.relname ~ ('^' || p_table || '_p[0-9]{6}$')
        ORDER BY child.relname
     LOOP
       v_month := right(v_name, 6);
       -- Date arithmetic, then UTC: independent of the session TimeZone.
       v_end := (make_date(left(v_month, 4)::int, right(v_month, 2)::int, 1) + interval '1 month')
                AT TIME ZONE 'UTC';
       -- Partitions are named in order; the first one still in range ends the scan.
       EXIT WHEN v_end > p_cutoff;
       IF p_table = 'events' THEN
         EXECUTE format('SELECT EXISTS (SELECT 1 FROM meta.%I WHERE dispatched_at IS NULL)', v_name)
           INTO v_pending;
         IF v_pending THEN
           partition_name := v_name;
           dropped := false;
           RETURN NEXT;
           CONTINUE;
         END IF;
       END IF;
       EXECUTE format('DROP TABLE meta.%I', v_name);
       partition_name := v_name;
       dropped := true;
       RETURN NEXT;
     END LOOP;
   END
   $$`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
