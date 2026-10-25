import { collateClause, getFieldType, type FieldType } from '@cellhive/field-types';
import { sql, type RawBuilder } from 'kysely';

import {
  assertDataTableName,
  assertFieldColumnName,
  assertJunctionTableName,
  assertLinkBackupTableName,
  DATA_SCHEMA,
  DELETED_COLUMN_NAME_PATTERN,
  DUE_INDEX_SUFFIX,
  FIELD_COLUMN_NAME_PATTERN,
  indexName,
  parentForeignKeyName,
  OLD_COLUMN_NAME_PATTERN,
  primaryKeyName,
  SHADOW_COLUMN_NAME_PATTERN,
  singleValueCheckName,
} from './names.js';

/**
 * The physical shape of a data table (SPEC §5.4, §5.5) and the DDL that
 * builds it. Shared by table creation, `addField`, option changes and
 * compaction, so every path produces exactly the same columns, constraints
 * and indexes; the consistency checker compares the catalog with the same
 * plan.
 */

export interface ExpectedColumn {
  /** `information_schema.columns.data_type`. */
  readonly dataType: string;
  /** `information_schema.columns.udt_name`. */
  readonly udtName: string;
  /** Explicit collation, `null` for the database default / non-collatable types. */
  readonly collation: string | null;
  readonly notNull: boolean;
}

/** SPEC §5.4 system columns, in table order. */
export const SYSTEM_COLUMNS: readonly (ExpectedColumn & { readonly name: string })[] = [
  { name: '__id', dataType: 'text', udtName: 'text', collation: null, notNull: true },
  { name: '__auto', dataType: 'bigint', udtName: 'int8', collation: null, notNull: true },
  {
    name: '__created_at',
    dataType: 'timestamp with time zone',
    udtName: 'timestamptz',
    collation: null,
    notNull: true,
  },
  {
    name: '__updated_at',
    dataType: 'timestamp with time zone',
    udtName: 'timestamptz',
    collation: null,
    notNull: true,
  },
  { name: '__created_by', dataType: 'text', udtName: 'text', collation: null, notNull: false },
  { name: '__updated_by', dataType: 'text', udtName: 'text', collation: null, notNull: false },
  { name: '__version', dataType: 'integer', udtName: 'int4', collation: null, notNull: true },
  {
    name: '__deleted_at',
    dataType: 'timestamp with time zone',
    udtName: 'timestamptz',
    collation: null,
    notNull: false,
  },
  { name: '__deleted_by', dataType: 'text', udtName: 'text', collation: null, notNull: false },
];

export const SYSTEM_COLUMN_NAMES: readonly string[] = SYSTEM_COLUMNS.map((column) => column.name);

/**
 * Column types `pgType` of `@cellhive/field-types` may return. Anything else
 * is refused before it reaches DDL: the type text is the one SQL fragment
 * not built with `sql.id`/parameters, so it must come from this closed set.
 */
const PG_TYPE_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly expected: (m: RegExpExecArray) => ExpectedColumn;
}[] = [
  {
    pattern: /^text COLLATE "([A-Za-z0-9_.@-]+)"$/,
    expected: (m) => ({
      dataType: 'text',
      udtName: 'text',
      collation: m[1] ?? null,
      notNull: false,
    }),
  },
  {
    pattern: /^text\[\]$/,
    expected: () => ({ dataType: 'ARRAY', udtName: '_text', collation: null, notNull: false }),
  },
  {
    pattern: /^numeric$/,
    expected: () => ({ dataType: 'numeric', udtName: 'numeric', collation: null, notNull: false }),
  },
  {
    pattern: /^date$/,
    expected: () => ({ dataType: 'date', udtName: 'date', collation: null, notNull: false }),
  },
  {
    pattern: /^timestamptz$/,
    expected: () => ({
      dataType: 'timestamp with time zone',
      udtName: 'timestamptz',
      collation: null,
      notNull: false,
    }),
  },
  {
    pattern: /^boolean NOT NULL DEFAULT false$/,
    expected: () => ({ dataType: 'boolean', udtName: 'bool', collation: null, notNull: true }),
  },
  // T406: `attachment` cells (display cache of `meta.attachments`).
  {
    pattern: /^jsonb$/,
    expected: () => ({ dataType: 'jsonb', udtName: 'jsonb', collation: null, notNull: false }),
  },
  // T456: stored computed columns (BACKLOG S4b open question #5): ids
  // (users, records) as `text` of the database collation.
  {
    pattern: /^text$/,
    expected: () => ({ dataType: 'text', udtName: 'text', collation: null, notNull: false }),
  },
  {
    pattern: /^boolean$/,
    expected: () => ({ dataType: 'boolean', udtName: 'bool', collation: null, notNull: false }),
  },
  {
    pattern: /^(numeric|date|timestamptz|boolean)\[\]$/,
    expected: (m) => ({
      dataType: 'ARRAY',
      udtName: `_${m[1] === 'boolean' ? 'bool' : (m[1] ?? '')}`,
      collation: null,
      notNull: false,
    }),
  },
];

/** What the catalog must show for a column created with `pgType`; throws for unknown types. */
export function expectedColumnOf(pgType: string): ExpectedColumn {
  for (const { pattern, expected } of PG_TYPE_PATTERNS) {
    const match = pattern.exec(pgType);
    if (match !== null) return expected(match);
  }
  throw new TypeError(`Unsupported column type from pgType: ${JSON.stringify(pgType)}`);
}

/** Types whose values can be kept unique by a partial unique index (SPEC §5.4). */
export const UNIQUE_CAPABLE_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'text',
  'number',
  'datetime',
  'auto_number',
]);

/** Types whose column is a `text[]` that may be limited to one element (`multiple = false`). */
const LIST_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(['select', 'user']);
/** Types indexed with a trigram index on `meta.f_unaccent(lower(col))` when primary. */
const TRIGRAM_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(['text', 'auto_number']);

export type IndexKind = 'trgm' | 'gin' | 'uniq';

export interface IndexPlan {
  readonly name: string;
  readonly kind: IndexKind;
}

/** A field as the physical layer sees it. `options` must already be parsed by the type's schema. */
export interface PhysicalField {
  readonly type: FieldType;
  readonly options: unknown;
  /** Canonical `f_<shortId>`. */
  readonly column: string;
  readonly isPrimary: boolean;
  readonly uniqueValues: boolean;
}

export interface ColumnPlan {
  readonly column: string;
  readonly pgType: string;
  readonly expected: ExpectedColumn;
  /** `CHECK (cardinality(col) <= 1)` for select/user with `multiple = false`. */
  readonly singleValue: boolean;
  readonly indexes: readonly IndexPlan[];
}

function isSingleValueList(field: PhysicalField): boolean {
  if (!LIST_TYPES.has(field.type)) return false;
  const options = field.options as { readonly multiple?: unknown };
  return options.multiple === false;
}

/**
 * The column, constraint and indexes of a field on table `table` whose text
 * columns use `collation`; `null` for types without a column of their own
 * (created/updated at/by read system columns).
 */
export function planColumn(
  field: PhysicalField,
  table: string,
  collation: string,
): ColumnPlan | null {
  const definition = getFieldType(field.type);
  if (definition === undefined) {
    throw new TypeError(`Field type ${field.type} has no physical column yet`);
  }
  const pgType = definition.pgType(field.options, { collation });
  if (pgType === null) return null;
  assertFieldColumnName(field.column);
  const indexes: IndexPlan[] = [];
  if (field.isPrimary && TRIGRAM_TYPES.has(field.type)) {
    indexes.push({ name: indexName(table, `${field.column}_trgm`), kind: 'trgm' });
  }
  if (LIST_TYPES.has(field.type)) {
    indexes.push({ name: indexName(table, `${field.column}_gin`), kind: 'gin' });
  }
  if (field.uniqueValues) {
    if (!UNIQUE_CAPABLE_TYPES.has(field.type)) {
      throw new TypeError(`Field type ${field.type} cannot have unique values`);
    }
    indexes.push({ name: indexName(table, `${field.column}_uniq`), kind: 'uniq' });
  }
  return {
    column: field.column,
    pgType,
    expected: expectedColumnOf(pgType),
    singleValue: isSingleValueList(field),
    indexes,
  };
}

/** Indexes every data table has (SPEC §5.4), besides the primary key. */
export function systemIndexNames(table: string): readonly string[] {
  return [indexName(table, 'created_at_idx'), indexName(table, 'deleted_at_idx')];
}

// ---------------------------------------------------------------------------
// DDL builders. Identifiers go through `sql.id` after a pattern check; the
// column type comes from the closed set above.

const tableRef = (table: string) => sql.id(DATA_SCHEMA, assertDataTableName(table));

/**
 * The physical column of a field: its canonical `f_<id>` or, for a field in
 * the trash kept by compaction, `f_<id>__deleted_<epoch>`, or the column
 * kept by a type conversion, `f_<id>__old_<epoch ms>`, or the one a running
 * conversion fills, `f_<id>__new_<epoch ms>` (T403). Index and
 * CHECK names always derive from the canonical name.
 */
function physicalColumnId(column: string): RawBuilder<unknown> {
  if (
    !FIELD_COLUMN_NAME_PATTERN.test(column) &&
    !DELETED_COLUMN_NAME_PATTERN.test(column) &&
    !OLD_COLUMN_NAME_PATTERN.test(column) &&
    !SHADOW_COLUMN_NAME_PATTERN.test(column)
  ) {
    throw new TypeError(`Invalid field column name: ${JSON.stringify(column)}`);
  }
  return sql.id(column);
}

/** `CREATE TABLE data.<table>` with the SPEC §5.4 system columns only. */
export function createTableSql(table: string): RawBuilder<unknown> {
  return sql`CREATE TABLE ${tableRef(table)} (
    __id text NOT NULL,
    __auto bigint GENERATED ALWAYS AS IDENTITY,
    __created_at timestamptz NOT NULL DEFAULT now(),
    __updated_at timestamptz NOT NULL DEFAULT now(),
    __created_by text,
    __updated_by text,
    __version integer NOT NULL DEFAULT 1,
    __deleted_at timestamptz,
    __deleted_by text,
    CONSTRAINT ${sql.id(primaryKeyName(table))} PRIMARY KEY (__id)
  )`;
}

/** The `__created_at` and partial `__deleted_at` indexes (SPEC §5.4). */
export function systemIndexesSql(table: string): readonly RawBuilder<unknown>[] {
  const [createdAt, deletedAt] = systemIndexNames(table) as [string, string];
  return [
    sql`CREATE INDEX ${sql.id(createdAt)} ON ${tableRef(table)} (__created_at)`,
    sql`CREATE INDEX ${sql.id(deletedAt)} ON ${tableRef(table)} (__deleted_at) WHERE __deleted_at IS NOT NULL`,
  ];
}

/** `ADD COLUMN` for a plan; `physical` names a trashed column kept by compaction. */
export function addColumnSql(
  table: string,
  plan: ColumnPlan,
  physical: string = plan.column,
): RawBuilder<unknown> {
  expectedColumnOf(plan.pgType);
  return sql`ALTER TABLE ${tableRef(table)} ADD COLUMN ${physicalColumnId(physical)} ${sql.raw(plan.pgType)}`;
}

/** Single-value CHECK named after the canonical `column`, on `physical` (default: the same). */
export function singleValueCheckSql(
  table: string,
  column: string,
  physical: string = column,
): RawBuilder<unknown> {
  return sql`ALTER TABLE ${tableRef(table)} ADD CONSTRAINT ${sql.id(singleValueCheckName(column))} CHECK (cardinality(${physicalColumnId(physical)}) <= 1)`;
}

export function dropSingleValueCheckSql(table: string, column: string): RawBuilder<unknown> {
  return sql`ALTER TABLE ${tableRef(table)} DROP CONSTRAINT IF EXISTS ${sql.id(singleValueCheckName(column))}`;
}

/**
 * `CREATE INDEX` for one planned index. The trigram expression is exactly the
 * one the filter compiler emits for `eq`/`contains`/`starts_with`/`ends_with`
 * (`meta.f_unaccent(lower(col))`, no `COLLATE`: the column carries the table
 * collation), so the planner can use it.
 */
export function createIndexSql(
  table: string,
  column: string,
  index: IndexPlan,
): RawBuilder<unknown> {
  const col = physicalColumnId(column);
  const name = sql.id(index.name);
  switch (index.kind) {
    case 'trgm':
      return sql`CREATE INDEX ${name} ON ${tableRef(table)} USING gin (meta.f_unaccent(lower(${col})) public.gin_trgm_ops)`;
    case 'gin':
      return sql`CREATE INDEX ${name} ON ${tableRef(table)} USING gin (${col})`;
    case 'uniq':
      return sql`CREATE UNIQUE INDEX ${name} ON ${tableRef(table)} (${col}) WHERE __deleted_at IS NULL`;
  }
}

/**
 * The scan index of a date column (BACKLOG T508, `SchemaService.ensureDueIndex`):
 * `<table>_<column>_due`, btree, partial on live rows.
 */
export function createDueIndexSql(table: string, column: string): RawBuilder<unknown> {
  const name = indexName(table, `${assertFieldColumnName(column)}${DUE_INDEX_SUFFIX}`);
  return sql`CREATE INDEX ${sql.id(name)} ON ${tableRef(table)} (${sql.id(column)}) WHERE __deleted_at IS NULL`;
}

export function dropIndexSql(index: IndexPlan): RawBuilder<unknown> {
  return sql`DROP INDEX IF EXISTS ${sql.id(DATA_SCHEMA, index.name)}`;
}

/** Every statement that creates a planned column with its constraint and indexes. */
export function columnDdl(table: string, plan: ColumnPlan): readonly RawBuilder<unknown>[] {
  return [
    addColumnSql(table, plan),
    ...(plan.singleValue ? [singleValueCheckSql(table, plan.column)] : []),
    ...plan.indexes.map((index) => createIndexSql(table, plan.column, index)),
  ];
}

// ---------------------------------------------------------------------------
// Link junctions (SPEC §5.6, BACKLOG T401). `a_id` references the table of
// the field that created the junction, `b_id` the linked table (the same
// table for a self-link); `position` orders the links of an `a_id` cell.

const junctionRef = (junction: string) => sql.id(DATA_SCHEMA, assertJunctionTableName(junction));

/** Constraint and index names of a junction (unique per schema: prefixed by its name). */
export function junctionObjectNames(junction: string): {
  readonly primaryKey: string;
  readonly aForeignKey: string;
  readonly bForeignKey: string;
  readonly bIndex: string;
  readonly singleIndex: string;
  readonly bSingleIndex: string;
} {
  assertJunctionTableName(junction);
  return {
    primaryKey: `${junction}_pkey`,
    aForeignKey: `${junction}_a_fkey`,
    bForeignKey: `${junction}_b_fkey`,
    bIndex: `${junction}_b_idx`,
    singleIndex: `${junction}_a_uniq`,
    bSingleIndex: `${junction}_b_uniq`,
  };
}

/**
 * `CREATE TABLE data.l_<id>` with both foreign keys (`ON DELETE CASCADE`,
 * so a record purged from either table loses its links) and the `b_id`
 * index used to read the reverse side; plus the unique `a_id` index of a
 * single-record link (`allow_multiple = false`).
 */
export function createJunctionSql(
  junction: string,
  aTable: string,
  bTable: string,
  single: boolean,
): readonly RawBuilder<unknown>[] {
  const names = junctionObjectNames(junction);
  return [
    sql`CREATE TABLE ${junctionRef(junction)} (
      a_id text NOT NULL,
      b_id text NOT NULL,
      position integer NOT NULL DEFAULT 0,
      CONSTRAINT ${sql.id(names.primaryKey)} PRIMARY KEY (a_id, b_id),
      CONSTRAINT ${sql.id(names.aForeignKey)} FOREIGN KEY (a_id) REFERENCES ${tableRef(aTable)} (__id) ON DELETE CASCADE,
      CONSTRAINT ${sql.id(names.bForeignKey)} FOREIGN KEY (b_id) REFERENCES ${tableRef(bTable)} (__id) ON DELETE CASCADE
    )`,
    sql`CREATE INDEX ${sql.id(names.bIndex)} ON ${junctionRef(junction)} (b_id)`,
    ...(single ? [junctionSingleIndexSql(junction)] : []),
  ];
}

/**
 * The unique index of a single-record link (`allow_multiple = false`) on
 * the column of its side: `a_id` for the field that created the junction,
 * `b_id` for the reverse field of a two-way link made single (T404).
 */
export function junctionSingleIndexSql(
  junction: string,
  side: 'a' | 'b' = 'a',
): RawBuilder<unknown> {
  const names = junctionObjectNames(junction);
  return side === 'a'
    ? sql`CREATE UNIQUE INDEX ${sql.id(names.singleIndex)} ON ${junctionRef(junction)} (a_id)`
    : sql`CREATE UNIQUE INDEX ${sql.id(names.bSingleIndex)} ON ${junctionRef(junction)} (b_id)`;
}

export function dropJunctionSingleIndexSql(
  junction: string,
  side: 'a' | 'b' = 'a',
): RawBuilder<unknown> {
  const names = junctionObjectNames(junction);
  return sql`DROP INDEX IF EXISTS ${sql.id(DATA_SCHEMA, side === 'a' ? names.singleIndex : names.bSingleIndex)}`;
}

const linkBackupRef = (table: string) => sql.id(DATA_SCHEMA, assertLinkBackupTableName(table));

/**
 * The backup of a link `to_single` conversion (T404): junction rows of the
 * cut cells (`kept` = the link the cell kept), no foreign key (a revert
 * only puts back links whose records still exist).
 */
export function createLinkBackupSql(table: string): RawBuilder<unknown> {
  return sql`CREATE TABLE ${linkBackupRef(table)} (
    a_id text NOT NULL,
    b_id text NOT NULL,
    position integer NOT NULL,
    kept boolean NOT NULL,
    PRIMARY KEY (a_id, b_id)
  )`;
}

export function dropLinkBackupSql(table: string): RawBuilder<unknown> {
  return sql`DROP TABLE IF EXISTS ${linkBackupRef(table)}`;
}

// ---------------------------------------------------------------------------
// Table purge (BACKLOG T461): a table leaves the trash for good. Junctions
// referencing it are dropped first; the data table itself is dropped
// without `CASCADE`, so an unexpected dependency fails the purge instead of
// silently taking another object with it.

/** `DROP TABLE IF EXISTS data.l_<id>`: a junction of a link touching a purged table. */
export function dropJunctionSql(junction: string): RawBuilder<unknown> {
  return sql`DROP TABLE IF EXISTS ${junctionRef(junction)}`;
}

/** `DROP TABLE IF EXISTS data.t_<id>` (no `CASCADE`). */
export function dropDataTableSql(table: string): RawBuilder<unknown> {
  return sql`DROP TABLE IF EXISTS ${tableRef(table)}`;
}

// ---------------------------------------------------------------------------
// Sub-records (SPEC §5.7, BACKLOG T405): the `parent` field of a table keeps
// its values in the system column `__parent_id`, a self-reference
// (`ON DELETE SET NULL`: purging a record makes its children roots) with a
// btree index for the children of a record and the roots (`IS NULL`).

/** Column of the `parent` field (the field itself has no `db_column_name`). */
export const PARENT_COLUMN = '__parent_id';

/** What the catalog shows for {@link PARENT_COLUMN}. */
export const PARENT_COLUMN_EXPECTED: ExpectedColumn = {
  dataType: 'text',
  udtName: 'text',
  collation: null,
  notNull: false,
};

/** Index of {@link PARENT_COLUMN} (named after the table, renamed by compaction). */
export function parentIndexName(table: string): string {
  return indexName(table, 'parent_idx');
}

export function addParentColumnSql(table: string): RawBuilder<unknown> {
  return sql`ALTER TABLE ${tableRef(table)} ADD COLUMN ${sql.id(PARENT_COLUMN)} text`;
}

export function parentIndexSql(table: string): RawBuilder<unknown> {
  return sql`CREATE INDEX ${sql.id(parentIndexName(table))} ON ${tableRef(table)} (${sql.id(PARENT_COLUMN)})`;
}

/**
 * The self-reference of {@link PARENT_COLUMN}; `notValid` adds it without
 * checking existing rows (compaction validates it right after).
 */
export function parentForeignKeySql(table: string, notValid = false): RawBuilder<unknown> {
  return sql`ALTER TABLE ${tableRef(table)} ADD CONSTRAINT ${sql.id(parentForeignKeyName(table))} FOREIGN KEY (${sql.id(PARENT_COLUMN)}) REFERENCES ${tableRef(table)} (__id) ON DELETE SET NULL${notValid ? sql` NOT VALID` : sql``}`;
}

export function validateParentForeignKeySql(table: string): RawBuilder<unknown> {
  return sql`ALTER TABLE ${tableRef(table)} VALIDATE CONSTRAINT ${sql.id(parentForeignKeyName(table))}`;
}

/** Column, self-reference and index of a table that gets sub-records. */
export function parentColumnDdl(table: string): readonly RawBuilder<unknown>[] {
  return [addParentColumnSql(table), parentForeignKeySql(table), parentIndexSql(table)];
}

/** Drops {@link PARENT_COLUMN} with its foreign key and index (a purged `parent` field). */
export function dropParentColumnSql(table: string): RawBuilder<unknown> {
  return sql`ALTER TABLE ${tableRef(table)} DROP COLUMN IF EXISTS ${sql.id(PARENT_COLUMN)}`;
}

// ---------------------------------------------------------------------------
// Computed fields (BACKLOG T456, SPEC §5.9): a `stored` formula/lookup keeps
// its value in a column of the PostgreSQL type of its result (BACKLOG S4b
// open question #5): scalars in their native type (`text` with the table
// collation), lists as arrays of it (records, users and select names as
// `text[]`), attachments as `jsonb` like attachment cells. No index, no
// constraint (S9 revisits indexes). A `virtual` one has no column.

type ResultJson = { readonly kind?: unknown; readonly element?: unknown };

const SCALAR_COLUMN_TYPES: Readonly<Record<string, string>> = {
  number: 'numeric',
  boolean: 'boolean',
  date: 'date',
  datetime: 'timestamptz',
  user: 'text',
  row: 'text',
  null: 'text',
  any: 'text',
};

/**
 * PostgreSQL type of the stored column of a computed result type
 * (`meta.fields.result_type`); throws for a type that is no result
 * (`table`, a list of lists).
 */
export function computedColumnType(resultType: unknown, collation: string): string {
  const type = (resultType ?? {}) as ResultJson;
  if (type.kind === 'list') {
    const element = (type.element ?? {}) as ResultJson;
    switch (element.kind) {
      case 'text':
      case 'user':
      case 'row':
      case 'null':
      case 'any':
        return 'text[]';
      case 'number':
        return 'numeric[]';
      case 'boolean':
        return 'boolean[]';
      case 'date':
        return 'date[]';
      case 'datetime':
        return 'timestamptz[]';
      case 'attachment':
        return 'jsonb';
      default:
        throw new TypeError(`No stored column for a list of ${String(element.kind)}`);
    }
  }
  if (type.kind === 'text') return `text ${collateClause({ collation })}`;
  if (type.kind === 'attachment') return 'jsonb';
  const scalar = typeof type.kind === 'string' ? SCALAR_COLUMN_TYPES[type.kind] : undefined;
  if (scalar === undefined) throw new TypeError(`No stored column for ${String(type.kind)}`);
  return scalar;
}

/** The column of a stored computed field (no CHECK, no index). */
export function planComputedColumn(
  column: string,
  resultType: unknown,
  collation: string,
): ColumnPlan {
  assertFieldColumnName(column);
  const pgType = computedColumnType(resultType, collation);
  return { column, pgType, expected: expectedColumnOf(pgType), singleValue: false, indexes: [] };
}

/** `ALTER TABLE … DROP COLUMN` of a computed column replaced by another (ADR-20: the slot stays used). */
export function dropComputedColumnSql(table: string, column: string): RawBuilder<unknown> {
  return sql`ALTER TABLE ${tableRef(table)} DROP COLUMN IF EXISTS ${physicalColumnId(column)}`;
}

/** `ANALYZE data.<table>` after a job wrote ≥ 10 000 computed values (S4-review §6 #7). */
export function analyzeTableSql(table: string): RawBuilder<unknown> {
  return sql`ANALYZE ${tableRef(table)}`;
}
