import { LOOKUP_FIELD_AGGREGATES, type LookupFieldAggregate } from '@cellhive/field-types';

import {
  buildWhere,
  conditionsOf,
  EMPTY_CONDITIONS,
  MAX_LOOKUP_CONDITIONS,
  newConditionKey,
  RECORD_FIELD_ID,
  THIS_RECORD_REF,
  type BuiltWhere,
  type LookupConditionDraft,
  type LookupConditionsDraft,
} from '../../lib/schema/lookup-where';

import type { FieldDto, TableDto } from '@cellhive/contracts';

/**
 * The lookup field form (T467, SPEC §5.8, board "S4b · Cấu hình tra cứu")
 * as plain data: source table and field, conditions, aggregation and the
 * format of the result. Pure functions; the components render it.
 */

/**
 * Format of the result. `source`: the style of the field the result
 * carries (the server's default); `custom`: a saved style this form does
 * not offer (progress, rating…), kept as is.
 */
export type StyleChoice =
  | 'source'
  | 'custom'
  | 'number:plain'
  | 'number:decimal'
  | 'number:percent'
  | 'number:currency'
  | `date:${string}`;

export interface LookupDraft {
  /** Source table (`''` until chosen). */
  readonly from: string;
  /** Field of the source table whose values are taken (`''` until chosen). */
  readonly select: string;
  readonly conditions: LookupConditionsDraft;
  readonly aggregate: LookupFieldAggregate;
  readonly style: StyleChoice;
  /** The saved style (edit), sent back as is while `style` is `custom`. */
  readonly savedStyle: Readonly<Record<string, unknown>> | null;
  /** Currency of `number:currency` (source field's, else the organization's). */
  readonly currency: string | null;
  /** The "through a link field" shortcut that made the first condition (`null`: none). */
  readonly shortcut: string | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const EMPTY_LOOKUP: LookupDraft = {
  from: '',
  select: '',
  conditions: EMPTY_CONDITIONS,
  aggregate: 'raw_value',
  style: 'source',
  savedStyle: null,
  currency: null,
  shortcut: null,
};

/** The style choice of a saved style. */
export function styleChoiceOf(style: unknown): StyleChoice {
  if (!isObject(style)) return 'source';
  if (typeof style['format'] === 'string') return `date:${style['format']}`;
  if (style['type'] === 'currency') return 'number:currency';
  if (style['type'] === 'plain') {
    if (style['percentage'] === true) return 'number:percent';
    return style['precision'] === 2 ? 'number:decimal' : 'number:plain';
  }
  return 'custom';
}

/**
 * The draft of a saved lookup field. `sourceFields` (the source table's
 * fields, once loaded) turn stored `where` operators into their labels.
 * Readers without the definition (`options = { style }`) get an empty draft.
 */
export function lookupDraftOf(
  field: FieldDto | undefined,
  sourceFields: readonly FieldDto[] = [],
): LookupDraft {
  if (field?.type !== 'lookup') return EMPTY_LOOKUP;
  const options = field.options;
  const aggregate = (LOOKUP_FIELD_AGGREGATES as readonly unknown[]).includes(options['aggregate'])
    ? (options['aggregate'] as LookupFieldAggregate)
    : 'raw_value';
  const style = isObject(options['style']) ? options['style'] : null;
  const currency =
    style !== null && typeof style['currency_code'] === 'string' ? style['currency_code'] : null;
  return {
    from: typeof options['from'] === 'string' ? options['from'] : '',
    select: typeof options['select'] === 'string' ? options['select'] : '',
    conditions: conditionsOf(options['where'], sourceFields),
    aggregate,
    // Values and unique values keep the source format (board).
    style: aggregate === 'raw_value' || aggregate === 'unique' ? 'source' : styleChoiceOf(style),
    savedStyle: style,
    currency,
    shortcut: null,
  };
}

/** Whether the reader sees the definition (schema rights and every reference readable). */
export function hasDefinition(field: FieldDto | undefined): boolean {
  return field === undefined || typeof field.options['from'] === 'string';
}

// ---------------------------------------------------------------------------
// The value taken and its aggregation

/** What a source field's values are, for the aggregations and formats. */
export type ValueKind = 'number' | 'date' | 'other';

export function valueKindOf(field: FieldDto | undefined): ValueKind {
  if (field === undefined) return 'other';
  switch (field.type) {
    case 'number':
      return 'number';
    case 'datetime':
    case 'created_at':
    case 'updated_at':
      return 'date';
    case 'formula':
    case 'lookup': {
      const kind = field.result_type?.kind;
      if (kind === 'number') return 'number';
      if (kind === 'date' || kind === 'datetime') return 'date';
      return 'other';
    }
    default:
      return 'other';
  }
}

/** Aggregations valid for the field taken (the formula functions' signatures, SPEC §9.3). */
export function aggregatesFor(field: FieldDto | undefined): LookupFieldAggregate[] {
  const kind = valueKindOf(field);
  return LOOKUP_FIELD_AGGREGATES.filter((aggregate) => {
    if (aggregate === 'sum' || aggregate === 'average') return kind === 'number';
    if (aggregate === 'max' || aggregate === 'min') return kind !== 'other';
    return true;
  });
}

/** Kind of the result of an aggregation: a list of the source values, a number or a date. */
export type ResultKind = 'values' | 'number' | 'date';

export function resultKindOf(
  field: FieldDto | undefined,
  aggregate: LookupFieldAggregate,
): ResultKind {
  switch (aggregate) {
    case 'raw_value':
    case 'unique':
      return 'values';
    case 'counta':
    case 'unique_counta':
    case 'sum':
    case 'average':
      return 'number';
    case 'max':
    case 'min':
      return valueKindOf(field) === 'date' ? 'date' : 'number';
  }
}

/** Formats offered for a result (`source` first: the default). */
export function styleChoicesFor(
  field: FieldDto | undefined,
  aggregate: LookupFieldAggregate,
  dateFormats: readonly string[],
  current: StyleChoice,
): StyleChoice[] {
  const kind = resultKindOf(field, aggregate);
  if (kind === 'values') return ['source'];
  const list: StyleChoice[] =
    kind === 'number'
      ? ['source', 'number:plain', 'number:decimal', 'number:currency', 'number:percent']
      : ['source', ...dateFormats.map((format): StyleChoice => `date:${format}`)];
  if (current === 'custom') list.push('custom');
  return list;
}

/** The format a source field lends its values (`style` of number/date fields). */
export function sourceStyleOf(field: FieldDto | undefined): Record<string, unknown> | null {
  if (field === undefined) return null;
  const style = field.options['style'];
  if (valueKindOf(field) === 'other' || !isObject(style)) return null;
  if (valueKindOf(field) === 'date') {
    return typeof style['format'] === 'string' ? { format: style['format'] } : null;
  }
  return style;
}

/** Whether the "source" format of a result is the source field's (sum…) or none (counts). */
export function carriesSourceStyle(field: FieldDto | undefined, aggregate: LookupFieldAggregate) {
  return aggregate !== 'counta' && aggregate !== 'unique_counta' && valueKindOf(field) !== 'other';
}

/**
 * `style` to send: always explicit, so that a changed aggregation never
 * keeps a format that no longer fits (the server keeps the saved style when
 * none is given).
 */
export function styleOf(draft: LookupDraft, field: FieldDto | undefined, fallbackCurrency: string) {
  const kind = resultKindOf(field, draft.aggregate);
  if (kind === 'values' || draft.style === 'source') {
    return carriesSourceStyle(field, draft.aggregate) ? sourceStyleOf(field) : null;
  }
  switch (draft.style) {
    case 'custom':
      return draft.savedStyle;
    case 'number:plain':
      return { type: 'plain', precision: 0, percentage: false, thousands_separator: true };
    case 'number:decimal':
      return { type: 'plain', precision: 2, percentage: false, thousands_separator: true };
    case 'number:percent':
      return { type: 'plain', precision: 0, percentage: true, thousands_separator: false };
    case 'number:currency': {
      const source = sourceStyleOf(field);
      const code =
        draft.currency ??
        (source !== null && typeof source['currency_code'] === 'string'
          ? source['currency_code']
          : fallbackCurrency);
      return { type: 'currency', currency_code: code };
    }
    default:
      return { format: draft.style.slice('date:'.length) };
  }
}

// ---------------------------------------------------------------------------
// Options

export interface BuiltOptions extends BuiltWhere {
  /** The options to send; `null` while something is missing or invalid. */
  readonly options: Readonly<Record<string, unknown>> | null;
}

/** The lookup options of the draft (`from`, `select`, `where`, `aggregate`, `style`). */
export function buildOptions(
  draft: LookupDraft,
  sourceFields: readonly FieldDto[],
  currentFields: readonly FieldDto[],
  fallbackCurrency: string,
): BuiltOptions {
  const built = buildWhere(draft.conditions, sourceFields, currentFields);
  const field = sourceFields.find((candidate) => candidate.id === draft.select);
  const complete =
    draft.from !== '' && field !== undefined && built.where !== null && built.incomplete.size === 0;
  if (!complete) return { ...built, options: null };
  return {
    ...built,
    options: {
      from: draft.from,
      select: draft.select,
      where: built.where,
      aggregate: draft.aggregate,
      style: styleOf(draft, field, fallbackCurrency),
    },
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Options of a `PATCH` (the keys that changed), `null` when none did. */
export function changedOptions(
  field: FieldDto,
  options: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    const saved = field.options[key] ?? (key === 'aggregate' ? 'raw_value' : null);
    if (!sameJson(saved, value)) changed[key] = value;
  }
  return Object.keys(changed).length === 0 ? null : changed;
}

// ---------------------------------------------------------------------------
// "Through a link field" (SPEC §5.8): a link between this table and another
// one gives the source table and the first condition.

export interface LinkShortcut {
  readonly key: string;
  /** The link field (of this table, or of the source table pointing here). */
  readonly linkField: FieldDto;
  /** `out`: a field of this table; `in`: a field of the source table linking here. */
  readonly direction: 'out' | 'in';
  readonly sourceTable: TableDto;
  /**
   * The generated first condition: `<reverse or incoming link> has any of
   * This record`, or — a one-way link of this table — `__id is any of
   * <that link>` (the records it links to, CONTRACTS §13).
   */
  readonly condition: {
    readonly field: string;
    readonly operator: 'has_any_of' | 'is_any_of';
    readonly ref: string;
  };
}

interface LinkOptionsView {
  readonly link_table?: unknown;
  readonly bidirectional?: unknown;
  readonly symmetric_field_id?: unknown;
}

function linkOptions(field: FieldDto): LinkOptionsView {
  return field.options;
}

/**
 * The shortcuts: every link field of this table (a two-way one gives its
 * reverse field as condition, a one-way one the record ID condition), and
 * every link field of another readable table that points here (one-way
 * included) and is not the reverse of one above.
 */
export function linkShortcuts(
  tableId: string,
  currentFields: readonly FieldDto[],
  tables: readonly TableDto[],
  fieldsOf: (tableId: string) => readonly FieldDto[] | undefined,
): LinkShortcut[] {
  const result: LinkShortcut[] = [];
  const covered = new Set<string>();
  for (const field of currentFields) {
    if (field.type !== 'link') continue;
    const options = linkOptions(field);
    const target = tables.find((table) => table.id === options.link_table);
    if (target === undefined) continue;
    const reverse =
      options.bidirectional === true && typeof options.symmetric_field_id === 'string'
        ? (fieldsOf(target.id)?.find((item) => item.id === options.symmetric_field_id) ?? null)
        : null;
    if (reverse !== null) covered.add(reverse.id);
    result.push({
      key: `out:${field.id}`,
      linkField: field,
      direction: 'out',
      sourceTable: target,
      condition:
        reverse === null
          ? { field: RECORD_FIELD_ID, operator: 'is_any_of', ref: field.id }
          : { field: reverse.id, operator: 'has_any_of', ref: THIS_RECORD_REF },
    });
  }
  for (const table of tables) {
    for (const field of fieldsOf(table.id) ?? []) {
      if (field.type !== 'link' || covered.has(field.id)) continue;
      if (linkOptions(field).link_table !== tableId) continue;
      if (currentFields.some((own) => own.id === field.id)) continue; // self-link: listed above
      result.push({
        key: `in:${field.id}`,
        linkField: field,
        direction: 'in',
        sourceTable: table,
        condition: { field: field.id, operator: 'has_any_of', ref: THIS_RECORD_REF },
      });
    }
  }
  return result;
}

/**
 * The draft after choosing a shortcut: its source table, and the generated
 * condition first (editable, badge "auto").
 * Other conditions stay when the source table does not change.
 */
export function applyShortcut(draft: LookupDraft, shortcut: LinkShortcut): LookupDraft {
  const { condition } = shortcut;
  const sameSource = draft.from === shortcut.sourceTable.id;
  const first: LookupConditionDraft = {
    key: newConditionKey(),
    field: condition.field,
    operator: condition.operator,
    value: { kind: 'ref', ref: condition.ref },
    auto: true,
  };
  const others = sameSource ? draft.conditions.conditions.filter((item) => item.auto !== true) : [];
  return {
    ...draft,
    from: shortcut.sourceTable.id,
    select: sameSource ? draft.select : '',
    shortcut: shortcut.key,
    conditions: {
      op: draft.conditions.op,
      conditions: [first, ...others].slice(0, MAX_LOOKUP_CONDITIONS),
    },
  };
}

/** The draft with another source table: fields and conditions of the old one go. */
export function withSource(draft: LookupDraft, from: string): LookupDraft {
  if (from === draft.from) return draft;
  return { ...draft, from, select: '', conditions: EMPTY_CONDITIONS, shortcut: null };
}

/** The draft with another field taken: the aggregation and format stay only if still valid. */
export function withSelect(draft: LookupDraft, field: FieldDto | undefined): LookupDraft {
  const aggregates = aggregatesFor(field);
  const aggregate = aggregates.includes(draft.aggregate) ? draft.aggregate : 'raw_value';
  return {
    ...draft,
    select: field?.id ?? '',
    aggregate,
    style: 'source',
    currency: null,
  };
}

// ---------------------------------------------------------------------------
// Server errors

export interface CycleStep {
  readonly id: string;
  readonly name: string;
  readonly tableId: string;
}

/** The chain of a `422 FORMULA_CYCLE` (`errors[].params.cycle`), `null` for other errors. */
export function cycleOf(error: {
  readonly code: string;
  readonly errors: readonly { readonly params?: Readonly<Record<string, unknown>> | undefined }[];
}): CycleStep[] | null {
  if (error.code !== 'FORMULA_CYCLE') return null;
  for (const item of error.errors) {
    const cycle = item.params?.['cycle'];
    if (!Array.isArray(cycle)) continue;
    return cycle.flatMap((step: unknown) =>
      isObject(step) && typeof step['id'] === 'string'
        ? [
            {
              id: step['id'],
              name: typeof step['name'] === 'string' ? step['name'] : '',
              tableId: typeof step['table_id'] === 'string' ? step['table_id'] : '',
            },
          ]
        : [],
    );
  }
  return [];
}

/** The control a server error path (`options.select`, `options.where.items.0…`) belongs to. */
export type ErrorTarget = 'name' | 'from' | 'select' | 'where' | 'aggregate' | 'style' | 'other';

export function errorTargetOf(path: string): ErrorTarget {
  if (path === 'name') return 'name';
  const match = /^options\.(from|select|where|aggregate|style)(?:$|\.|\[)/u.exec(path);
  return match === null ? 'other' : (match[1] as ErrorTarget);
}
