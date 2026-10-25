import {
  COLOR_RULE_COLORS,
  COLOR_RULE_TARGETS,
  DUPLICATE_RULE,
  isId,
  MAX_COLOR_RULES,
  type ColorRuleColor,
  type ColorRuleTarget,
  type ProblemErrorItem,
  type StoredColorRule,
} from '@cellhive/contracts';
import { parseFilterInput, type FilterTableMeta } from '@cellhive/filter-dsl';

/**
 * Color rules of a grid view (T816, CONTRACTS §15, S7 decision #21):
 * `config.color_rules` as stored, as a reader sees it, and as a saver
 * changes it. A rule is hidden from a person when it names (in its filter or
 * as its cell) an active field they cannot read: it is left out of what they
 * read, survives what they save, and never colors anything for them
 * (`evaluate.ts`). A rule naming a deleted field is `broken`: it colors
 * nothing until the field is restored or the rule is saved again.
 */

type FilterJson = Record<string, unknown>;

function isObject(value: unknown): value is FilterJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Field ids named by the conditions of a stored filter. */
function filterFields(node: unknown, into: Set<string>): void {
  if (!isObject(node)) return;
  if (Array.isArray(node['items'])) for (const item of node['items']) filterFields(item, into);
  if (node['item'] !== undefined) filterFields(node['item'], into);
  if (typeof node['field'] === 'string') into.add(node['field']);
}

/** Every field a rule names: its filter's fields and its cell field. */
export function colorRuleFieldIds(rule: Pick<StoredColorRule, 'filter' | 'field_id'>): Set<string> {
  const ids = new Set<string>();
  filterFields(rule.filter, ids);
  if (rule.field_id !== null) ids.add(rule.field_id);
  return ids;
}

/** Field ids named by any of `rules` (the realtime images capture them, T313/T816). */
export function colorRulesFieldIds(rules: readonly StoredColorRule[], into = new Set<string>()) {
  for (const rule of rules) for (const id of colorRuleFieldIds(rule)) into.add(id);
  return into;
}

/**
 * The rules of a stored config (`meta.views.config.color_rules`), keeping
 * only well-formed entries: rows are written by {@link buildColorRules}, so
 * this only guards against hand-edited data.
 */
export function storedColorRulesOf(json: unknown): StoredColorRule[] {
  if (!Array.isArray(json)) return [];
  const rules: StoredColorRule[] = [];
  for (const item of json) {
    if (!isObject(item)) continue;
    const { id, enabled, filter, color, target, field_id: fieldId } = item;
    if (typeof id !== 'string' || !isId('clr', id)) continue;
    if (!(COLOR_RULE_COLORS as readonly unknown[]).includes(color)) continue;
    if (!(COLOR_RULE_TARGETS as readonly unknown[]).includes(target)) continue;
    rules.push({
      id,
      enabled: enabled !== false,
      filter: isObject(filter) ? filter : null,
      color: color as ColorRuleColor,
      target: target as ColorRuleTarget,
      field_id: target === 'cell' && typeof fieldId === 'string' ? fieldId : null,
    });
  }
  return rules;
}

/** `node` without the conditions on fields `keep` rejects (`null` when nothing is left). */
function pruneFilter(node: unknown, keep: (fieldId: string) => boolean): FilterJson | null {
  if (!isObject(node)) return null;
  if (node['op'] === 'and' || node['op'] === 'or') {
    const items = Array.isArray(node['items']) ? (node['items'] as unknown[]) : [];
    const kept = items
      .map((item) => pruneFilter(item, keep))
      .filter((item): item is FilterJson => item !== null);
    if (kept.length === 0 && items.length > 0) return null;
    return { ...node, items: kept };
  }
  if (node['op'] === 'not') {
    const item = pruneFilter(node['item'], keep);
    return item === null ? null : { ...node, item };
  }
  return typeof node['field'] === 'string' && keep(node['field']) ? node : null;
}

/**
 * `rules` as a reader sees them (CONTRACTS §15): a rule naming a field
 * outside `visible` that is active (or any field outside `visible` when
 * `active` is unknown) is left out; a rule naming a deleted field is
 * returned `broken`, without its conditions on deleted fields and with
 * `field_id: null` when its cell field is the deleted one.
 */
export function restrictColorRules(
  rules: readonly StoredColorRule[],
  visible: ReadonlySet<string>,
  active?: ReadonlySet<string>,
): StoredColorRule[] {
  const out: StoredColorRule[] = [];
  for (const rule of rules) {
    let broken = false;
    let hidden = false;
    for (const id of colorRuleFieldIds(rule)) {
      if (visible.has(id)) continue;
      if (active === undefined || active.has(id)) hidden = true;
      else broken = true;
    }
    if (hidden) continue;
    if (!broken) {
      out.push({ ...rule });
      continue;
    }
    out.push({
      ...rule,
      filter: rule.filter === null ? null : pruneFilter(rule.filter, (id) => visible.has(id)),
      field_id: rule.field_id !== null && visible.has(rule.field_id) ? rule.field_id : null,
      broken: true,
    });
  }
  return out;
}

/** A rule as a request sends it, after the zod schema (defaults applied). */
export interface ColorRuleRequest {
  readonly id: string;
  readonly enabled: boolean;
  readonly filter: Record<string, unknown> | null;
  readonly color: ColorRuleColor;
  readonly target: ColorRuleTarget;
  readonly field_id: string | null;
}

export interface ColorRuleSaveContext {
  /** Active fields of the table the saver reads (cells may be any of them). */
  readonly readable: ReadonlySet<string>;
  /** Fields the saver may filter on: readable, not locked (T457). */
  readonly filterable: readonly string[];
  /** Filter meta of every active field of the table. */
  readonly filterMeta: FilterTableMeta;
  /** Active field ids of the table. */
  readonly active: ReadonlySet<string>;
}

export type ColorRuleIssueCode = 'VALIDATION_FAILED' | 'INVALID_FILTER';

/** JSON with object keys sorted: two filters sent and read back compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

function sameRule(sent: ColorRuleRequest, shown: StoredColorRule): boolean {
  return (
    sent.enabled === shown.enabled &&
    sent.color === shown.color &&
    sent.target === shown.target &&
    sent.field_id === shown.field_id &&
    canonical(sent.filter) === canonical(shown.filter)
  );
}

function joinPath(prefix: string, path: string): string {
  if (path === '') return prefix;
  return path.startsWith('[') ? `${prefix}${path}` : `${prefix}.${path}`;
}

/**
 * `color_rules` sent by a saver (CONTRACTS §15), validated against the
 * table and their permissions, merged with what they cannot see:
 *
 * - a rule sent back exactly as the saver reads it (same id, same content)
 *   keeps its stored form untouched — conditions on deleted fields
 *   included, so a broken rule mends itself when the field is restored;
 * - any other rule validates like a view filter (`INVALID_FILTER` under
 *   `config.color_rules[i].filter`; tuple form accepted, stored as DSL), its
 *   cell field must be a field the saver reads (`UNKNOWN_FIELD`), `target:
 *   cell` needs `field_id` (`REQUIRED`) and `target: row` takes none
 *   (`NOT_ALLOWED`); ids are unique (`DUPLICATE_RULE`);
 * - stored rules hidden from the saver stay, at their former position;
 * - at most {@link MAX_COLOR_RULES} rules in all (`TOO_BIG`).
 */
export function buildColorRules(
  sent: readonly ColorRuleRequest[],
  stored: readonly StoredColorRule[],
  context: ColorRuleSaveContext,
  report: (code: ColorRuleIssueCode, item: ProblemErrorItem) => void,
): StoredColorRule[] {
  const isHidden = (rule: StoredColorRule) => {
    for (const id of colorRuleFieldIds(rule)) {
      if (context.active.has(id) && !context.readable.has(id)) return true;
    }
    return false;
  };
  const hidden: { readonly index: number; readonly rule: StoredColorRule }[] = [];
  const shownById = new Map<
    string,
    { readonly stored: StoredColorRule; readonly shown: StoredColorRule }
  >();
  stored.forEach((rule, index) => {
    if (isHidden(rule)) {
      hidden.push({ index, rule });
      return;
    }
    const [shown] = restrictColorRules([rule], context.readable, context.active);
    if (shown !== undefined) shownById.set(rule.id, { stored: rule, shown });
  });
  const hiddenIds = new Set(hidden.map((item) => item.rule.id));

  const seen = new Set<string>();
  const rules: StoredColorRule[] = [];
  sent.forEach((rule, index) => {
    const path = `config.color_rules[${String(index)}]`;
    if (seen.has(rule.id) || hiddenIds.has(rule.id)) {
      report('VALIDATION_FAILED', {
        path: `${path}.id`,
        code: DUPLICATE_RULE,
        message: 'Another color rule has this id',
      });
      return;
    }
    seen.add(rule.id);
    const previous = shownById.get(rule.id);
    if (previous !== undefined && sameRule(rule, previous.shown)) {
      rules.push({ ...previous.stored });
      return;
    }
    let ok = true;
    let filter: Record<string, unknown> | null = null;
    if (rule.filter !== null) {
      const result = parseFilterInput(rule.filter, context.filterMeta, context.filterable, {
        fieldKeyType: 'id',
      });
      if (result.ok) {
        filter = result.ast as unknown as Record<string, unknown>;
      } else {
        ok = false;
        for (const issue of result.errors) {
          report('INVALID_FILTER', { ...issue, path: joinPath(`${path}.filter`, issue.path) });
        }
      }
    }
    if (rule.target === 'cell') {
      if (rule.field_id === null) {
        ok = false;
        report('VALIDATION_FAILED', {
          path: `${path}.field_id`,
          code: 'REQUIRED',
          message: 'A cell rule names the field of its cell',
        });
      } else if (!context.readable.has(rule.field_id)) {
        ok = false;
        report('VALIDATION_FAILED', {
          path: `${path}.field_id`,
          code: 'UNKNOWN_FIELD',
          message: 'The field does not exist in the table',
        });
      }
    } else if (rule.field_id !== null) {
      ok = false;
      report('VALIDATION_FAILED', {
        path: `${path}.field_id`,
        code: 'NOT_ALLOWED',
        message: 'A row rule has no field',
      });
    }
    if (!ok) return;
    rules.push({
      id: rule.id,
      enabled: rule.enabled,
      filter,
      color: rule.color,
      target: rule.target,
      field_id: rule.target === 'cell' ? rule.field_id : null,
    });
  });

  for (const { index, rule } of hidden) rules.splice(Math.min(index, rules.length), 0, rule);
  if (rules.length > MAX_COLOR_RULES) {
    report('VALIDATION_FAILED', {
      path: 'config.color_rules',
      code: 'TOO_BIG',
      message: `At most ${String(MAX_COLOR_RULES)} color rules`,
      params: { maximum: MAX_COLOR_RULES },
    });
  }
  return rules;
}
