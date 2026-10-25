import { resolveVariables, validateFilter, type ResolveContext } from '@cellhive/filter-dsl';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { compileToSql, type SqlFilterTableMeta } from '../../query/index.js';

import { colorRuleFieldIds } from './config.js';

import type { RecordColorOutput } from '../types.js';
import type { Id, StoredColorRule } from '@cellhive/contracts';

/**
 * Color rules evaluated by the record query (T816, S7 decision #21): each
 * rule that applies to the reader becomes one boolean column of the page's
 * `SELECT` (its filter compiled by `compileToSql`, like a view filter — no
 * SQL from input), and each record gets `meta.color` from the first
 * matching rule of its row and of each cell.
 *
 * A rule applies to a reader when it is enabled and every field it names
 * (filter and cell) is one they read — through a share link, one in the
 * link's scope —, a computed field not locked for them nor in error (T457),
 * and its filter validates against the table as it is now. Anything else is
 * skipped for that reader, without error: a rule on a hidden field would
 * otherwise reveal its values ("red row = cost > X"), and a rule naming a
 * deleted field is broken until saved again.
 */

/** One rule of a page read: its id, what it colors, and its result column. */
export interface ColorRuleColumn {
  readonly id: Id<'clr'>;
  readonly target: 'row' | 'cell';
  readonly fieldId: Id<'fld'> | null;
  /** Alias of its boolean column (code constant + index, never input). */
  readonly key: string;
  readonly match: RawBuilder<SqlBool>;
}

/** The rules of a view that apply to a reader, in priority order. */
export interface ColorRulePlan {
  readonly columns: readonly ColorRuleColumn[];
}

export interface ColorRuleReader {
  /** Fields the reader may filter on (readable, not locked, not in error). */
  readonly filterable: ReadonlySet<string>;
  /** Fields whose cells the reader reads (cell targets). */
  readonly cells: ReadonlySet<string>;
  /** Filter meta of the table (every active field, links included). */
  readonly filterMeta: SqlFilterTableMeta;
  /** Variables and dates of the read (`current_user`, `$date`…). */
  readonly context: ResolveContext;
  /** Alias of the data table in the statement. */
  readonly tableAlias: string;
}

const MATCH_ALL = sql<SqlBool>`true`;

/** Column alias of the `index`-th applicable rule. */
const columnKey = (index: number) => `__color_${String(index)}`;

/**
 * The rules of `rules` that apply to `reader`, compiled; `null` when none
 * does (records then carry no `meta`).
 */
export function colorRulePlan(
  rules: readonly StoredColorRule[] | undefined,
  reader: ColorRuleReader,
): ColorRulePlan | null {
  if (rules === undefined || rules.length === 0) return null;
  const columns: ColorRuleColumn[] = [];
  for (const rule of rules) {
    const match = compileRule(rule, reader);
    if (match === null) continue;
    columns.push({
      id: rule.id as Id<'clr'>,
      target: rule.target,
      fieldId: rule.target === 'cell' ? (rule.field_id as Id<'fld'> | null) : null,
      key: columnKey(columns.length),
      match,
    });
  }
  return columns.length === 0 ? null : { columns };
}

function compileRule(rule: StoredColorRule, reader: ColorRuleReader): RawBuilder<SqlBool> | null {
  if (!rule.enabled) return null;
  if (rule.target === 'cell' && (rule.field_id === null || !reader.cells.has(rule.field_id))) {
    return null;
  }
  const named = colorRuleFieldIds({ filter: rule.filter, field_id: null });
  for (const id of named) if (!reader.filterable.has(id)) return null;
  if (rule.filter === null) return MATCH_ALL;
  const validated = validateFilter(rule.filter, reader.filterMeta, reader.filterable);
  if (!validated.ok) return null;
  try {
    return compileToSql(resolveVariables(validated.ast, reader.context), reader.filterMeta, {
      tableAlias: reader.tableAlias,
    });
  } catch {
    // An operator or type without SQL support: skipped like an invalid rule.
    return null;
  }
}

/** The extra `SELECT` items of a page read: one boolean per applicable rule. */
export function colorRuleSelect(plan: ColorRulePlan | null): RawBuilder<unknown>[] {
  if (plan === null) return [];
  return plan.columns.map((column) => sql`(${column.match}) IS TRUE AS ${sql.id(column.key)}`);
}

/**
 * `meta.color` of one row of the page: the first matching row rule, and per
 * cell field the first matching cell rule. `{}` when nothing matches.
 */
export function colorOfRow(
  plan: ColorRulePlan,
  row: Readonly<Record<string, unknown>>,
): RecordColorOutput {
  let rowRule: Id<'clr'> | undefined;
  let cells: Record<Id<'fld'>, Id<'clr'>> | undefined;
  for (const column of plan.columns) {
    if (row[column.key] !== true) continue;
    if (column.target === 'row') {
      rowRule ??= column.id;
    } else if (column.fieldId !== null && cells?.[column.fieldId] === undefined) {
      cells ??= {};
      cells[column.fieldId] = column.id;
    }
  }
  const color: { row?: Id<'clr'>; cells?: Record<Id<'fld'>, Id<'clr'>> } = {};
  if (rowRule !== undefined) color.row = rowRule;
  if (cells !== undefined) color.cells = cells;
  return color;
}
