import {
  FIELD_TYPE_REGISTRY,
  fieldConfigSchema,
  isS1FieldType,
  type FieldConfig,
} from '@cellhive/field-types';

import type { FormRendererField } from '../../../lib/forms/renderer';
import type { StoredFormField, StoredFormSettings, SubmissionLimit } from '@cellhive/contracts';

/**
 * Pure model of a form view (SPEC §8, CONTRACTS §15, §17): its questions
 * and the builder's edits. Every edit returns a whole `form` value — the
 * builder saves it through the view config state (T310) as one key.
 */

/** Settings of a form view without any saved `form` (a view created before its type had one). */
export const EMPTY_FORM: StoredFormSettings = {
  title: '',
  description: '',
  cover_attachment_id: null,
  fields: [],
  success_message: '',
  redirect_url: null,
  allow_multiple_submissions: true,
  require_login: false,
  submission_limit: 'none',
};

export function formSettingsOf(form: StoredFormSettings | undefined): StoredFormSettings {
  return form ?? EMPTY_FORM;
}

/**
 * A link question (T410): only `allow_multiple` matters to the form (a form
 * link's `meta` keeps nothing else, CONTRACTS §16A).
 */
export interface LinkQuestionConfig {
  readonly type: 'link';
  readonly options: { readonly allow_multiple: boolean };
}

/** Type and options of a question: a field config of `field-types`, or a link. */
export type QuestionConfig = FieldConfig | LinkQuestionConfig;

const configs = new WeakMap<FormRendererField, QuestionConfig | null>();

/**
 * Type and options of a field parsed by `field-types` (links: their
 * `allow_multiple`), or `null` for types without a form input (`parent`,
 * lookup, formula…) or options the client cannot read.
 */
export function fieldConfigOf(field: FormRendererField): QuestionConfig | null {
  const cached = configs.get(field);
  if (cached !== undefined) return cached;
  let config: QuestionConfig | null = null;
  if (field.type === 'link') {
    config = {
      type: 'link',
      options: { allow_multiple: field.options['allow_multiple'] !== false },
    };
  } else if (isS1FieldType(field.type) || field.type === 'attachment') {
    const parsed = fieldConfigSchema.safeParse({ type: field.type, options: field.options });
    config = parsed.success ? parsed.data : null;
  }
  configs.set(field, config);
  return config;
}

/**
 * Whether the builder offers a field as a question: a type people can give
 * a value for here (not computed, `created_*`, `updated_*`, `auto_number`,
 * `parent`). The server also refuses read-only types (`FIELD_READ_ONLY`,
 * CONTRACTS §15).
 */
export function canAsk(field: FormRendererField): boolean {
  const config = fieldConfigOf(field);
  if (config === null) return false;
  return config.type === 'link' || !FIELD_TYPE_REGISTRY[config.type].readOnly;
}

/** One question as the renderer and the builder show it. */
export interface FormQuestion {
  readonly field: FormRendererField;
  /** `null` when the field type has no form input. */
  readonly config: QuestionConfig | null;
  /** The question's own label, else the field name. */
  readonly label: string;
  readonly help: string | null;
  /** Required on the form, or by the table (which the form cannot relax). */
  readonly required: boolean;
  /** Required by the table: the builder can neither remove it nor make it optional. */
  readonly tableRequired: boolean;
}

/** The questions of a form, in order; questions on fields not in `fields` are left out. */
export function questionsOf(
  form: StoredFormSettings,
  fields: readonly FormRendererField[],
): FormQuestion[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  return form.fields.flatMap((item) => {
    const field = byId.get(item.field);
    if (field === undefined) return [];
    const tableRequired = field.required === true;
    const label = item.label?.trim() ?? '';
    return [
      {
        field,
        config: fieldConfigOf(field),
        label: label === '' ? field.name : label,
        help: item.help?.trim() === '' ? null : item.help,
        required: item.required || tableRequired,
        tableRequired,
      },
    ];
  });
}

/** Fields the builder may still add: askable, not on the form yet, in table order. */
export function addableFields(
  form: StoredFormSettings,
  fields: readonly FormRendererField[],
): FormRendererField[] {
  const used = new Set(form.fields.map((item) => item.field));
  return fields.filter((field) => !used.has(field.id) && canAsk(field));
}

/** Moves the question at `from` to `to` (indexes in `form.fields`). */
export function moveQuestion(
  form: StoredFormSettings,
  from: number,
  to: number,
): StoredFormSettings {
  if (from === to || from < 0 || to < 0) return form;
  if (from >= form.fields.length || to >= form.fields.length) return form;
  const fields = [...form.fields];
  const [moved] = fields.splice(from, 1);
  if (moved === undefined) return form;
  fields.splice(to, 0, moved);
  return { ...form, fields };
}

/** Adds a question at the end; a field required by the table is required on the form. */
export function addQuestion(
  form: StoredFormSettings,
  field: FormRendererField,
): StoredFormSettings {
  if (form.fields.some((item) => item.field === field.id)) return form;
  const question: StoredFormField = {
    field: field.id,
    required: field.required === true,
    label: null,
    help: null,
  };
  return { ...form, fields: [...form.fields, question] };
}

/** Removes a question (never one the table requires: the server would refuse the form). */
export function removeQuestion(
  form: StoredFormSettings,
  field: FormRendererField,
): StoredFormSettings {
  if (field.required === true) return form;
  return { ...form, fields: form.fields.filter((item) => item.field !== field.id) };
}

/** Changes the label, help or `required` of one question. */
export function updateQuestion(
  form: StoredFormSettings,
  fieldId: string,
  patch: Partial<Pick<StoredFormField, 'label' | 'help' | 'required'>>,
): StoredFormSettings {
  return {
    ...form,
    fields: form.fields.map((item) => (item.field === fieldId ? { ...item, ...patch } : item)),
  };
}

/**
 * Sign-in and submission limit together (CONTRACTS §17): a limit other than
 * `none` needs `require_login` (turning sign-in off resets the limit), and
 * `allow_multiple_submissions` follows the limit.
 */
export function withSubmissionRules(
  form: StoredFormSettings,
  rules: { requireLogin?: boolean; limit?: SubmissionLimit },
): StoredFormSettings {
  const requireLogin = rules.requireLogin ?? form.require_login;
  const limit = requireLogin ? (rules.limit ?? form.submission_limit) : 'none';
  return {
    ...form,
    require_login: requireLogin,
    submission_limit: limit,
    allow_multiple_submissions: limit === 'none',
  };
}

/** Longest redirect URL (CONTRACTS §15). */
export const MAX_REDIRECT_URL_LENGTH = 2048;

/**
 * A redirect URL the server accepts (`http`/`https`, absolute, CONTRACTS
 * §15), trimmed; `''` means none. `undefined` = not valid.
 */
export function redirectUrlOf(text: string): string | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_REDIRECT_URL_LENGTH) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : undefined;
  } catch {
    return undefined;
  }
}
