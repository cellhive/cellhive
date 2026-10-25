import {
  buttonFieldOptionsSchema,
  createFieldRequestSchema,
  newId,
  type CreateFieldRequest,
  type FieldDto,
  type UpdateFieldRequest,
} from '@cellhive/contracts';
import {
  attachmentOptionsSchema,
  autoNumberOptionsSchema,
  datetimeOptionsSchema,
  fieldConfigSchema,
  isS1FieldType,
  linkOptionsSchema,
  numberOptionsSchema,
  selectOptionsSchema,
  systemTimeOptionsSchema,
  textOptionsSchema,
  userOptionsSchema,
  type AttachmentOptions,
  type AutoNumberOptions,
  type DatetimeOptions,
  type FieldConfig,
  type NumberOptions,
  type NumberStyle,
  type S1FieldType,
  type SystemTimeOptions,
  type TextOptions,
  isDateOnlyFormat,
} from '@cellhive/field-types';
import { z } from 'zod';

import { issueToDetail, type Detail } from '../../lib/forms/zod-form';

import {
  reminderDraftOf,
  reminderIssues,
  reminderOptionsOf,
  type ReminderDraft,
} from './datetime/reminder/draft';

import type { FormulaDraft } from '../../lib/schema/formula-tools';

/**
 * The field configuration form (T207) as plain data: every type keeps its
 * own options, so switching the type back and forth while creating a field
 * loses nothing. Pure functions only; the components render and edit it.
 */

/** Number of select option colors of the palette (`--option-0..7`, FRONTEND §9.3). */
export const OPTION_PALETTE_SIZE = 8;

/** A select option being edited. `id` is `null` until the server has it. */
export interface OptionDraft {
  /** Stable key for React and drag and drop (the id, or a client-made one). */
  readonly key: string;
  readonly id: string | null;
  readonly name: string;
  readonly color: number;
  /** A saved option marked for deletion (values are removed by a job on save). */
  readonly deleted: boolean;
}

export interface SelectDraft {
  readonly multiple: boolean;
  readonly options: readonly OptionDraft[];
  /** Id of the default option (single select, saved options only), or `null`. */
  readonly defaultOptionId: string | null;
}

export interface UserDraft {
  readonly multiple: boolean;
  readonly notifyOnAssign: boolean;
  /** Default to the person who creates the record (`$slot: current_user`). */
  readonly defaultCurrentUser: boolean;
  /** Other default entries (fixed users) kept as they are. */
  readonly otherDefaults: readonly { readonly id: string }[];
}

/**
 * A link field (T413, basic form): the linked table (fixed once created,
 * BACKLOG S4 design decision #5), one or several records, and the records
 * that may be linked (`record_filter`). Two-way links and conversions are
 * T415.
 */
export interface LinkDraft {
  /** `''` until a table is chosen. */
  readonly linkTable: string;
  readonly allowMultiple: boolean;
  readonly recordFilter: Readonly<Record<string, unknown>> | null;
  /**
   * (T415) The linked table shows the links too (ADR-28): a reverse field
   * named `reverseName` shares the junction. Turning it on or off on a
   * saved field is a conversion (`to_two_way` / `to_one_way`).
   */
  readonly bidirectional?: boolean;
  /** Name of the reverse field when two-way (`bidirectional_link_field_name`). */
  readonly reverseName?: string;
  /** The reverse field of a saved two-way link (read-only). */
  readonly symmetricFieldId?: string | null;
}

/**
 * Types the dialog creates and edits: S1, `attachment` (T418), `link`
 * (T413), `formula` (T466) and `lookup` (T467: configured by
 * `features/lookup`, given by the route; this form keeps only its name
 * and description).
 */
export type DraftFieldType = S1FieldType | 'attachment' | 'link' | 'formula' | 'lookup' | 'button';
/** Same as {@link DraftFieldType} (name used by the T413 code). */
export type FieldDraftType = DraftFieldType;

/**
 * `attachment` options being edited (T418): `accept` as picked, `max_files`
 * and `blocked_extensions` as typed (validated with the field-types schema).
 */
export interface AttachmentDraft {
  readonly accept: readonly string[] | null;
  readonly maxFiles: string;
  /** Extensions separated by commas or spaces ("exe, msi .bat"). */
  readonly blocked: string;
}

/**
 * A `button` field (T525, CONTRACTS §2): the label on the button (empty:
 * the field's name), its palette color and the confirmation asked before a
 * click is sent. What the click does is the automation's (`button.clicked`).
 */
export interface ButtonDraft {
  readonly label: string;
  readonly color: number;
  readonly confirm: boolean;
  readonly confirmTitle: string;
  readonly confirmMessage: string;
  readonly confirmLabel: string;
}

export interface FieldDraft {
  readonly name: string;
  readonly type: DraftFieldType;
  readonly description: string;
  readonly required: boolean;
  readonly unique: boolean;
  readonly text: TextOptions;
  readonly number: NumberOptions;
  readonly select: SelectDraft;
  readonly datetime: DatetimeOptions;
  /** (T554) The date reminder of a `datetime` field (`options.reminder`). */
  readonly reminder: ReminderDraft;
  readonly user: UserDraft;
  readonly systemTime: SystemTimeOptions;
  readonly autoNumber: AutoNumberOptions;
  readonly link: LinkDraft;
  readonly attachment: AttachmentDraft;
  /** (T466) The formula as written (names) and the style of its result. */
  readonly formula: FormulaDraft;
  /** (T525) Label, color and confirmation of a button. */
  readonly button: ButtonDraft;
}

/** Extensions typed into the "blocked" box, as `blocked_extensions` (lower case, no dot, no repeats). */
export function blockedExtensionsOf(text: string): string[] {
  const list = text
    .split(/[\s,;]+/u)
    .map((part) => part.trim().toLowerCase().replace(/^\./u, ''))
    .filter((part) => part !== '');
  return [...new Set(list)];
}

function attachmentDraftOf(options: AttachmentOptions): AttachmentDraft {
  return {
    accept: options.accept,
    maxFiles: String(options.max_files),
    blocked: options.blocked_extensions.join(', '),
  };
}

/** Types whose values users write: they can be required (SPEC §5.5). */
export const REQUIRABLE_TYPES: ReadonlySet<DraftFieldType> = new Set([
  'text',
  'number',
  'select',
  'datetime',
  'checkbox',
  'user',
]);

/** Types with a unique index (server `UNIQUE_CAPABLE_TYPES`). */
export const UNIQUE_TYPES: ReadonlySet<DraftFieldType> = new Set([
  'text',
  'number',
  'datetime',
  'auto_number',
]);

/** Types offered when creating a field: every S1 type, and attachments (T418). */
export const CREATABLE_TYPES: readonly DraftFieldType[] = [
  'text',
  'number',
  'select',
  'datetime',
  'checkbox',
  'user',
  'link',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'auto_number',
  'attachment',
  'formula',
  'lookup',
  'button',
];

/** Default style of each number style type (switching style starts from these). */
export function defaultNumberStyle(type: NumberStyle['type'], currency: string): NumberStyle {
  switch (type) {
    case 'plain':
      return { type: 'plain', precision: 0, percentage: false, thousands_separator: false };
    case 'currency':
      return { type: 'currency', currency_code: currency };
    case 'progress':
      return { type: 'progress', percentage: true };
    case 'rating':
      return { type: 'rating', icon: 'star', min: 1, max: 5 };
  }
}

export function newOption(name: string, color: number): OptionDraft {
  return { key: newId('opt'), id: null, name, color, deleted: false };
}

function parseOr<T>(schema: z.ZodType<T>, value: unknown, fallback: unknown = {}): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : schema.parse(fallback);
}

/** Formula options of a saved field (the API gives the expression with current names). */
function formulaDraftOf(options: Readonly<Record<string, unknown>>): FormulaDraft {
  const expression = options['expression'];
  const style = options['style'];
  return {
    expression: typeof expression === 'string' ? expression : '',
    style:
      typeof style === 'object' && style !== null && !Array.isArray(style)
        ? (style as Readonly<Record<string, unknown>>)
        : null,
    styleTouched: false,
  };
}

/** Button options of a saved field; a new button starts with the name as its label. */
function buttonDraftOf(options: Readonly<Record<string, unknown>>, saved: boolean): ButtonDraft {
  const parsed = buttonFieldOptionsSchema.safeParse(options);
  const value = parsed.success ? parsed.data : buttonFieldOptionsSchema.parse({});
  return {
    label: saved ? value.label : '',
    color: value.color,
    confirm: value.confirm !== null,
    confirmTitle: value.confirm?.title ?? '',
    confirmMessage: value.confirm?.message ?? '',
    confirmLabel: value.confirm?.confirm_label ?? '',
  };
}

/** The label a button is saved with: the typed one, else the field's name. */
export function buttonLabelOf(draft: Pick<FieldDraft, 'name' | 'button'>): string {
  const label = draft.button.label.trim();
  return label === '' ? draft.name.trim() : label;
}

/** A fresh form; `field` given: the form of that field. */
export function draftOf(field?: FieldDto): FieldDraft {
  // (T469) A formula/lookup converted to a number or date starts with its result's style.
  const computedStyle =
    field !== undefined && (field.type === 'formula' || field.type === 'lookup')
      ? field.options['style']
      : undefined;
  const own = (type: DraftFieldType) => {
    if (field !== undefined && field.type === type) return field.options;
    if (computedStyle !== undefined && computedStyle !== null) {
      const kind = field?.result_type?.kind;
      if (type === 'number' && kind === 'number') return { style: computedStyle };
      if (type === 'datetime' && (kind === 'date' || kind === 'datetime')) {
        return { style: computedStyle };
      }
    }
    return {};
  };
  const select = parseOr(selectOptionsSchema, own('select'));
  const user = parseOr(userOptionsSchema, own('user'));
  const userDefaults = user.default_value ?? [];
  const selectDefault = select.default_value;
  const link = linkOptionsSchema.safeParse(own('link'));
  const datetime = parseOr(datetimeOptionsSchema, own('datetime'));
  return {
    name: field?.name ?? '',
    type:
      field !== undefined &&
      (isS1FieldType(field.type) ||
        field.type === 'attachment' ||
        field.type === 'link' ||
        field.type === 'formula' ||
        field.type === 'lookup' ||
        field.type === 'button')
        ? field.type
        : 'text',
    description: field?.description ?? '',
    required: field?.required ?? false,
    unique: field?.unique_values ?? false,
    text: parseOr(textOptionsSchema, own('text')),
    number: parseOr(numberOptionsSchema, own('number')),
    select: {
      multiple: select.multiple,
      options: select.options.map((option, index) => ({
        key: option.id,
        id: option.id,
        name: option.name,
        color: option.color ?? index % OPTION_PALETTE_SIZE,
        deleted: false,
      })),
      defaultOptionId: typeof selectDefault === 'string' ? selectDefault : null,
    },
    datetime,
    reminder: reminderDraftOf(datetime.reminder),
    user: {
      multiple: user.multiple,
      notifyOnAssign: user.notify_on_assign,
      defaultCurrentUser: userDefaults.some((entry) => '$slot' in entry),
      otherDefaults: userDefaults.flatMap((entry) => ('id' in entry ? [{ id: entry.id }] : [])),
    },
    systemTime: parseOr(
      systemTimeOptionsSchema,
      field !== undefined && (field.type === 'created_at' || field.type === 'updated_at')
        ? field.options
        : {},
    ),
    autoNumber: parseOr(autoNumberOptionsSchema, own('auto_number')),
    link: link.success
      ? {
          linkTable: link.data.link_table,
          allowMultiple: link.data.allow_multiple,
          recordFilter: link.data.record_filter,
          ...(link.data.bidirectional
            ? {
                bidirectional: true,
                reverseName: link.data.bidirectional_link_field_name ?? '',
                symmetricFieldId: link.data.symmetric_field_id,
              }
            : {}),
        }
      : { linkTable: '', allowMultiple: true, recordFilter: null },
    attachment: attachmentDraftOf(parseOr(attachmentOptionsSchema, own('attachment'))),
    formula: formulaDraftOf(own('formula')),
    button: buttonDraftOf(own('button'), field?.type === 'button'),
  };
}

/**
 * `options` of the create/update body for the draft's type; `undefined`
 * for types without options. `forValidation`: new select options get their
 * client key as id so that the `field-types` schema can check them.
 */
export function optionsOf(
  draft: FieldDraft,
  forValidation = false,
): Record<string, unknown> | undefined {
  switch (draft.type) {
    case 'text': {
      const fallback = draft.text.default_value ?? '';
      return { style: draft.text.style, default_value: fallback === '' ? null : fallback };
    }
    case 'number':
      return { style: draft.number.style, default_value: draft.number.default_value ?? null };
    case 'select': {
      const live = draft.select.options.filter((option) => !option.deleted);
      const options = live.map((option) => {
        const id = option.id ?? (forValidation ? option.key : null);
        return id === null
          ? { name: option.name.trim(), color: option.color }
          : { id, name: option.name.trim(), color: option.color };
      });
      const fallback = draft.select.defaultOptionId;
      const keepDefault =
        !draft.select.multiple &&
        fallback !== null &&
        live.some((option) => option.id === fallback);
      return {
        multiple: draft.select.multiple,
        options,
        // A multiple select keeps its current default (not edited here).
        ...(draft.select.multiple ? {} : { default_value: keepDefault ? fallback : null }),
      };
    }
    case 'datetime': {
      const { timezone, ...rest } = draft.datetime;
      return {
        style: rest.style,
        default_value: rest.default_value ?? null,
        ...(timezone === undefined ? {} : { timezone }),
        ...reminderOptionsOf(draft.reminder, isDateOnlyFormat(rest.style.format)),
      };
    }
    case 'user': {
      const defaults = [
        ...(draft.user.defaultCurrentUser ? [{ $slot: 'current_user' as const }] : []),
        ...draft.user.otherDefaults,
      ];
      return {
        multiple: draft.user.multiple,
        notify_on_assign: draft.user.notifyOnAssign,
        default_value: defaults.length === 0 ? null : defaults,
      };
    }
    case 'created_at':
    case 'updated_at': {
      const { timezone, style } = draft.systemTime;
      return { style, ...(timezone === undefined ? {} : { timezone }) };
    }
    case 'auto_number':
      return { style: draft.autoNumber.style };
    case 'link':
      return {
        link_table: draft.link.linkTable,
        allow_multiple: draft.link.allowMultiple,
        record_filter: draft.link.recordFilter,
        // Two-way (T415): the reverse field is created in the linked table.
        ...(draft.link.bidirectional === true
          ? {
              bidirectional: true,
              bidirectional_link_field_name: (draft.link.reverseName ?? '').trim(),
            }
          : {}),
      };
    case 'attachment': {
      const typed = draft.attachment.maxFiles.trim();
      const maxFiles = /^\d+$/u.test(typed) ? Number(typed) : typed;
      return {
        accept: draft.attachment.accept === null ? null : [...draft.attachment.accept],
        max_files: maxFiles,
        blocked_extensions: blockedExtensionsOf(draft.attachment.blocked),
      };
    }
    case 'formula':
      // The style is sent only when chosen: else the server keeps the carried field's (CONTRACTS §13).
      return {
        expression: draft.formula.expression.trim(),
        ...(draft.formula.styleTouched ? { style: draft.formula.style } : {}),
      };
    case 'button':
      return {
        label: buttonLabelOf(draft),
        color: draft.button.color,
        confirm: draft.button.confirm
          ? {
              title: draft.button.confirmTitle.trim(),
              message: draft.button.confirmMessage.trim(),
              confirm_label: draft.button.confirmLabel.trim(),
            }
          : null,
      };
    // Lookup options come from the lookup editor (T467).
    case 'checkbox':
    case 'created_by':
    case 'updated_by':
    case 'lookup':
      return undefined;
  }
}

/** A problem of the form: a detail code at a path of the draft. */
export interface DraftIssue {
  /** `name`, `description`, `options.<path>` or `option.<key>.name`. */
  readonly path: string;
  readonly detail: Detail;
}

const nameSchema = createFieldRequestSchema.shape.name;
const descriptionSchema = createFieldRequestSchema.shape.description.unwrap().unwrap();

/**
 * Validates the draft with the same schemas as the server (`contracts` for
 * name/description, `field-types` for the options). Returns the parsed
 * config (for the preview) and the issues.
 */
export function validateDraft(draft: FieldDraft): {
  readonly issues: readonly DraftIssue[];
  readonly config: FieldConfig | null;
} {
  const issues: DraftIssue[] = [];
  const name = nameSchema.safeParse(draft.name, { reportInput: true });
  if (!name.success) {
    const first = name.error.issues[0];
    if (first !== undefined) issues.push({ path: 'name', detail: issueToDetail(first) });
  }
  const description = descriptionSchema.safeParse(draft.description, { reportInput: true });
  if (!description.success) {
    const first = description.error.issues[0];
    if (first !== undefined) issues.push({ path: 'description', detail: issueToDetail(first) });
  }

  // Select option names: required and distinct (the schema's messages are English only).
  const liveOptions = draft.type === 'select' ? draft.select.options.filter((o) => !o.deleted) : [];
  const seen = new Set<string>();
  for (const option of liveOptions) {
    const trimmed = option.name.trim();
    if (trimmed === '') {
      issues.push({ path: `option.${option.key}.name`, detail: { code: 'REQUIRED' } });
    } else if (seen.has(trimmed)) {
      issues.push({ path: `option.${option.key}.name`, detail: { code: 'DUPLICATE_OPTION' } });
    }
    seen.add(trimmed);
  }

  const options = optionsOf(draft, true);
  // (T554) The reminder's own checks first: clearer messages than the schema's at the same paths.
  if (draft.type === 'datetime') issues.push(...reminderIssues(draft.reminder));
  if (draft.type === 'link') {
    // Link options (T413): a linked table must be chosen; the server checks the filter.
    if (draft.link.linkTable === '') {
      issues.push({ path: 'options.link_table', detail: { code: 'REQUIRED' } });
    }
    if (draft.link.bidirectional === true && (draft.link.reverseName ?? '').trim() === '') {
      issues.push({
        path: 'options.bidirectional_link_field_name',
        detail: { code: 'REQUIRED' },
      });
    }
    return { issues, config: null };
  }
  if (draft.type === 'button') {
    // (T525) Button options are not in the registry: the contract schema checks them.
    const button = buttonFieldOptionsSchema.safeParse(options);
    if (!button.success) {
      for (const issue of button.error.issues) {
        const key = ['options', ...issue.path.map(String)].join('.');
        if (!issues.some((known) => known.path === key)) {
          issues.push({ path: key, detail: issueToDetail(issue) });
        }
      }
    }
    return { issues, config: null };
  }
  if (draft.type === 'formula') {
    // The formula itself is checked by its editor (T466) and by the server.
    if (draft.formula.expression.trim() === '') {
      issues.push({ path: 'options.expression', detail: { code: 'REQUIRED' } });
    }
    return { issues, config: null };
  }
  const parsed = fieldConfigSchema.safeParse({
    type: draft.type,
    ...(options === undefined ? {} : { options }),
  });
  if (parsed.success) return { issues, config: parsed.data };
  for (const issue of parsed.error.issues) {
    const path = issue.path.map(String);
    // `options.options.<index>.<key>` → the option row.
    if (path[0] === 'options' && path[1] === 'options' && path[2] !== undefined) {
      const option = liveOptions[Number(path[2])];
      if (option !== undefined) {
        const key = `option.${option.key}.name`;
        if (!issues.some((known) => known.path === key)) {
          issues.push({ path: key, detail: issueToDetail(issue) });
        }
        continue;
      }
    }
    const key = path.join('.');
    if (!issues.some((known) => known.path === key)) {
      issues.push({ path: key, detail: issueToDetail(issue) });
    }
  }
  return { issues, config: null };
}

/** Body of `POST /tables/:id/fields`. */
export function createBody(draft: FieldDraft): CreateFieldRequest {
  const options = optionsOf(draft);
  const description = draft.description.trim();
  return {
    name: draft.name.trim(),
    type: draft.type,
    ...(options === undefined ? {} : { options }),
    ...(description === '' ? {} : { description }),
    ...(REQUIRABLE_TYPES.has(draft.type) && draft.required ? { required: true } : {}),
    ...(UNIQUE_TYPES.has(draft.type) && draft.unique ? { unique_values: true } : {}),
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Body of `PATCH /fields/:id` with only what changed; `null` when nothing
 * did. The type never changes here (conversion is `PUT`, S4).
 */
export function updateBody(field: FieldDto, draft: FieldDraft): UpdateFieldRequest | null {
  const before = draftOf(field);
  const body: Record<string, unknown> = {};
  const name = draft.name.trim();
  if (name !== field.name) body['name'] = name;
  const description = draft.description.trim();
  if (description !== (field.description ?? '')) {
    body['description'] = description === '' ? null : description;
  }
  if (REQUIRABLE_TYPES.has(draft.type) && draft.required !== field.required) {
    body['required'] = draft.required;
  }
  if (UNIQUE_TYPES.has(draft.type) && draft.unique !== field.unique_values) {
    body['unique_values'] = draft.unique;
  }
  if (draft.type === 'link') {
    // The linked table never changes (decision #5); `allow_multiple` false → true and
    // `record_filter` may (true → false is a conversion, T415).
    const link: Record<string, unknown> = {};
    // Several → one and one-way ↔ two-way are conversions (`PUT`, T415), not sent here.
    if (draft.link.allowMultiple && !before.link.allowMultiple) {
      link['allow_multiple'] = true;
    }
    if (!sameJson(draft.link.recordFilter, before.link.recordFilter)) {
      link['record_filter'] = draft.link.recordFilter;
    }
    if (Object.keys(link).length > 0) body['options'] = link;
    return Object.keys(body).length === 0 ? null : body;
  }
  if (draft.type === 'formula') {
    // `expression` and/or `style`, each only when changed (CONTRACTS §13).
    const formula: Record<string, unknown> = {};
    const expression = draft.formula.expression.trim();
    if (expression !== before.formula.expression.trim()) formula['expression'] = expression;
    if (draft.formula.styleTouched && !sameJson(draft.formula.style, before.formula.style)) {
      formula['style'] = draft.formula.style;
    }
    if (Object.keys(formula).length > 0) body['options'] = formula;
    return Object.keys(body).length === 0 ? null : body;
  }
  const options = optionsOf(draft);
  if (options !== undefined && !sameJson(options, optionsOf({ ...before, type: draft.type }))) {
    body['options'] = options;
  }
  return Object.keys(body).length === 0 ? null : body;
}

/** Saved select options the draft deletes (their values are removed by a job). */
export function deletedOptions(draft: FieldDraft): readonly OptionDraft[] {
  return draft.type === 'select'
    ? draft.select.options.filter((option) => option.deleted && option.id !== null)
    : [];
}

/**
 * The draft asks for a type conversion (another type, or single value from
 * multiple): `PUT /fields/:id`, refused until S4 (CONTRACTS §4).
 */
export function needsConversion(field: FieldDto, draft: FieldDraft): boolean {
  if (draft.type !== field.type) return true;
  const before = draftOf(field);
  if (draft.type === 'select') return before.select.multiple && !draft.select.multiple;
  if (draft.type === 'user') return before.user.multiple && !draft.user.multiple;
  if (draft.type === 'link') {
    return (
      (before.link.allowMultiple && !draft.link.allowMultiple) ||
      (before.link.bidirectional === true) !== (draft.link.bidirectional === true)
    );
  }
  return false;
}
