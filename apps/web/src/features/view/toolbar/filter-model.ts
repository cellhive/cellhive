import {
  allowedOperators,
  AUTOMATION_ONLY_OPERATORS,
  equalityOperator,
  fieldProfile,
  MAX_FILTER_CONDITIONS,
  MAX_FILTER_DEPTH,
  NO_VALUE_OPERATORS,
  validateFilter,
  type DslOperator,
  type FieldProfile,
  type FilterFieldMeta,
  type FilterMode,
  type FilterNode,
  type FilterOperator,
} from '@cellhive/filter-dsl';

import { computedColumnOf, filterTypeOfResult } from '../../../grid/display/computed';

import type { FieldDto } from '@cellhive/contracts';
import type { FieldType } from '@cellhive/field-types';

/**
 * The filter builder's model (T311, SPEC §6): a tree of `and`/`or` groups
 * and conditions that may still be incomplete while the user types. It
 * converts to the filter DSL (incomplete conditions and empty groups left
 * out) and is validated with `@cellhive/filter-dsl` — the same code the
 * server runs — before anything is sent.
 */

export interface ConditionItem {
  readonly kind: 'condition';
  readonly id: string;
  readonly field: string;
  readonly operator: DslOperator;
  /** `undefined` while not chosen yet. */
  readonly value?: unknown;
}

export interface GroupItem {
  readonly kind: 'group';
  readonly id: string;
  readonly op: 'and' | 'or';
  readonly items: readonly BuilderItem[];
}

/**
 * A part of a saved filter the builder does not edit (a `not` node, made
 * through the API): kept as is, can only be removed.
 */
export interface RawItem {
  readonly kind: 'raw';
  readonly id: string;
  readonly node: unknown;
}

export type BuilderItem = ConditionItem | GroupItem | RawItem;

let nextId = 0;
/** Ids of builder items: unique in the tab, stable while the builder is open. */
export function newItemId(): string {
  nextId += 1;
  return `c${String(nextId)}`;
}

// ---------------------------------------------------------------------------
// Fields and operators

/**
 * The filter meta of a field, as the server builds it (`FilterFieldMeta`).
 * A formula or lookup (T468, CONTRACTS §1.4) filters by its result type
 * (`computedFilterResultOf` of the server); a locked one, one in error or
 * one of unknown result type has no operator (the server answers
 * `INVALID_FILTER` like for a field it does not see).
 */
export function filterMetaOf(field: FieldDto): FilterFieldMeta {
  const type: FieldType = field.type;
  const computed = computedColumnOf(field);
  if (computed !== undefined) {
    const resultType = computed.resultType;
    const result =
      computed.locked || computed.error !== null || resultType === null
        ? null
        : filterTypeOfResult(resultType);
    if (result === null || resultType === null) return { id: field.id, name: field.name, type };
    return {
      id: field.id,
      name: field.name,
      type,
      resultType: result,
      resultIsList: resultType.list,
      ...(resultType.kind === 'date'
        ? { resultOptions: { style: { format: 'yyyy-MM-dd' } } }
        : resultType.kind === 'datetime'
          ? { resultOptions: { style: { format: 'yyyy-MM-dd HH:mm' } } }
          : {}),
    };
  }
  return { id: field.id, name: field.name, type, options: field.options };
}

/** Kinds of one operand (as `@cellhive/filter-dsl` validates them). */
export type OperandKind =
  'text' | 'number' | 'date' | 'boolean' | 'option' | 'user' | 'record' | 'scalar';

export type ValueShape =
  | { readonly shape: 'none' }
  | { readonly shape: 'one' | 'pair' | 'list'; readonly kind: OperandKind };

const LIST_OPERATORS: ReadonlySet<DslOperator> = new Set([
  'is_any_of',
  'is_none_of',
  'has_any_of',
  'has_all_of',
  'has_none_of',
  'is_exactly',
]);

function profileOf(field: FieldDto): FieldProfile | null {
  try {
    return fieldProfile(filterMetaOf(field));
  } catch {
    // Options the filter code cannot read: the field is not offered.
    return null;
  }
}

function operandKind(profile: FieldProfile): OperandKind {
  switch (profile.group) {
    case 'text':
      return 'text';
    case 'number':
      return 'number';
    case 'datetime':
      return 'date';
    case 'checkbox':
      return 'boolean';
    case 'single_select':
      return 'option';
    default:
      return profile.element;
  }
}

/** Shape and kind of the value of `operator` on `field` (mirrors `validateFilter`). */
export function valueShapeOf(field: FieldDto, operator: DslOperator): ValueShape {
  if (NO_VALUE_OPERATORS.has(operator)) return { shape: 'none' };
  const profile = profileOf(field);
  if (profile === null) return { shape: 'none' };
  if (operator === 'changed_to' || operator === 'changed_from') {
    // (T521) An automation condition: the value of the field's "equals" operator.
    const equals = equalityOperator(profile.group);
    return equals === null ? { shape: 'none' } : valueShapeOf(field, equals);
  }
  const kind = operandKind(profile);
  if (operator === 'between') return { shape: 'pair', kind };
  if (LIST_OPERATORS.has(operator)) return { shape: 'list', kind };
  return { shape: 'one', kind };
}

/**
 * Where a filter is edited (T521): `standard` (views, links, lookups) or an
 * automation condition, which adds `changed`/`changed_to`/`changed_from`
 * (SPEC §11.3) — only for `record.updated` (`changes` exist), never on fields
 * in `noChangeFields` (virtual computed fields, CONTRACTS §21).
 */
export interface FilterModelOptions {
  readonly mode?: FilterMode;
  readonly noChangeFields?: ReadonlySet<string>;
  /**
   * (T521b) Values the automation resolves when it runs (SPEC §11.4) are
   * complete and kept as they are; the client check tests the rest.
   */
  readonly isSourceValue?: ((value: unknown) => boolean) | undefined;
}

/**
 * Operators the builder offers for a field (SPEC §6.2 via `fieldProfile`, as
 * `validateFilter` accepts them). Link fields pick their records from the
 * linked table (T413, `ValueEditor`); other fields whose values are records
 * (parent: no record picker here yet) only offer the empty checks.
 */
export function operatorsFor(
  field: FieldDto,
  options: FilterModelOptions = {},
): readonly DslOperator[] {
  const profile = profileOf(field);
  if (profile === null || profile.group === 'unsupported') return [];
  const base =
    profile.element === 'record' && field.type !== 'link'
      ? profile.operators.filter((operator) => NO_VALUE_OPERATORS.has(operator))
      : profile.operators;
  if (options.mode !== 'automation' || options.noChangeFields?.has(field.id) === true) return base;
  const allowed = allowedOperators(profile, 'automation');
  return [...base, ...AUTOMATION_ONLY_OPERATORS.filter((operator) => allowed.has(operator))];
}

/** Fields the builder lists: readable (the caller passes those) with at least one operator. */
export function filterableFields(
  fields: readonly FieldDto[],
  options: FilterModelOptions = {},
): FieldDto[] {
  return fields.filter((field) => operatorsFor(field, options).length > 0);
}

const PREFERRED_OPERATORS: readonly FilterOperator[] = [
  'contains',
  'has_any_of',
  'is',
  'eq',
  'is_not_empty',
];

/** The operator a new condition on `field` starts with. */
export function defaultOperator(field: FieldDto): DslOperator | undefined {
  const operators = operatorsFor(field);
  return PREFERRED_OPERATORS.find((operator) => operators.includes(operator)) ?? operators[0];
}

/** A new condition on `field` (checkbox conditions start with "checked"). */
export function newCondition(field: FieldDto): ConditionItem {
  const operator = defaultOperator(field) ?? 'is_not_empty';
  const shape = valueShapeOf(field, operator);
  return {
    kind: 'condition',
    id: newItemId(),
    field: field.id,
    operator,
    ...(shape.shape === 'one' && shape.kind === 'boolean' ? { value: true } : {}),
  };
}

/**
 * The condition with another operator: the value stays when it still fits
 * (same shape and kind), else it is cleared.
 */
export function withOperator(
  condition: ConditionItem,
  field: FieldDto,
  operator: DslOperator,
): ConditionItem {
  const before = valueShapeOf(field, condition.operator);
  const after = valueShapeOf(field, operator);
  const keeps =
    before.shape !== 'none' &&
    after.shape !== 'none' &&
    before.shape === after.shape &&
    before.kind === after.kind;
  const base = { kind: 'condition' as const, id: condition.id, field: condition.field, operator };
  if (keeps) return { ...base, value: condition.value };
  if (after.shape === 'one' && after.kind === 'boolean') return { ...base, value: true };
  return base;
}

// ---------------------------------------------------------------------------
// DSL ⇄ builder

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function itemOf(node: unknown): BuilderItem {
  if (isObject(node) && (node['op'] === 'and' || node['op'] === 'or')) {
    const items = Array.isArray(node['items']) ? (node['items'] as unknown[]) : [];
    return { kind: 'group', id: newItemId(), op: node['op'], items: items.map(itemOf) };
  }
  if (isObject(node) && typeof node['field'] === 'string' && typeof node['operator'] === 'string') {
    return {
      kind: 'condition',
      id: newItemId(),
      field: node['field'],
      operator: node['operator'] as DslOperator,
      ...(node['value'] === undefined ? {} : { value: node['value'] }),
    };
  }
  return { kind: 'raw', id: newItemId(), node };
}

/** The builder tree of a saved or temporary filter: always a root group. */
export function fromFilter(filter: unknown): GroupItem {
  if (filter === null || filter === undefined) {
    return { kind: 'group', id: newItemId(), op: 'and', items: [] };
  }
  const item = itemOf(filter);
  return item.kind === 'group'
    ? item
    : { kind: 'group', id: newItemId(), op: 'and', items: [item] };
}

function filled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

/** Whether a condition has everything its operator needs (else it is left out). */
export function isComplete(
  condition: ConditionItem,
  field: FieldDto | undefined,
  options: FilterModelOptions = {},
): boolean {
  if (field === undefined) return true; // unknown to us: the validator reports it
  if (options.isSourceValue?.(condition.value) === true) return true;
  const shape = valueShapeOf(field, condition.operator);
  switch (shape.shape) {
    case 'none':
      return true;
    case 'one':
      return filled(condition.value);
    case 'pair':
      return (
        Array.isArray(condition.value) &&
        condition.value.length === 2 &&
        condition.value.every(filled)
      );
    case 'list':
      return Array.isArray(condition.value) && condition.value.length > 0;
  }
}

export interface BuiltFilter {
  /** The DSL to apply; `null` = no condition. */
  readonly filter: FilterNode | null;
  /** DSL path of every item that made it into `filter` (`''` = the root). */
  readonly paths: ReadonlyMap<string, string>;
  /** Conditions left out because they are not complete yet. */
  readonly incomplete: ReadonlySet<string>;
}

/** Converts the tree to the DSL, leaving out incomplete conditions and empty groups. */
export function toFilter(
  root: GroupItem,
  fields: readonly FieldDto[],
  options: FilterModelOptions = {},
): BuiltFilter {
  const byId = new Map(fields.map((field) => [field.id as string, field]));
  const paths = new Map<string, string>();
  const incomplete = new Set<string>();
  const convert = (item: BuilderItem, path: string): FilterNode | null => {
    switch (item.kind) {
      case 'raw':
        paths.set(path, item.id);
        return item.node as FilterNode;
      case 'condition': {
        if (!isComplete(item, byId.get(item.field), options)) {
          incomplete.add(item.id);
          return null;
        }
        paths.set(path, item.id);
        const noValue = NO_VALUE_OPERATORS.has(item.operator);
        return {
          field: item.field,
          operator: item.operator,
          ...(noValue || item.value === undefined ? {} : { value: item.value }),
        } as FilterNode;
      }
      case 'group': {
        const items: FilterNode[] = [];
        for (const child of item.items) {
          const node = convert(
            child,
            `${path === '' ? '' : `${path}.`}items[${String(items.length)}]`,
          );
          if (node !== null) items.push(node);
        }
        if (items.length === 0) return null;
        paths.set(path, item.id);
        return { op: item.op, items };
      }
    }
  };
  const filter = convert(root, '');
  return { filter, paths, incomplete };
}

/**
 * Item ids for issue paths (`items[1].value`, or `filter.items[1].value` as
 * the server reports them): the deepest item whose path starts the issue's.
 */
export function issuesByItem(
  issues: readonly { readonly path: string; readonly code: string }[],
  paths: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const issue of issues) {
    const path = issue.path.replace(/^filter(?:\.|$)/u, '');
    let best: string | undefined;
    for (const candidate of paths.keys()) {
      const starts =
        candidate === '' ||
        path === candidate ||
        path.startsWith(`${candidate}.`) ||
        path.startsWith(`${candidate}[`);
      if (starts && (best === undefined || candidate.length > best.length)) best = candidate;
    }
    const id = best === undefined ? undefined : paths.get(best);
    if (id === undefined) continue;
    result.set(id, [...(result.get(id) ?? []), issue.code]);
  }
  return result;
}

export interface CheckedFilter extends BuiltFilter {
  /** Issue codes by item id (the root group's id for issues of the whole filter). */
  readonly issues: ReadonlyMap<string, string[]>;
}

/** Client issue of a `between` whose lower bound is above its upper bound. */
export const BETWEEN_INVERTED = 'BETWEEN_INVERTED';

/** The day of an exact date operand (`YYYY-MM-DD…` or `{ $date: { exact } }`), else `null`. */
function exactDay(value: unknown): string | null {
  if (typeof value === 'string') return value.slice(0, 10);
  if (isObject(value) && isObject(value['$date'])) {
    const exact = value['$date']['exact'];
    return typeof exact === 'string' ? exact.slice(0, 10) : null;
  }
  return null;
}

/**
 * Whether the two bounds of a `between` are the wrong way round: numbers,
 * or exact dates (relative dates move with time and are left alone). Such a
 * range matches nothing — shown as an issue instead of an empty result.
 */
export function isInvertedRange(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [from, to] = value as [unknown, unknown];
  if (typeof from === 'number' && typeof to === 'number') return from > to;
  const start = exactDay(from);
  const end = exactDay(to);
  return start !== null && end !== null && start > end;
}

/** Ids of the complete `between` conditions of the tree whose range is inverted. */
function invertedRanges(item: BuilderItem, into: Map<string, string[]>): void {
  if (item.kind === 'group') {
    for (const child of item.items) invertedRanges(child, into);
    return;
  }
  if (item.kind === 'condition' && item.operator === 'between' && isInvertedRange(item.value)) {
    into.set(item.id, [BETWEEN_INVERTED]);
  }
}

/**
 * {@link toFilter} validated like the server does, over the fields the user
 * reads, plus the client check of inverted `between` ranges.
 */
export function checkFilter(
  root: GroupItem,
  fields: readonly FieldDto[],
  options: FilterModelOptions = {},
): CheckedFilter {
  const built = toFilter(root, fields, options);
  const inverted = new Map<string, string[]>();
  invertedRanges(root, inverted);
  if (built.filter === null) return { ...built, issues: inverted };
  // Values the automation resolves later: checked as "is not empty" (same paths).
  const sources = options.isSourceValue;
  const probe = sources === undefined ? built.filter : withoutSourceValues(built.filter, sources);
  const result = validateFilter(
    probe,
    { fields: fields.map(filterMetaOf) },
    fields.map((field) => field.id),
    options.mode === undefined ? {} : { mode: options.mode },
  );
  if (result.ok) {
    return {
      ...built,
      filter: probe === built.filter ? result.ast : built.filter,
      issues: inverted,
    };
  }
  const issues = issuesByItem(result.errors, built.paths);
  for (const [id, codes] of inverted) issues.set(id, [...(issues.get(id) ?? []), ...codes]);
  return { ...built, issues };
}

/** The filter with every condition whose value is a source tested as "is not empty". */
function withoutSourceValues(
  filter: FilterNode,
  isSource: (value: unknown) => boolean,
): FilterNode {
  const found = { source: false };
  const visit = (node: unknown): unknown => {
    if (!isObject(node)) return node;
    if (Array.isArray(node['items'])) {
      return { ...node, items: (node['items'] as unknown[]).map(visit) };
    }
    if (node['item'] !== undefined) return { ...node, item: visit(node['item']) };
    if (typeof node['field'] === 'string' && isSource(node['value'])) {
      found.source = true;
      return { field: node['field'], operator: 'is_not_empty' };
    }
    return node;
  };
  const next = visit(filter) as FilterNode;
  return found.source ? next : filter;
}

// ---------------------------------------------------------------------------
// Tree edits (immutable)

export function updateItem(
  group: GroupItem,
  id: string,
  change: (item: BuilderItem) => BuilderItem | null,
): GroupItem {
  const items: BuilderItem[] = [];
  for (const item of group.items) {
    if (item.id === id) {
      const next = change(item);
      if (next !== null) items.push(next);
    } else if (item.kind === 'group') {
      items.push(updateItem(item, id, change));
    } else {
      items.push(item);
    }
  }
  return { ...group, items };
}

/**
 * Where the focus goes when item `id` is removed: the next item of its
 * group, else the previous one, else the group's "Add condition" button.
 */
export function focusAfterRemoval(
  root: GroupItem,
  id: string,
): { readonly kind: 'item' | 'add'; readonly id: string } | null {
  const search = (group: GroupItem): ReturnType<typeof focusAfterRemoval> => {
    const index = group.items.findIndex((item) => item.id === id);
    if (index !== -1) {
      const neighbour = group.items[index + 1] ?? group.items[index - 1];
      return neighbour === undefined
        ? { kind: 'add', id: group.id }
        : { kind: 'item', id: neighbour.id };
    }
    for (const item of group.items) {
      if (item.kind !== 'group') continue;
      const found = search(item);
      if (found !== null) return found;
    }
    return null;
  };
  return search(root);
}

export function removeItem(root: GroupItem, id: string): GroupItem {
  return updateItem(root, id, () => null);
}

/** Adds `item` at the end of group `groupId`. */
export function appendTo(root: GroupItem, groupId: string, item: BuilderItem): GroupItem {
  if (root.id === groupId) return { ...root, items: [...root.items, item] };
  return updateItem(root, groupId, (group) =>
    group.kind === 'group' ? appendTo(group, groupId, item) : group,
  );
}

/** Number of conditions in the tree (complete or not; raw parts counted by their conditions). */
export function conditionCount(item: BuilderItem): number {
  switch (item.kind) {
    case 'condition':
      return 1;
    case 'group':
      return item.items.reduce((sum, child) => sum + conditionCount(child), 0);
    case 'raw':
      return countRaw(item.node);
  }
}

function countRaw(node: unknown): number {
  if (!isObject(node)) return 0;
  if (Array.isArray(node['items'])) {
    return (node['items'] as unknown[]).reduce<number>((sum, child) => sum + countRaw(child), 0);
  }
  if (node['item'] !== undefined) return countRaw(node['item']);
  return typeof node['field'] === 'string' ? 1 : 0;
}

/** Whether another condition fits (SPEC §6.1: at most 50 per filter). */
export function canAddCondition(root: GroupItem): boolean {
  return conditionCount(root) < MAX_FILTER_CONDITIONS;
}

/** Whether a group may hold another group: `depth` is the group's own level (root = 1). */
export function canNestGroup(depth: number): boolean {
  return depth < MAX_FILTER_DEPTH;
}
