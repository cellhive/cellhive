import {
  createEvaluator,
  resolveVariables,
  validateFilter,
  type EvaluateRecord,
  type FilterTableMeta,
} from '@cellhive/filter-dsl';
import { colorRuleFieldIds } from '@cellhive/server-core';

import type { Id, RecordColorDto, StoredColorRule } from '@cellhive/contracts';

/**
 * Color rules in realtime record messages (T816, CONTRACTS §7): the rules of
 * the subscribed view that apply to a subscriber group — enabled, every
 * filter field one they read (locked computed fields excluded) and the cell
 * field visible, exactly as `records/query` decides for them — evaluated on
 * the image after the change (`@cellhive/filter-dsl`, no database read).
 */

/** A color rule compiled for one group. */
export interface CompiledColorRule {
  readonly id: string;
  readonly target: 'row' | 'cell';
  readonly fieldId: string | null;
  readonly matches: (image: EvaluateRecord) => boolean;
}

/**
 * The rules of `rules` that apply to a subscriber who reads `seen` (visible
 * fields without locked computed ones) and sees the cells of `cells`.
 */
export function subscriberColorRules(
  rules: readonly StoredColorRule[] | undefined,
  seen: ReadonlySet<string>,
  cells: ReadonlySet<string>,
): StoredColorRule[] {
  if (rules === undefined || rules.length === 0) return [];
  return rules.filter((rule) => {
    if (!rule.enabled) return false;
    if (rule.target === 'cell' && (rule.field_id === null || !cells.has(rule.field_id))) {
      return false;
    }
    for (const id of colorRuleFieldIds({ filter: rule.filter, field_id: null })) {
      if (!seen.has(id)) return false;
    }
    return true;
  });
}

export interface ColorRuleVariables {
  readonly userId: Id<'usr'>;
  readonly groupMemberUserIds: readonly Id<'usr'>[];
  readonly timeZone: string;
  readonly now: Date;
}

/**
 * `rules` compiled against the fields of an envelope: a rule whose filter
 * does not validate (it names a field gone since) is skipped, like
 * `records/query` skips it.
 */
export function compileColorRules(
  rules: readonly StoredColorRule[],
  table: FilterTableMeta,
  fieldIds: readonly string[],
  variables: ColorRuleVariables,
): CompiledColorRule[] {
  const compiled: CompiledColorRule[] = [];
  for (const rule of rules) {
    const base = {
      id: rule.id,
      target: rule.target,
      fieldId: rule.target === 'cell' ? rule.field_id : null,
    };
    if (rule.filter === null) {
      compiled.push({ ...base, matches: () => true });
      continue;
    }
    const validated = validateFilter(rule.filter, table, fieldIds);
    if (!validated.ok) continue;
    try {
      const evaluate = createEvaluator(resolveVariables(validated.ast, variables), {
        table,
        timeZone: variables.timeZone,
      });
      compiled.push({
        ...base,
        matches: (image) => {
          try {
            return evaluate(image);
          } catch {
            return false;
          }
        },
      });
    } catch {
      // Not evaluable in memory: never colors (records/query decides on refetch).
    }
  }
  return compiled;
}

/** `meta.color` of an image: the first matching row rule and cell rule per field. */
export function colorOfImage(
  rules: readonly CompiledColorRule[],
  image: EvaluateRecord,
): RecordColorDto {
  const color: { row?: Id<'clr'>; cells?: Record<Id<'fld'>, Id<'clr'>> } = {};
  for (const rule of rules) {
    if (rule.target === 'row') {
      if (color.row === undefined && rule.matches(image)) color.row = rule.id as Id<'clr'>;
      continue;
    }
    const fieldId = rule.fieldId as Id<'fld'> | null;
    if (fieldId === null || color.cells?.[fieldId] !== undefined) continue;
    if (!rule.matches(image)) continue;
    color.cells ??= {};
    color.cells[fieldId] = rule.id as Id<'clr'>;
  }
  return color;
}
