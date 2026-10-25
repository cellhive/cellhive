import {
  containFoldsCase,
  elementOf,
  fieldValueType,
  listOf,
  rowOf,
  rowsTable,
  T,
  type Call,
  type Expr,
  type FormulaType,
  type Member,
  type Reference,
} from '@cellhive/formula-engine';
import { sql } from 'kysely';

import { PARENT_COLUMN } from '../../schema/physical.js';
import { elementOfType, fold, foldAll } from '../call.js';
import { FormulaCompiler } from '../compiler.js';
import { FormulaCompileError } from '../errors.js';
import { emptyOf, nonNullList, nullOf, numberParam, textParam, truthy } from '../values.js';

import { conjunction, selectOver, RowSets, type RowSet } from './rows.js';

import type { CrossTableContext } from './context.js';
import type { LinkFieldModel } from '../../records/links/link-model.js';
import type { FieldModel, TableModel } from '../../records/table-model.js';
import type { ComputedFieldSql, FormulaSqlExtension } from '../context.js';
import type { Compiled, Sql } from '../values.js';

/** What a field id of a table stands for. */
type Target =
  | { readonly kind: 'field'; readonly field: FieldModel }
  | { readonly kind: 'computed'; readonly computed: ComputedFieldSql }
  | { readonly kind: 'link'; readonly link: LinkFieldModel }
  | { readonly kind: 'parent' };

/**
 * `list<list<T>>` read on a record set (`[Link].[Tags]`, `MAP` giving
 * lists): one list per record, never materialised as one SQL value (arrays
 * of arrays are not ragged in PostgreSQL); only LISTCOMBINE, COUNTA and
 * ISBLANK take it (SPEC §9.2: it needs LISTCOMBINE before other functions).
 */
interface Nested {
  readonly rows: RowSet;
  /** The list of one record of `rows` (over `rows.alias`). */
  readonly element: Compiled;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNested = (type: FormulaType | undefined): boolean =>
  type?.kind === 'list' && type.element.kind === 'list';

const hasRows = (type: FormulaType | undefined): boolean =>
  type !== undefined && rowsTable(type) !== null;

const AT = { start: 0, length: 0 } as const;

/** `[Table].[Field]` → its table and field ids (LOOKUP arguments 2 and 3). */
function tableField(node: Expr | undefined): { tableId: string; fieldId: string } | null {
  if (node?.type !== 'member' || node.object.type !== 'reference') return null;
  const { object, property } = node;
  if (object.kind !== 'table' || object.id === null || property.id === null) return null;
  return { tableId: object.id, fieldId: property.id };
}

/** The parts of a typechecked LOOKUP call (same reading as the catalogue's `lookupParts`). */
function lookupParts(
  args: readonly Expr[],
): { tableId: string; matchFieldId: string; resultFieldId: string; mode: 0 | 1 } | null {
  const match = tableField(args[1]);
  const result = tableField(args[2]);
  const modeNode = args[3];
  const mode =
    modeNode === undefined ? 1 : modeNode.type === 'number' ? Number(modeNode.value) : NaN;
  if (match === null || result === null || match.tableId !== result.tableId) return null;
  if (mode !== 0 && mode !== 1) return null;
  return {
    tableId: match.tableId,
    matchFieldId: match.fieldId,
    resultFieldId: result.fieldId,
    mode,
  };
}

/**
 * Cross-table part of the formula SQL compiler (SPEC §9.4, BACKLOG T455),
 * plugged into the same-row compiler as `FormulaSqlContext.extension`:
 *
 * - a record (`row<tbl>`) is its `__id` (`text`), a list of records a
 *   `text[]` of ids; `[Table]`, link cells, link chains (≤ 3, both sides,
 *   self-links, `parent`), FILTER and SORTBY results are {@link RowSet}s
 *   turned into one correlated subquery where a value is needed;
 * - `CurrentValue` of an iteration over records is the record of the
 *   subquery (`CurrentValue.[Field]` reads its column directly);
 * - live records only; a table in the trash reads as empty (C§13); every
 *   source table is filtered by the viewer's scope (`sourceScope`);
 * - a record compares with a text by its title (primary field as text),
 *   with `RECORD_ID()` of its table and with another record by id (T452).
 */
export class CrossTableCompiler implements FormulaSqlExtension {
  private readonly sets: RowSets;
  /** Record sets of `table`/`list<row>` values this compiler produced. */
  private readonly rowSets = new WeakMap<Compiled, RowSet>();
  /** `CurrentValue` of an iteration over records: the record aliased in `rows`. */
  private readonly current = new WeakMap<Compiled, RowSet>();
  private readonly nested = new WeakMap<Compiled, Nested>();
  /** Booleans that are never NULL (EXISTS…): used bare in WHERE so PostgreSQL can plan semi-joins. */
  private readonly twoValued = new WeakSet<Compiled>();
  private readonly targets = new Map<string, Map<string, Target>>();

  constructor(private readonly cross: CrossTableContext) {
    const table = (tableId: string): TableModel | null =>
      tableId === cross.self.table.id ? cross.self : cross.table(tableId);
    const scope =
      cross.sourceScope === undefined
        ? undefined
        : (tableId: string, alias: string) => cross.sourceScope?.(tableId, alias) ?? null;
    this.sets = new RowSets(table, scope, cross.aliasBase ?? 0);
  }

  // ---------------------------------------------------------------------------
  // Hooks

  compile(node: Expr, compiler: FormulaCompiler): Compiled | undefined {
    switch (node.type) {
      case 'reference':
        return this.reference(node, compiler);
      case 'member':
        return this.member(node, compiler);
      case 'call':
        return this.call(node, compiler);
      case 'binary':
        this.refuseNested(compiler, [node.left, node.right], node.operator);
        return undefined;
      default:
        return undefined;
    }
  }

  equals(left: Compiled, right: Compiled, compiler: FormulaCompiler): Sql | undefined {
    const leftTable = rowsTable(left.type);
    const rightTable = rowsTable(right.type);
    if (leftTable === null && rightTable === null) return undefined;
    if (leftTable !== null && rightTable !== null) {
      return compiler.equals(asIds(left), asIds(right));
    }
    const [rows, other] = leftTable === null ? [right, left] : [left, right];
    const table = (leftTable ?? rightTable) as string;
    const otherElement = elementOf(other.type);
    const byId =
      otherElement.kind === 'null' ||
      otherElement.kind === 'any' ||
      (otherElement.kind === 'text' && otherElement.recordIdOf === table);
    const converted = byId ? asIds(rows) : this.titles(rows, compiler);
    return compiler.equals(converted, other);
  }

  toText(value: Compiled, compiler: FormulaCompiler): Sql | undefined {
    if (value.type.kind !== 'row') return undefined;
    return this.title(value, compiler);
  }

  // ---------------------------------------------------------------------------
  // Nodes

  private reference(node: Reference, compiler: FormulaCompiler): Compiled | undefined {
    if (node.kind === 'table' && node.id !== null) {
      return this.rowsValue(this.sets.table(node.id), compiler.typeOf(node));
    }
    const type = compiler.ctx.types.get(node);
    if (type === undefined || !hasRows(type) || node.id === null) return undefined;
    const target = this.target(this.cross.self, node.id);
    switch (target.kind) {
      case 'link':
        return this.rowsValue(this.sets.link(target.link, compiler.column('__id')), type);
      case 'parent':
        return this.rowsValue(
          this.sets.parent(this.cross.self.table.id, compiler.column(PARENT_COLUMN)),
          type,
        );
      default:
        throw new FormulaCompileError(
          'UNSUPPORTED_FIELD',
          `Field ${node.id} holds records but is not a link.`,
        );
    }
  }

  private member(node: Member, compiler: FormulaCompiler): Compiled {
    const object = compiler.compile(node.object);
    const type = compiler.typeOf(node);
    const fieldId = node.property.id;
    if (fieldId === null) throw new FormulaCompileError('UNTYPED', 'Unresolved field name.');
    if (object.type.kind === 'row') {
      const record = this.current.get(object);
      if (record !== undefined) return this.onRecord(record, fieldId, type, compiler);
      const one = this.sets.ids(object.type.tableId, sql`ARRAY[${object.sql}]::text[]`);
      return this.onOne(one, fieldId, type, compiler);
    }
    return this.column(this.rowsOf(object), fieldId, type, compiler);
  }

  private call(node: Call, compiler: FormulaCompiler): Compiled | undefined {
    const types = node.args.map((arg) => compiler.ctx.types.get(arg));
    const overRows = hasRows(types[0]);
    switch (node.name) {
      case 'FILTER':
      case 'MAP':
      case 'COUNTIF':
      case 'SORTBY':
      case 'SUMIF':
        return overRows ? this.iterate(node, compiler) : undefined;
      case 'LOOKUP':
        return this.lookup(node, compiler);
      case 'FIRST':
      case 'LAST':
      case 'NTH':
        return overRows ? this.pick(node, compiler) : undefined;
      case 'ARRAYJOIN':
        return overRows ? this.arrayJoin(node, compiler) : undefined;
      case 'CONTAIN':
      case 'CONTAINSALL':
      case 'CONTAINSONLY':
        return types.some((type) => type !== undefined && elementOf(type).kind === 'row')
          ? this.contain(node, compiler)
          : undefined;
      case 'LISTCOMBINE':
      case 'COUNTA':
      case 'ISBLANK':
        return types.some(isNested) ? this.nestedCall(node, compiler) : undefined;
      default:
        this.refuseNested(compiler, node.args, node.name);
        return undefined;
    }
  }

  /** A list of lists anywhere else than LISTCOMBINE/COUNTA/ISBLANK. */
  private refuseNested(compiler: FormulaCompiler, args: readonly Expr[], what: string): void {
    if (args.some((arg) => isNested(compiler.ctx.types.get(arg)))) {
      throw new FormulaCompileError(
        'UNSUPPORTED_TYPE',
        `${what} does not take a list of lists in SQL: combine it with LISTCOMBINE first.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Values of record sets

  /** A `table`/`list<row>` value: the ids (`text[]`), remembering its record set. */
  private rowsValue(rows: RowSet, type: FormulaType): Compiled {
    const value: Compiled = {
      sql:
        rows.model === null
          ? emptyOf(listOf(T.text))
          : sql`ARRAY(${selectOver(rows, sql.id(rows.alias, '__id'))})`,
      type,
    };
    this.rowSets.set(value, rows);
    return value;
  }

  /** The record set of a `table`, `list<row>` or `row` value. */
  private rowsOf(value: Compiled): RowSet {
    const known = this.rowSets.get(value);
    if (known !== undefined) return known;
    const tableId = rowsTable(value.type);
    if (tableId === null || value.type.kind === 'table') {
      throw new FormulaCompileError('UNTYPED', 'Expected records.');
    }
    return value.type.kind === 'row'
      ? this.sets.ids(tableId, sql`ARRAY[${value.sql}]::text[]`)
      : this.sets.ids(tableId, value.sql);
  }

  private nestedValue(rows: RowSet, element: Compiled, type: FormulaType): Compiled {
    // No SQL value: `refuseNested` keeps it away from anything but its three consumers.
    const value: Compiled = { sql: nullOf(listOf(T.text)), type };
    this.nested.set(value, { rows, element });
    return value;
  }

  private target(model: TableModel, fieldId: string): Target {
    let targets = this.targets.get(model.table.id);
    if (targets === undefined) {
      targets = new Map<string, Target>();
      for (const field of model.fields) targets.set(field.id, { kind: 'field', field });
      for (const computed of this.cross.computed?.(model.table.id).values() ?? []) {
        targets.set(computed.id, { kind: 'computed', computed });
      }
      for (const link of model.links) targets.set(link.id, { kind: 'link', link });
      if (model.parent !== null) targets.set(model.parent.id, { kind: 'parent' });
      this.targets.set(model.table.id, targets);
    }
    const target = targets.get(fieldId);
    if (target === undefined) {
      throw new FormulaCompileError(
        'UNKNOWN_FIELD',
        `Field ${fieldId} is not in the model of ${model.table.id}.`,
      );
    }
    return target;
  }

  /** The value of a plain field of the record aliased `alias` (same rules as the formula's row). */
  private readField(field: FieldModel, alias: string, compiler: FormulaCompiler): Compiled {
    const node: Reference = {
      type: 'reference',
      name: field.name,
      id: field.id,
      kind: 'field',
      ...AT,
    };
    const type = fieldValueType({
      id: field.id,
      name: field.name,
      type: field.type,
      options: isRecord(field.row.options) ? field.row.options : null,
    });
    const { timeZone, now } = compiler.ctx;
    const reader = new FormulaCompiler({
      types: new Map([[node, type]]),
      fields: [field],
      timeZone,
      tableAlias: alias,
      ...(now === undefined ? {} : { now }),
    });
    return reader.compile(node);
  }

  /** A plain or computed field of the record aliased `alias`. */
  private readTarget(
    target: Extract<Target, { kind: 'field' | 'computed' }>,
    alias: string,
    compiler: FormulaCompiler,
  ): Compiled {
    return target.kind === 'computed'
      ? target.computed.read(alias, compiler)
      : this.readField(target.field, alias, compiler);
  }

  /** `CurrentValue.[Field]`: a field of the record of an iteration (its own columns). */
  private onRecord(
    rows: RowSet,
    fieldId: string,
    type: FormulaType,
    compiler: FormulaCompiler,
  ): Compiled {
    const model = rows.model;
    if (model === null) return { sql: nullOf(type), type };
    const target = this.target(model, fieldId);
    switch (target.kind) {
      case 'link':
        return this.rowsValue(this.sets.link(target.link, sql.id(rows.alias, '__id')), type);
      case 'parent':
        return this.rowsValue(
          this.sets.parent(rows.tableId, sql.id(rows.alias, PARENT_COLUMN)),
          type,
        );
      default:
        return this.readTarget(target, rows.alias, compiler);
    }
  }

  /** `FIRST([Link]).[Field]`: a field of one record given by its id. */
  private onOne(
    rows: RowSet,
    fieldId: string,
    type: FormulaType,
    compiler: FormulaCompiler,
  ): Compiled {
    const model = rows.model;
    if (model === null) return { sql: nullOf(type), type };
    const target = this.target(model, fieldId);
    switch (target.kind) {
      case 'link':
        return this.rowsValue(this.sets.chainLink(rows, target.link), type);
      case 'parent':
        return this.rowsValue(this.sets.chainParent(rows), type);
      default: {
        const value = this.readTarget(target, rows.alias, compiler);
        const out = sql`(${selectOver(rows, value.sql, { ordered: false, suffix: sql` LIMIT 1` })})`;
        return value.zone === undefined
          ? { sql: out, type: value.type }
          : { sql: out, type: value.type, zone: value.zone };
      }
    }
  }

  /** `rows.[Field]`: the column of every record, in order; links chain, multi-value fields nest. */
  private column(
    rows: RowSet,
    fieldId: string,
    type: FormulaType,
    compiler: FormulaCompiler,
  ): Compiled {
    const model = rows.model;
    if (model === null) {
      if (isNested(type))
        return this.nestedValue(rows, { sql: nullOf(T.text), type: T.text }, type);
      if (hasRows(type)) return this.rowsValue(rows, type);
      return { sql: emptyOf(type), type };
    }
    const target = this.target(model, fieldId);
    switch (target.kind) {
      case 'link':
        return this.rowsValue(this.sets.chainLink(rows, target.link), type);
      case 'parent':
        return this.rowsValue(this.sets.chainParent(rows), type);
      default: {
        const value = this.readTarget(target, rows.alias, compiler);
        if (value.type.kind === 'list') return this.nestedValue(rows, value, type);
        const out = sql`ARRAY(${selectOver(rows, value.sql)})`;
        return value.zone === undefined ? { sql: out, type } : { sql: out, type, zone: value.zone };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Titles

  /** Title of the record aliased `alias`: its primary field as text (`''` when empty). */
  private titleOf(model: TableModel, alias: string, compiler: FormulaCompiler): Sql {
    const primary = model.fields.find((field) => field.isPrimary);
    if (primary === undefined) return nullOf(T.text);
    const value = this.readField(primary, alias, compiler);
    if (value.type.kind === 'list') {
      const element = compiler.toText({ sql: sql`fe.v`, type: value.type.element });
      return sql`coalesce(array_to_string(ARRAY(SELECT ${element} FROM unnest(${value.sql}) WITH ORDINALITY AS fe(v, i) ORDER BY fe.i), ', '), '')`;
    }
    return sql`coalesce(${compiler.toText(value)}, '')`;
  }

  /** Title of a record value (NULL for no record). */
  private title(value: Compiled, compiler: FormulaCompiler): Sql {
    const record = this.current.get(value);
    if (record !== undefined && record.model !== null) {
      return this.titleOf(record.model, record.alias, compiler);
    }
    const rows = this.rowsOf(value);
    if (rows.model === null) return nullOf(T.text);
    const title = this.titleOf(rows.model, rows.alias, compiler);
    return sql`(${selectOver(rows, title, { ordered: false, suffix: sql` LIMIT 1` })})`;
  }

  /** Records as their titles: `text` for a record, `list<text>` for records. */
  private titles(value: Compiled, compiler: FormulaCompiler): Compiled {
    if (value.type.kind === 'row') return { sql: this.title(value, compiler), type: T.text };
    const rows = this.rowsOf(value);
    if (rows.model === null) return { sql: emptyOf(listOf(T.text)), type: listOf(T.text) };
    const title = this.titleOf(rows.model, rows.alias, compiler);
    return { sql: sql`ARRAY(${selectOver(rows, title)})`, type: listOf(T.text) };
  }

  // ---------------------------------------------------------------------------
  // Iteration over records

  private iterate(node: Call, compiler: FormulaCompiler): Compiled {
    const [subjectNode] = node.args;
    if (subjectNode === undefined) throw new FormulaCompileError('UNTYPED', 'Missing records.');
    const rows = this.rowsOf(compiler.compile(subjectNode));
    const type = compiler.typeOf(node);
    if (rows.model === null) {
      switch (node.name) {
        case 'FILTER':
        case 'SORTBY':
          return this.rowsValue(rows, type);
        case 'COUNTIF':
        case 'SUMIF':
          return { sql: numberParam('0'), type };
        default:
          return this.column(rows, '', type, compiler);
      }
    }
    const current: Compiled = { sql: sql.id(rows.alias, '__id'), type: rowOf(rows.tableId) };
    this.current.set(current, rows);
    const inRecord = (index: number): Compiled => {
      const arg = node.args[index];
      if (arg === undefined)
        throw new FormulaCompileError('UNTYPED', `Missing argument ${String(index + 1)}.`);
      return compiler.withCurrent(current, () => compiler.compile(arg));
    };
    // Top-level `&&` terms become separate WHERE items: an EXISTS term stays bare
    // (not under coalesce), so the planner can turn it into a semi-join.
    const condition = (index: number): Sql => {
      const arg = node.args[index];
      if (arg === undefined) throw new FormulaCompileError('UNTYPED', 'Missing condition.');
      const terms = conjuncts(arg).map((term) => {
        const value = compiler.withCurrent(current, () => compiler.compile(term));
        return this.twoValued.has(value) ? value.sql : truthy(compiler.as(value, T.boolean));
      });
      return conjunction(terms);
    };
    switch (node.name) {
      case 'FILTER':
        return this.rowsValue({ ...rows, where: [...rows.where, condition(1)] }, type);
      case 'COUNTIF':
        return {
          sql: sql`CAST((${selectOver(rows, sql`count(*)`, { where: [condition(1)], ordered: false })}) AS numeric)`,
          type,
        };
      case 'SUMIF': {
        const value = compiler.as(inRecord(2), T.number);
        return {
          sql: sql`(${selectOver(rows, sql`coalesce(sum(${value}), 0)`, { where: [condition(1)], ordered: false })})`,
          type,
        };
      }
      case 'MAP': {
        const mapped = inRecord(1);
        if (mapped.type.kind === 'list') return this.nestedValue(rows, mapped, type);
        const element = compiler.as(mapped, elementOfType(type));
        return { sql: sql`ARRAY(${selectOver(rows, element)})`, type };
      }
      default:
        return this.rowsValue(this.sortBy(node, rows, compiler, inRecord), type);
    }
  }

  /**
   * SORTBY: by one value per record (`CurrentValue.[Field]`, or Lark's
   * `[Table].[Field]` of the sorted table), ascending unless the third
   * argument is FALSE; empty values last, ties in the previous order (as SORT).
   */
  private sortBy(
    node: Call,
    rows: RowSet,
    compiler: FormulaCompiler,
    inRecord: (index: number) => Compiled,
  ): RowSet {
    const by = node.args[1];
    const sameTable =
      by?.type === 'member' &&
      by.object.type === 'reference' &&
      by.object.kind === 'table' &&
      by.object.id === rows.tableId &&
      by.property.id !== null;
    let key: Compiled;
    if (sameTable && rows.model !== null) {
      const target = this.target(rows.model, by.property.id as string);
      if (target.kind !== 'field' && target.kind !== 'computed') {
        throw new FormulaCompileError('UNSUPPORTED_TYPE', 'SORTBY needs one value per record.');
      }
      key = this.readTarget(target, rows.alias, compiler);
    } else {
      key = inRecord(1);
    }
    if (key.type.kind === 'row') key = { sql: this.title(key, compiler), type: T.text };
    const ascending =
      node.args.length > 2
        ? sql`coalesce(${compiler.as(inRecord(2), T.boolean)}, true)`
        : sql`true`;
    return {
      ...rows,
      order: [
        sql`CASE WHEN ${ascending} THEN ${key.sql} END ASC NULLS LAST`,
        sql`CASE WHEN NOT ${ascending} THEN ${key.sql} END DESC NULLS LAST`,
        ...rows.order,
      ],
    };
  }

  /**
   * LOOKUP(value, [T].[M], [T].[R], mode) ≡ `[T].FILTER(CurrentValue.[M] = value).[R]`
   * (`CONTAIN` for a multi-value `M` in mode 1), SPEC §9.3.
   */
  private lookup(node: Call, compiler: FormulaCompiler): Compiled {
    const parts = lookupParts(node.args);
    const [valueNode] = node.args;
    if (parts === null || valueNode === undefined) {
      throw new FormulaCompileError('UNTYPED', 'Malformed LOOKUP.');
    }
    const type = compiler.typeOf(node);
    const rows = this.sets.table(parts.tableId);
    if (rows.model === null) return this.column(rows, parts.resultFieldId, type, compiler);
    const value = compiler.compile(valueNode);
    const matchType = this.fieldType(rows.model, parts.matchFieldId);
    const match = this.onRecord(rows, parts.matchFieldId, matchType, compiler);
    const condition =
      matchType.kind === 'list' && parts.mode === 1
        ? this.containSql('CONTAIN', match, [value], compiler)
        : compiler.equals(match, value);
    // `equals` and `containSql` are two-valued: no coalesce around the EXISTS.
    const filtered: RowSet = { ...rows, where: [...rows.where, condition] };
    return this.column(filtered, parts.resultFieldId, type, compiler);
  }

  private fieldType(model: TableModel, fieldId: string): FormulaType {
    const target = this.target(model, fieldId);
    switch (target.kind) {
      case 'link':
        return listOf(rowOf(target.link.targetTableId));
      case 'parent':
        return listOf(rowOf(model.table.id));
      case 'computed':
        return target.computed.type;
      default:
        return fieldValueType({
          id: target.field.id,
          name: target.field.name,
          type: target.field.type,
          options: isRecord(target.field.row.options) ? target.field.row.options : null,
        });
    }
  }

  // ---------------------------------------------------------------------------
  // Functions over records

  /** FIRST, LAST, NTH of records: one record id. */
  private pick(node: Call, compiler: FormulaCompiler): Compiled {
    const [subjectNode, positionNode] = node.args;
    if (subjectNode === undefined) throw new FormulaCompileError('UNTYPED', 'Missing records.');
    const type = compiler.typeOf(node);
    const rows = this.rowsOf(compiler.compile(subjectNode));
    if (rows.model === null) return { sql: nullOf(type), type };
    const id = sql.id(rows.alias, '__id');
    switch (node.name) {
      case 'FIRST':
        return { sql: sql`(${selectOver(rows, id, { suffix: sql` LIMIT 1` })})`, type };
      case 'LAST':
        return {
          sql: sql`(SELECT fe.v[cardinality(fe.v)] FROM (SELECT ARRAY(${selectOver(rows, id)}) AS v) AS fe)`,
          type,
        };
      default: {
        if (positionNode === undefined)
          throw new FormulaCompileError('UNTYPED', 'NTH needs a position.');
        const k = sql`fx.int_arg(${compiler.as(compiler.compile(positionNode), T.number)})`;
        return {
          sql: sql`(CASE WHEN ${k} >= 1 THEN (${selectOver(rows, id, { suffix: sql` OFFSET ${k} - 1 LIMIT 1` })}) END)`,
          type,
        };
      }
    }
  }

  /** ARRAYJOIN of records: their titles joined by the separator (", " by default). */
  private arrayJoin(node: Call, compiler: FormulaCompiler): Compiled {
    const [subjectNode, separatorNode] = node.args;
    if (subjectNode === undefined) throw new FormulaCompileError('UNTYPED', 'Missing records.');
    const rows = this.rowsOf(compiler.compile(subjectNode));
    const separator =
      separatorNode === undefined
        ? textParam(', ')
        : compiler.toText(compiler.compile(separatorNode));
    if (rows.model === null) return { sql: sql`''`, type: T.text };
    const title = this.titleOf(rows.model, rows.alias, compiler);
    const order = rows.order.length > 0 ? sql` ORDER BY ${sql.join(rows.order)}` : sql``;
    const aggregate = sql`string_agg(${title}, ${separator}${order})`;
    return {
      sql: sql`coalesce((${selectOver(rows, aggregate, { ordered: false })}), '')`,
      type: T.text,
    };
  }

  private contain(node: Call, compiler: FormulaCompiler): Compiled {
    const values = node.args.map((arg) => compiler.compile(arg));
    const [range, ...rest] = values;
    if (range === undefined) throw new FormulaCompileError('UNTYPED', 'Missing range.');
    const out: Compiled = {
      sql: this.containSql(node.name, range, rest, compiler, node.exact === true),
      type: T.boolean,
    };
    this.twoValued.add(out);
    return out;
  }

  /**
   * CONTAIN/CONTAINSALL/CONTAINSONLY when records are involved. Records
   * match records and `RECORD_ID()` of their table by id, other texts by
   * title (case-folded when `containFoldsCase`, SPEC §9.4); values that are
   * lists count element by element; empty values never match (as the
   * same-row arrays: `&&`, `@>`).
   */
  containSql(
    name: string,
    range: Compiled,
    values: readonly Compiled[],
    compiler: FormulaCompiler,
    exact = false,
  ): Sql {
    const rangeTable = rowsTable(range.type);
    if (rangeTable === null) return this.containInValues(name, range, values, compiler, exact);
    const rows = this.rowsOf(range);
    const ids: Compiled[] = [];
    const titles: Compiled[] = [];
    for (const value of values) {
      const element = elementOf(value.type);
      if (
        element.kind === 'row' ||
        (element.kind === 'text' && element.recordIdOf === rangeTable)
      ) {
        ids.push(asIds(value));
      } else {
        titles.push(value);
      }
    }
    const folds = !exact && containFoldsCase([range.type, ...values.map((value) => value.type)]);
    const idArray = compiler.combine(ids, T.text);
    const titleArray = folds
      ? foldAll(compiler.combine(titles, T.text))
      : compiler.combine(titles, T.text);
    if (rows.model === null) {
      if (name === 'CONTAINSALL') {
        return sql`(cardinality(${idArray}) + cardinality(${titleArray}) = 0)`;
      }
      return sql`false`;
    }
    const alias = rows.alias;
    const id = sql.id(alias, '__id');
    const plainTitle = titles.length === 0 ? null : this.titleOf(rows.model, alias, compiler);
    const title = plainTitle !== null && folds ? fold(plainTitle) : plainTitle;
    const matchesOne = (value: Compiled, byId: boolean): Sql => {
      const subject = byId ? id : (title as Sql);
      const folded = !byId && folds;
      if (value.type.kind === 'list') {
        const list = nonNullList(value);
        return sql`${subject} = ANY(${folded ? foldAll(list) : list})`;
      }
      const text = compiler.as(value, T.text);
      return sql`${subject} = ${folded ? fold(text) : text}`;
    };
    const alternatives = [
      ...ids.map((value) => matchesOne(value, true)),
      ...titles.map((value) => matchesOne(value, false)),
    ];
    // NULL counts as no match inside WHERE; no coalesce, so `= id` stays indexable.
    const match =
      alternatives.length === 0 ? sql`false` : sql`(${sql.join(alternatives, sql` OR `)})`;
    const exists = (where: readonly Sql[]) =>
      sql`EXISTS (${selectOver(rows, sql`1`, { where, ordered: false })})`;
    switch (name) {
      case 'CONTAIN':
        return exists([match]);
      case 'CONTAINSONLY':
        return sql`(${exists([])} AND NOT ${exists([sql`NOT coalesce(${match}, false)`])})`;
      default: {
        // Every value element is some record: one EXISTS per element.
        const every = (array: Sql, subject: Sql) => {
          const element = this.sets.alias('fe');
          return sql`NOT EXISTS (SELECT 1 FROM unnest(${array}) AS ${sql.id(element)}(v) WHERE NOT ${exists([sql`${subject} = ${sql.id(element, 'v')}`])})`;
        };
        const parts: Sql[] = [every(idArray, id)];
        if (title !== null) parts.push(every(titleArray, title));
        return sql`(${sql.join(parts, sql` AND `)})`;
      }
    }
  }

  /** A range of plain values with records among the values: records become titles (or ids). */
  private containInValues(
    name: string,
    range: Compiled,
    values: readonly Compiled[],
    compiler: FormulaCompiler,
    exact: boolean,
  ): Sql {
    const rangeElement = elementOf(range.type);
    const converted = values.map((value) => {
      const table = rowsTable(value.type);
      if (table === null) return value;
      return rangeElement.kind === 'text' && rangeElement.recordIdOf === table
        ? asIds(value)
        : this.titles(value, compiler);
    });
    const folds = !exact && containFoldsCase([range.type, ...values.map((value) => value.type)]);
    const plainRange = compiler.asArray(range, T.text);
    const plainValues = compiler.combine(converted, T.text);
    const rangeArray = folds ? foldAll(plainRange) : plainRange;
    const valueArray = folds ? foldAll(plainValues) : plainValues;
    switch (name) {
      case 'CONTAIN':
        return sql`(coalesce(${rangeArray} && ${valueArray}, false))`;
      case 'CONTAINSALL':
        return sql`(coalesce(${rangeArray} @> ${valueArray}, false))`;
      default:
        return sql`(coalesce(cardinality(${rangeArray}) > 0 AND ${valueArray} @> ${rangeArray}, false))`;
    }
  }

  // ---------------------------------------------------------------------------
  // Lists of lists

  private nestedCall(node: Call, compiler: FormulaCompiler): Compiled {
    const type = compiler.typeOf(node);
    const values = node.args.map((arg) => compiler.compile(arg));
    switch (node.name) {
      case 'LISTCOMBINE': {
        const element = elementOfType(type);
        const arrays = values.map((value) => {
          const nested = this.nested.get(value);
          return nested === undefined
            ? compiler.asArray(value, element)
            : this.flatten(nested, element, compiler);
        });
        return { sql: sql`(${sql.join(arrays, sql` || `)})`, type };
      }
      case 'COUNTA': {
        const counts = values.map((value) => {
          const nested = this.nested.get(value);
          if (nested !== undefined) {
            if (nested.rows.model === null) return sql`0`;
            return sql`(${selectOver(nested.rows, sql`count(*)`, { where: [sql`NOT ${compiler.blank(nested.element)}`], ordered: false })})`;
          }
          if (value.type.kind !== 'list') {
            return sql`(CASE WHEN ${compiler.blank(value)} THEN 0 ELSE 1 END)`;
          }
          const element = { sql: sql`fe.v`, type: value.type.element };
          return sql`(SELECT count(*) FROM unnest(${nonNullList(value)}) AS fe(v) WHERE NOT ${compiler.blank(element)})`;
        });
        return { sql: sql`CAST(${sql.join(counts, sql` + `)} AS numeric)`, type };
      }
      default: {
        const [value] = values;
        const nested = value === undefined ? undefined : this.nested.get(value);
        if (nested === undefined)
          throw new FormulaCompileError('UNTYPED', 'ISBLANK of a list of lists.');
        if (nested.rows.model === null) return { sql: sql`true`, type };
        return {
          sql: sql`(NOT EXISTS (${selectOver(nested.rows, sql`1`, { ordered: false })}))`,
          type,
        };
      }
    }
  }

  /** LISTCOMBINE of a list of lists: the elements of every record's list, in order. */
  private flatten(nested: Nested, element: FormulaType, compiler: FormulaCompiler): Sql {
    const rows = nested.rows;
    if (rows.model === null) return emptyOf(listOf(element));
    const alias = this.sets.alias('fe');
    const list = compiler.as(nested.element, listOf(element));
    const order = sql.join([...rows.order, sql.id(alias, 'i')]);
    return sql`ARRAY(SELECT ${sql.id(alias, 'v')} FROM ${rows.from} CROSS JOIN LATERAL unnest(${list}) WITH ORDINALITY AS ${sql.id(alias)}(v, i) WHERE ${conjunction(rows.where)} ORDER BY ${order})`;
  }
}

/** Top-level terms of `a && b && AND(c, d)` (the typecheck typed each one boolean). */
function conjuncts(node: Expr): Expr[] {
  if (node.type === 'binary' && node.operator === '&&') {
    return [...conjuncts(node.left), ...conjuncts(node.right)];
  }
  if (node.type === 'call' && node.name === 'AND') return node.args.flatMap(conjuncts);
  return [node];
}

/** Records as their ids: `text` for a record, `list<text>` for records (same SQL). */
function asIds(value: Compiled): Compiled {
  if (value.type.kind === 'row') return { sql: value.sql, type: T.text };
  if (value.type.kind === 'list' && value.type.element.kind === 'row') {
    return { sql: value.sql, type: listOf(T.text) };
  }
  return value;
}
