import {
  COLOR_RULE_COLORS,
  MAX_COLOR_RULES,
  newId,
  type ColorRuleColor,
  type ColorRuleTarget,
  type FieldDto,
  type StoredColorRule,
} from '@cellhive/contracts';

import { stableQueryHash } from '../../../lib/query/keys';
import {
  checkFilter,
  conditionCount,
  fromFilter,
  type CheckedFilter,
  type GroupItem,
} from '../toolbar/filter-model';

import type { ViewColorRule } from '../../../lib/views/config';

/**
 * The color rules editor's model (T816, FRONTEND §6.9): the rules of a grid
 * view as the panel edits them — each with its condition tree of the view
 * filter builder (T311) — and the `color_rules` they save (CONTRACTS §15).
 * The client never evaluates a rule: the server colors the records.
 */

export interface EditorRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly color: ColorRuleColor;
  readonly target: ColorRuleTarget;
  /** The colored cell's field (`target: cell`). */
  readonly fieldId: string | null;
  /** The condition tree being edited. */
  readonly root: GroupItem;
  /**
   * The rule's filter as the server returned it, sent back unchanged while
   * the conditions are not edited (a broken rule keeps its conditions on
   * deleted fields: the server keeps a rule sent back as it read it).
   */
  readonly saved: Record<string, unknown> | null;
  /** The conditions were edited in this panel: {@link root} is sent. */
  readonly edited: boolean;
  /** The rule names a deleted field (`broken` of the response). */
  readonly broken: boolean;
}

/** The editor's rules of a view config's `color_rules`. */
export function editorRulesOf(rules: readonly ViewColorRule[] | undefined): EditorRule[] {
  return (rules ?? []).map((rule) => ({
    id: rule.id,
    enabled: rule.enabled,
    color: rule.color,
    target: rule.target,
    fieldId: rule.field_id,
    root: fromFilter(rule.filter ?? null),
    saved: rule.filter ?? null,
    edited: false,
    broken: rule.broken === true,
  }));
}

/**
 * The editor's rules of new `color_rules` (another tab, a refused save, the
 * server's form of what was sent). A rule whose conditions build the same
 * filter as in the editor keeps its condition tree, so the builder's
 * items (and the focus in them) stay; the server form is what it sends back.
 */
export function mergeEditorRules(
  current: readonly EditorRule[],
  incoming: readonly ViewColorRule[] | undefined,
  filterable: readonly FieldDto[],
): EditorRule[] {
  const byId = new Map(current.map((rule) => [rule.id, rule]));
  const built = (root: GroupItem) => stableQueryHash(checkFilter(root, filterable).filter);
  return editorRulesOf(incoming).map((rule) => {
    const mine = byId.get(rule.id);
    return mine !== undefined && built(mine.root) === built(rule.root)
      ? { ...rule, root: mine.root }
      : rule;
  });
}

/** The next palette color nobody uses yet (red first), else red. */
export function nextColor(rules: readonly EditorRule[]): ColorRuleColor {
  const used = new Set(rules.map((rule) => rule.color));
  return COLOR_RULE_COLORS.find((color) => !used.has(color)) ?? 'red';
}

/** A new enabled row rule without condition, appended (lowest priority). */
export function newRule(rules: readonly EditorRule[]): EditorRule {
  return {
    id: newId('clr'),
    enabled: true,
    color: nextColor(rules),
    target: 'row',
    fieldId: null,
    root: fromFilter(null),
    saved: null,
    edited: true,
    broken: false,
  };
}

export function canAddRule(rules: readonly EditorRule[]): boolean {
  return rules.length < MAX_COLOR_RULES;
}

/** `rules` with the rule `from` moved to index `to` (clamped): order = priority. */
export function moveRule(rules: readonly EditorRule[], from: number, to: number): EditorRule[] {
  const next = [...rules];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(Math.min(Math.max(to, 0), next.length), 0, moved);
  return next;
}

/** Issues of one rule: its conditions (by builder item), a missing cell field. */
export interface RuleCheck {
  readonly filter: CheckedFilter | null;
  readonly missingField: boolean;
  /** Conditions not complete yet: nothing is saved meanwhile. */
  readonly incomplete: boolean;
}

export interface BuiltRules {
  /** The `color_rules` to save; `null` while a rule has an issue or an incomplete condition. */
  readonly rules: StoredColorRule[] | null;
  readonly checks: ReadonlyMap<string, RuleCheck>;
}

/**
 * Converts the editor's rules to `color_rules`, checked like the view filter
 * (`checkFilter`: the same validation the server runs). A rule whose
 * conditions were not edited sends the filter the server returned.
 */
export function buildRules(
  rules: readonly EditorRule[],
  filterable: readonly FieldDto[],
): BuiltRules {
  const checks = new Map<string, RuleCheck>();
  const out: StoredColorRule[] = [];
  let valid = true;
  for (const rule of rules) {
    const checked = rule.edited ? checkFilter(rule.root, filterable) : null;
    // A broken cell rule reads `field_id: null` (deleted field): sent back as read.
    const missingField = rule.target === 'cell' && rule.fieldId === null && !rule.broken;
    // Built in the panel, a rule needs a condition (one without would color every record
    // the moment it is added); a rule without one made through the API stays as it is.
    const incomplete =
      checked !== null && (checked.incomplete.size > 0 || conditionCount(rule.root) === 0);
    checks.set(rule.id, { filter: checked, missingField, incomplete });
    if (missingField || incomplete || (checked !== null && checked.issues.size > 0)) {
      valid = false;
      continue;
    }
    out.push({
      id: rule.id,
      enabled: rule.enabled,
      filter: checked === null ? rule.saved : (checked.filter as Record<string, unknown> | null),
      color: rule.color,
      target: rule.target,
      field_id: rule.target === 'cell' ? rule.fieldId : null,
    });
  }
  return { rules: valid ? out : null, checks };
}
