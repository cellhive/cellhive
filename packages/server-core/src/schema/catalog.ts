import { sql } from 'kysely';

import { assertDataTableName, DATA_SCHEMA } from './names.js';

import type { DbExecutor } from '../db/create-db.js';

/**
 * Read-only catalog queries about one data table. Names are passed as bound
 * parameters (compared with catalog columns), never spliced into SQL.
 */

/** A live (not dropped) column as `information_schema.columns` shows it. */
export interface CatalogColumn {
  readonly name: string;
  readonly dataType: string;
  readonly udtName: string;
  readonly collation: string | null;
  readonly notNull: boolean;
}

export async function dataTableExists(executor: DbExecutor, table: string): Promise<boolean> {
  const { rows } = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${DATA_SCHEMA} AND c.relname = ${assertDataTableName(table)} AND c.relkind = 'r'
    ) AS exists
  `.execute(executor);
  return rows[0]?.exists === true;
}

/**
 * Column slots used by the table (ADR-20): every attribute with `attnum > 0`,
 * **including** dropped ones, which PostgreSQL never gives back.
 */
export async function usedColumnSlots(executor: DbExecutor, table: string): Promise<number> {
  const { rows } = await sql<{ slots: number }>`
    SELECT count(*)::int AS slots
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${DATA_SCHEMA} AND c.relname = ${assertDataTableName(table)} AND a.attnum > 0
  `.execute(executor);
  return rows[0]?.slots ?? 0;
}

export async function liveColumns(executor: DbExecutor, table: string): Promise<CatalogColumn[]> {
  const { rows } = await sql<{
    column_name: string;
    data_type: string;
    udt_name: string;
    collation_name: string | null;
    is_nullable: string;
  }>`
    SELECT column_name, data_type, udt_name, collation_name, is_nullable
      FROM information_schema.columns
     WHERE table_schema = ${DATA_SCHEMA} AND table_name = ${assertDataTableName(table)}
     ORDER BY ordinal_position
  `.execute(executor);
  return rows.map((row) => ({
    name: row.column_name,
    dataType: row.data_type,
    udtName: row.udt_name,
    collation: row.collation_name,
    notNull: row.is_nullable === 'NO',
  }));
}

export async function indexNamesOf(executor: DbExecutor, table: string): Promise<string[]> {
  const { rows } = await sql<{ indexname: string }>`
    SELECT indexname FROM pg_indexes
     WHERE schemaname = ${DATA_SCHEMA} AND tablename = ${assertDataTableName(table)}
     ORDER BY indexname
  `.execute(executor);
  return rows.map((row) => row.indexname);
}

export async function checkConstraintNamesOf(
  executor: DbExecutor,
  table: string,
): Promise<string[]> {
  const { rows } = await sql<{ conname: string }>`
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${DATA_SCHEMA} AND c.relname = ${assertDataTableName(table)} AND con.contype = 'c'
     ORDER BY con.conname
  `.execute(executor);
  return rows.map((row) => row.conname);
}

/** A foreign key of another table (junction `data.l_*`) that references this table. */
export interface IncomingForeignKey {
  readonly name: string;
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly referencedColumn: string;
  /** `confdeltype`: `a` no action, `r` restrict, `c` cascade, `n` set null, `d` set default. */
  readonly onDelete: string;
}

/** Single-column FKs pointing at `table`, from other tables (`self = false`) or itself (`self = true`). */
export async function foreignKeysReferencing(
  executor: DbExecutor,
  table: string,
): Promise<(IncomingForeignKey & { readonly self: boolean; readonly columns: number })[]> {
  const { rows } = await sql<{
    conname: string;
    nspname: string;
    relname: string;
    attname: string;
    refattname: string;
    confdeltype: string;
    self: boolean;
    columns: number;
  }>`
    SELECT con.conname, sn.nspname, sc.relname, a.attname, ra.attname AS refattname,
           con.confdeltype::text AS confdeltype, con.conrelid = con.confrelid AS self,
           cardinality(con.conkey)::int AS columns
      FROM pg_constraint con
      JOIN pg_class tc ON tc.oid = con.confrelid
      JOIN pg_namespace tn ON tn.oid = tc.relnamespace
      JOIN pg_class sc ON sc.oid = con.conrelid
      JOIN pg_namespace sn ON sn.oid = sc.relnamespace
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = con.confkey[1]
     WHERE con.contype = 'f' AND tn.nspname = ${DATA_SCHEMA} AND tc.relname = ${assertDataTableName(table)}
     ORDER BY con.conname
  `.execute(executor);
  return rows.map((row) => ({
    name: row.conname,
    schema: row.nspname,
    table: row.relname,
    column: row.attname,
    referencedColumn: row.refattname,
    onDelete: row.confdeltype,
    self: row.self,
    columns: row.columns,
  }));
}

/** Foreign keys declared **on** `table` (e.g. a future `__parent_id` self-reference). */
export async function outgoingForeignKeyCount(
  executor: DbExecutor,
  table: string,
): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    SELECT count(*)::int AS count
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE con.contype = 'f' AND n.nspname = ${DATA_SCHEMA} AND c.relname = ${assertDataTableName(table)}
  `.execute(executor);
  return rows[0]?.count ?? 0;
}

/** Collations usable in this database (`pg_collation`, matching encoding or any). */
export async function collationExists(executor: DbExecutor, collation: string): Promise<boolean> {
  const { rows } = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_collation
       WHERE collname = ${collation}
         AND collencoding IN (-1, (SELECT encoding FROM pg_database WHERE datname = current_database()))
    ) AS exists
  `.execute(executor);
  return rows[0]?.exists === true;
}

/**
 * Columns of `table` that have their scan index `<table>_<column>_due`
 * (BACKLOG T508) on that same column.
 */
export async function dueIndexedColumnsOf(executor: DbExecutor, table: string): Promise<string[]> {
  const name = assertDataTableName(table);
  const { rows } = await sql<{ index_name: string; column_name: string }>`
    SELECT c.relname AS index_name, a.attname AS column_name
      FROM pg_index AS i
      JOIN pg_class AS c ON c.oid = i.indexrelid
      JOIN pg_class AS t ON t.oid = i.indrelid
      JOIN pg_namespace AS n ON n.oid = t.relnamespace
      JOIN pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE n.nspname = ${DATA_SCHEMA} AND t.relname = ${name}
     ORDER BY a.attname
  `.execute(executor);
  return rows
    .filter((row) => row.index_name === `${name}_${row.column_name}_due`)
    .map((row) => row.column_name);
}
