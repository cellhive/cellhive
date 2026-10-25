import { formatType, type FormulaType } from '@cellhive/formula-engine';
import { sql, type RawBuilder } from 'kysely';

import { FormulaCompileError } from './errors.js';

/**
 * SQL representation of formula values (SPEC §9.4, T454):
 *
 * | Formula type | SQL type |
 * |---|---|
 * | `text` (and `RECORD_ID()`) | `text` (the column collation for text fields) |
 * | `number` | `numeric` |
 * | `boolean` | `boolean` (an empty boolean counts as FALSE) |
 * | `date` | `date` |
 * | `datetime` | `timestamptz` |
 * | `user` | `text` (user id) |
 * | `attachment` | `jsonb` (one element of the attachment cell) |
 * | `list<T>` | `T[]` (`list<null>`: `text[]`); an empty list and NULL mean the same |
 *
 * | `row<tbl>` | `text` (record id; T455) |
 *
 * `table` values (`[Table]`) have no SQL value: the cross-table compiler
 * (T455, `cross/**`) keeps them as record sets.
 */

export type Sql = RawBuilder<unknown>;

/** A compiled expression with its formula type. */
export interface Compiled {
  readonly sql: Sql;
  readonly type: FormulaType;
  /** IANA zone of a date/datetime read from a field with its own `timezone` (ADR-21). */
  readonly zone?: string;
}

export type ScalarSqlKind =
  'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'user' | 'attachment';

const SCALAR_TYPES: Readonly<Record<ScalarSqlKind, Sql>> = {
  text: sql`text`,
  number: sql`numeric`,
  boolean: sql`boolean`,
  date: sql`date`,
  datetime: sql`timestamptz`,
  user: sql`text`,
  attachment: sql`jsonb`,
};

const ARRAY_TYPES: Readonly<Record<ScalarSqlKind, Sql>> = {
  text: sql`text[]`,
  number: sql`numeric[]`,
  boolean: sql`boolean[]`,
  date: sql`date[]`,
  datetime: sql`timestamptz[]`,
  user: sql`text[]`,
  attachment: sql`jsonb[]`,
};

/** SQL kind of a single value type; `null`/`any` default to text. */
export function scalarKind(type: FormulaType): ScalarSqlKind {
  switch (type.kind) {
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'user':
    case 'attachment':
      return type.kind;
    case 'null':
    case 'any':
    case 'row':
      return 'text';
    default:
      throw new FormulaCompileError(
        'UNSUPPORTED_TYPE',
        `No same-row SQL representation for ${formatType(type)}.`,
      );
  }
}

/** SQL type name of a value type (`numeric`, `text[]`…), a fixed fragment. */
export function sqlTypeOf(type: FormulaType): Sql {
  if (type.kind === 'list') return ARRAY_TYPES[scalarKind(type.element)];
  return SCALAR_TYPES[scalarKind(type)];
}

export const isList = (type: FormulaType): boolean => type.kind === 'list';

/** `NULL` typed as `type`. */
export function nullOf(type: FormulaType): Sql {
  return sql`CAST(NULL AS ${sqlTypeOf(type)})`;
}

/** An empty array of `type` (a list type). */
export function emptyOf(type: FormulaType): Sql {
  return sql`CAST(ARRAY[] AS ${sqlTypeOf(type)})`;
}

/** A bound parameter with an explicit type: literals never reach the SQL text. */
export function param(value: string | boolean | readonly string[], type: Sql): Sql {
  return sql`CAST(${sql.val(value)} AS ${type})`;
}

export const textParam = (value: string): Sql => param(value, sql`text`);
export const numberParam = (value: string): Sql => param(value, sql`numeric`);

/** `coalesce(x, false)`: an empty boolean counts as FALSE. */
export function truthy(value: Sql): Sql {
  return sql`coalesce(${value}, false)`;
}

/** A list, never NULL (`'{}'` instead). */
export function nonNullList(value: Compiled): Sql {
  return sql`coalesce(${value.sql}, ${emptyOf(value.type)})`;
}
