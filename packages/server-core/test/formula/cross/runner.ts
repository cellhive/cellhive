/**
 * Compiles and runs the cross-table cases (BACKLOG T455) on the base of
 * `base.ts`: formulas through `analyze` + `compileCrossAnalysis`, lookups
 * through `compileLookup`, each `SELECT`ed on the case's record.
 */
import { resolveVariables, validateFilter, type FilterNode } from '@cellhive/filter-dsl';
import {
  analyze,
  type LookupCondition,
  type LookupOptions,
  type LookupWhere,
  FormulaType,
} from '@cellhive/formula-engine';
import { sql } from 'kysely';

import {
  compileCrossAnalysis,
  compileLookup,
  type CrossFormulaContext,
  type CrossTableContext,
} from '../../../src/formula/cross/index.js';
import { ruleSql, type TableModel } from '../../../src/records/table-model.js';

import { rid, STATUSES, type CrossBase, type TableName } from './base.js';

import type { CrossCase, LookupWhereSpec, ScopeName } from './cases.js';
import type { CompiledFormula, Sql } from '../../../src/formula/index.js';
import type { AnyKysely } from '../harness.js';

export const TZ = 'Asia/Ho_Chi_Minh';
export const NOW = new Date('2026-09-28T03:00:00.000Z');

function scopeRule(base: CrossBase, name: ScopeName): FilterNode {
  if (name === 'paid') {
    const paid = STATUSES.find((item) => item.name === 'Paid')?.id as string;
    return { field: base.field('Orders', 'Status').id, operator: 'is', value: paid };
  }
  return { field: base.field('Customers', 'City').id, operator: 'eq', value: 'HCM' };
}

/** `sourceScope` of a case: its read rules compiled like a role's record rule. */
export function scopeOf(
  base: CrossBase,
  scope: CrossCase['scope'],
): CrossTableContext['sourceScope'] {
  if (scope === undefined) return undefined;
  const byTable = new Map<string, FilterNode>();
  for (const [table, name] of Object.entries(scope) as [TableName, ScopeName][]) {
    byTable.set(base.tables[table].id, scopeRule(base, name));
  }
  return (tableId: string, alias: string): Sql | null => {
    const rule = byTable.get(tableId);
    const model = base.models.get(tableId);
    if (rule === undefined || model === undefined) return null;
    const validated = validateFilter(
      rule,
      model.filterMeta,
      model.fields.map((field) => field.id),
    );
    if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
    const resolved = resolveVariables(validated.ast, {
      userId: null,
      groupMemberUserIds: [],
      timeZone: TZ,
      now: NOW,
    });
    return ruleSql(resolved, model, alias);
  };
}

function lookupWhere(base: CrossBase, from: TableName, spec: LookupWhereSpec): LookupWhere {
  if ('op' in spec)
    return { op: spec.op, items: spec.items.map((item) => lookupWhere(base, from, item)) };
  const field = base.field(from, spec.field);
  const operand = (value: unknown): unknown => {
    if (typeof value === 'object' && value !== null && 'ref' in value) {
      const ref = (value as { ref: string }).ref;
      return { field_ref: ref === '__id' ? '__id' : base.field('Customers', ref).id };
    }
    if (field.type === 'select' && typeof value === 'string') {
      const options = (field.options as { options: { id: string; name: string }[] }).options;
      return options.find((option) => option.name === value)?.id ?? value;
    }
    return value;
  };
  const value =
    spec.value === undefined
      ? undefined
      : Array.isArray(spec.value)
        ? spec.value.map(operand)
        : operand(spec.value);
  const condition: LookupCondition = { field: field.id, operator: spec.operator };
  if (value !== undefined) condition.value = value as LookupCondition['value'];
  return condition;
}

export function crossContext(
  base: CrossBase,
  table: TableName,
  scope: CrossCase['scope'],
): CrossTableContext {
  const self = base.models.get(base.tables[table].id) as TableModel;
  const sourceScope = scopeOf(base, scope);
  return {
    self,
    table: (tableId) => base.models.get(tableId) ?? null,
    ...(sourceScope === undefined ? {} : { sourceScope }),
  };
}

/** Compiles a case; throws on analysis errors. */
export function compileCrossCase(
  base: CrossBase,
  item: CrossCase,
  tableAlias: string | undefined,
): CompiledFormula {
  const ctx: CrossFormulaContext = {
    timeZone: TZ,
    now: NOW,
    ...(tableAlias === undefined ? {} : { tableAlias }),
  };
  const cross = crossContext(base, item.table, item.scope);
  const snapshot = base.snapshot(item.table);
  if (item.lookup !== undefined) {
    const spec = item.lookup;
    const options: LookupOptions = {
      from: base.tables[spec.from].id,
      select: base.field(spec.from, spec.select).id,
      where: lookupWhere(base, spec.from, spec.where),
      ...(spec.aggregate === undefined ? {} : { aggregate: spec.aggregate }),
    };
    return compileLookup(options, snapshot, ctx, cross);
  }
  const analysis = analyze(item.formula ?? '', snapshot, { form: 'display' });
  if (analysis.errors.length > 0) {
    throw new Error(analysis.errors.map((error) => `${error.code} ${error.message}`).join('; '));
  }
  return compileCrossAnalysis(analysis, ctx, cross);
}

const isCalendar = (type: FormulaType): boolean => {
  const kind = type.kind === 'list' ? type.element.kind : type.kind;
  return kind === 'date' || kind === 'datetime';
};

/** The value of a compiled case on its record (`tableAlias` as compiled; none = table name). */
export async function selectCrossValue(
  db: AnyKysely,
  base: CrossBase,
  item: CrossCase,
  compiled: CompiledFormula,
  tableAlias: string | undefined,
): Promise<unknown> {
  const table = sql.id('data', base.tables[item.table].db_table_name);
  const from = tableAlias === undefined ? table : sql`${table} AS ${sql.id(tableAlias)}`;
  const id =
    tableAlias === undefined
      ? sql.id(base.tables[item.table].db_table_name, '__id')
      : sql.id(tableAlias, '__id');
  const value = isCalendar(compiled.type) ? sql`to_json(${compiled.sql})::text` : compiled.sql;
  const { rows } = await sql<{
    v: unknown;
  }>`SELECT ${value} AS v FROM ${from} WHERE ${id} = ${rid(item.record)}`.execute(db);
  const out = rows[0]?.v;
  return isCalendar(compiled.type) && typeof out === 'string' ? (JSON.parse(out) as unknown) : out;
}
