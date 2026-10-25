import {
  classifyConversion,
  computedSourceType,
  fieldConfigSchema,
  isConvertibleTarget,
  isS1FieldType,
  parseComputedStyle,
  planComputedConversion,
  type ComputedResultType,
  type ComputedSource,
  type ConversionKind,
  type S1FieldType,
} from '@cellhive/field-types';

import {
  CREATABLE_TYPES,
  draftOf,
  optionsOf,
  type DraftFieldType,
  type FieldDraft,
} from '../draft';

import type {
  ConversionSettingsInput,
  ConvertFieldPreview,
  ConvertFieldPreviewRequest,
  FieldDto,
  LinkConversionChangeName,
} from '@cellhive/contracts';

/**
 * Type conversion of a saved field from the field dialog (T414, T415;
 * CONTRACTS §4): which targets the type picker offers and why others are
 * refused, the body of `convert-preview` / `PUT /fields/:id` for a draft,
 * and what the preview asks the user to confirm. Pure functions only.
 */

/** Why a target type cannot be chosen (translated as `field:convert.reasons.<reason>`). */
export type TargetRefusal =
  /** Created/modified time or by, auto number: no column of their own (CONTRACTS §4.4). */
  | 'noColumn'
  /** Link and attachment: never converted to or from another type (CONTRACTS §4.3). */
  | 'otherKind'
  /** The source (link, attachment, …) never changes type. */
  | 'fixedSource'
  /** (T469) The primary field never becomes a formula or lookup (CONTRACTS §4.1). */
  | 'primaryField';

export interface TargetChoice {
  readonly type: DraftFieldType;
  /**
   * `none` for the current type; else the kind with default options and no
   * settings (a `blacklist` checkbox/user target becomes `keep` with truthy
   * values / member emails).
   */
  readonly kind: ConversionKind;
  readonly refusal: TargetRefusal | null;
}

/** Options of a field (or a fresh type) parsed and defaulted by `field-types`. */
function parsedOptions(type: S1FieldType, options: unknown): unknown {
  const parsed = fieldConfigSchema.safeParse({ type, options: options ?? {} });
  if (parsed.success) return parsed.data.options;
  return fieldConfigSchema.parse({ type }).options;
}

/** (T463, T469) Formula and lookup: computed fields. */
export type ComputedType = 'formula' | 'lookup';

export function isComputedType(type: string): type is ComputedType {
  return type === 'formula' || type === 'lookup';
}

/**
 * A formula/lookup field as a conversion source (CONTRACTS §4.1): its
 * result type and style. Unknown result (definition hidden, `null` kind):
 * read as text.
 */
export function computedSourceOf(
  field: Pick<FieldDto, 'options'> & Partial<Pick<FieldDto, 'result_type'>>,
): ComputedSource {
  const known = field.result_type;
  const result: ComputedResultType =
    known === undefined || known.kind === 'null' ? { kind: 'text', list: false } : known;
  const style = parseComputedStyle(field.options['style'] ?? null, result);
  return { result, style: style.ok ? style.style : null };
}

/**
 * (T469) The stored type a formula/lookup becomes with "Convert to static
 * values": the type of its result (number → number, boolean → checkbox,
 * dates → date, users → user), text for anything else (records, files,
 * lists of numbers/dates: their display text).
 */
export function staticTypeOf(
  field: Pick<FieldDto, 'options'> & Partial<Pick<FieldDto, 'result_type'>>,
): S1FieldType {
  const { result } = computedSourceOf(field);
  switch (result.kind) {
    case 'number':
      return result.list ? 'text' : 'number';
    case 'boolean':
      return result.list ? 'text' : 'checkbox';
    case 'date':
    case 'datetime':
      return result.list ? 'text' : 'datetime';
    case 'user':
      return 'user';
    default:
      return 'text';
  }
}

/**
 * Whether the type of `field` can change at all: S1 types and (T463)
 * formula/lookup; never link, attachment, parent.
 */
export function canChangeType(field: Pick<FieldDto, 'type'>): boolean {
  return isS1FieldType(field.type) || isComputedType(field.type);
}

type ChoiceSource = Pick<FieldDto, 'type' | 'options'> &
  Partial<Pick<FieldDto, 'result_type' | 'is_primary'>>;

/** Every type of the picker with what choosing it would do, in the picker's order. */
export function targetChoices(field: ChoiceSource): TargetChoice[] {
  return CREATABLE_TYPES.map((type): TargetChoice => {
    if (type === field.type) return { type, kind: 'none', refusal: null };
    // A button (T525) has no column: nothing becomes one (CONVERSION_NOT_ALLOWED).
    if (type === 'link' || type === 'attachment' || type === 'button') {
      return {
        type,
        kind: 'forbidden',
        refusal: canChangeType(field) ? 'otherKind' : 'fixedSource',
      };
    }
    if (isComputedType(field.type)) {
      // "Convert to static values" (T463): the rules of the result type; formula ↔ lookup keeps.
      if (isComputedType(type)) return { type, kind: 'keep', refusal: null };
      if (!isS1FieldType(type) || !isConvertibleTarget(type)) {
        return { type, kind: 'forbidden', refusal: 'noColumn' };
      }
      const kind = planComputedConversion(computedSourceOf(field), {
        type,
        options: parsedOptions(type, {}),
      }).kind;
      return { type, kind, refusal: kind === 'forbidden' ? 'noColumn' : null };
    }
    if (!isS1FieldType(field.type)) return { type, kind: 'forbidden', refusal: 'fixedSource' };
    if (isComputedType(type)) {
      // Any S1 field but the primary one may become computed (T463): old values kept 7 days.
      return field.is_primary === true
        ? { type, kind: 'forbidden', refusal: 'primaryField' }
        : { type, kind: 'keep', refusal: null };
    }
    const kind = classifyConversion(
      { type: field.type, options: parsedOptions(field.type, field.options) },
      { type, options: parsedOptions(type, {}) },
    );
    return { type, kind, refusal: kind === 'forbidden' ? 'noColumn' : null };
  });
}

/**
 * The type whose conversion rules apply to `field` for a target: its own
 * type, or for a formula/lookup the type of its result as that target
 * reads it (CONTRACTS §4.1: text and select read the display text).
 */
export function sourceTypeOf(field: FieldDto, target: string): string {
  return isComputedType(field.type)
    ? computedSourceType(computedSourceOf(field), target)
    : field.type;
}

/** (T469) Body of `convert-preview`/`PUT` turning a field into a lookup with these options. */
export function computedConversionRequest(
  type: ComputedType,
  options: Readonly<Record<string, unknown>>,
): ConvertFieldPreviewRequest {
  return { type, options: { ...options } };
}

/** Choices grouped for the picker: keep, truncate, lose, refused. */
export const CHOICE_GROUPS = ['keep', 'truncate', 'blacklist', 'forbidden'] as const;
export type ChoiceGroup = (typeof CHOICE_GROUPS)[number];

export function groupOf(choice: TargetChoice): ChoiceGroup | 'current' {
  if (choice.kind === 'none') return 'current';
  return choice.kind;
}

/**
 * Conversion settings the dialog asks for (CONTRACTS §4.1, §4.3) per pair:
 * `select` ← text/number: create options or keep matching ones;
 * `checkbox` ← text/select: the values read as checked; `user` ← text:
 * values are member emails.
 */
export type SettingsKind = 'selectMatch' | 'truthyValues' | 'matchEmail' | null;

export function settingsKindOf(from: string, to: string): SettingsKind {
  if (to === 'select' && (from === 'text' || from === 'number' || from === 'auto_number')) {
    return 'selectMatch';
  }
  if (to === 'checkbox' && (from === 'text' || from === 'select' || from === 'auto_number')) {
    return 'truthyValues';
  }
  if (to === 'user' && (from === 'text' || from === 'auto_number')) return 'matchEmail';
  return null;
}

/** What the dialog keeps of the conversion settings while the user edits them. */
export interface ConversionSettingsDraft {
  readonly matchExistingOnly: boolean;
  /** Comma separated, as typed ("Có, x, yes"). */
  readonly truthyValues: string;
  readonly matchEmail: boolean;
}

export const EMPTY_SETTINGS: ConversionSettingsDraft = {
  matchExistingOnly: false,
  truthyValues: '',
  matchEmail: false,
};

/** Values typed into the "checked values" box (trimmed, no empties, no repeats). */
export function truthyValuesOf(text: string): string[] {
  const values = text
    .split(/[,;\n]/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return [...new Set(values)];
}

function settingsOf(
  kind: SettingsKind,
  draft: ConversionSettingsDraft,
): ConversionSettingsInput | undefined {
  switch (kind) {
    case 'selectMatch':
      return draft.matchExistingOnly ? { match_existing_only: true } : undefined;
    case 'truthyValues': {
      const values = truthyValuesOf(draft.truthyValues);
      return values.length === 0 ? undefined : { truthy_values: values };
    }
    case 'matchEmail':
      return draft.matchEmail ? { match_email: true } : undefined;
    case null:
      return undefined;
  }
}

/** The link change a draft asks for (T415), or `null`. */
export function linkChangeOf(field: FieldDto, draft: FieldDraft): LinkConversionChangeName | null {
  if (field.type !== 'link' || draft.type !== 'link') return null;
  const before = draftOf(field).link;
  const after = draft.link;
  if ((before.bidirectional === true) !== (after.bidirectional === true)) {
    return after.bidirectional === true ? 'to_two_way' : 'to_one_way';
  }
  if (before.allowMultiple && !after.allowMultiple) return 'to_single';
  return null;
}

/**
 * Body of `convert-preview` (and, with the confirmations, `PUT`) for the
 * draft of a saved field; `null` when the draft needs no conversion.
 * Link fields send only the key that changes (the server merges it,
 * CONTRACTS §4.4); other types the full new definition.
 */
export function conversionRequestOf(
  field: FieldDto,
  draft: FieldDraft,
  settings: ConversionSettingsDraft = EMPTY_SETTINGS,
): ConvertFieldPreviewRequest | null {
  if (field.type === 'link') {
    const change = linkChangeOf(field, draft);
    switch (change) {
      case 'to_two_way':
        return {
          type: 'link',
          options: {
            bidirectional: true,
            bidirectional_link_field_name: (draft.link.reverseName ?? '').trim(),
          },
        };
      case 'to_one_way':
        return { type: 'link', options: { bidirectional: false } };
      case 'to_single':
        return { type: 'link', options: { allow_multiple: false } };
      case null:
        return null;
    }
  }
  const before = draftOf(field);
  const typeChanged = draft.type !== field.type;
  const single =
    (draft.type === 'select' && before.select.multiple && !draft.select.multiple) ||
    (draft.type === 'user' && before.user.multiple && !draft.user.multiple);
  if (!typeChanged && !single) return null;
  // (T469) To a lookup: its editor builds the options (`computedConversionRequest`).
  if (draft.type === 'lookup') return null;
  // To a formula: nothing to preview until there is an expression.
  if (draft.type === 'formula' && draft.formula.expression.trim() === '') return null;
  const options = optionsOf(draft);
  const conversion = settingsOf(
    settingsKindOf(sourceTypeOf(field, draft.type), draft.type),
    settings,
  );
  return {
    type: draft.type,
    ...(options === undefined ? {} : { options }),
    ...(conversion === undefined ? {} : { conversion }),
  };
}

/**
 * A `text` field switching to the `email`/`phone` style: nothing changes
 * stored (a plain save), but the preview counts the cells that do not
 * match the format (CONTRACTS §4.1, SPEC §5.5 item 5).
 */
export function styleCheckOf(
  field: FieldDto,
  draft: FieldDraft,
): ConvertFieldPreviewRequest | null {
  if (field.type !== 'text' || draft.type !== 'text') return null;
  const style = draft.text.style.type;
  if (style !== 'email' && style !== 'phone') return null;
  if (draftOf(field).text.style.type === style) return null;
  const options = optionsOf(draft);
  return { type: 'text', ...(options === undefined ? {} : { options }) };
}

/** What the user must tick before `PUT` (CONTRACTS §4.4). */
export interface RequiredConsents {
  /** `confirm`: values lost or cut, or dependents of a removed side. */
  readonly confirm: boolean;
  /** `accept_data_loss`: every value of the column is dropped. */
  readonly acceptDataLoss: boolean;
}

export function requiredConsents(preview: ConvertFieldPreview): RequiredConsents {
  return {
    confirm: preview.requires_confirm || preview.lost > 0 || preview.truncated > 0,
    acceptDataLoss: preview.requires_accept_data_loss,
  };
}

/** A preview that `PUT` would refuse whatever the user ticks. */
export function isRefused(preview: ConvertFieldPreview): boolean {
  return !preview.allowed || preview.kind === 'forbidden';
}

/** Text of a sample value (json read shape, CONTRACTS §2) for the before → after table. */
export function sampleText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '✓' : '';
  if (Array.isArray(value)) {
    return value
      .map(sampleText)
      .filter((part) => part !== '')
      .join(', ');
  }
  if (typeof value === 'object') {
    const ref = value as Record<string, unknown>;
    for (const key of ['name', 'title', 'email', 'id']) {
      const item = ref[key];
      if (typeof item === 'string' && item !== '') return item;
    }
  }
  return '';
}

/** Names of a select sample value after the conversion (one or several). */
export function sampleNames(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(sampleNames);
  if (typeof value === 'object' && value !== null) {
    const name = (value as Record<string, unknown>)['name'];
    return typeof name === 'string' ? [name] : [];
  }
  return [];
}
