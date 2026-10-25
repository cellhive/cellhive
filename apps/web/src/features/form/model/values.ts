import {
  CHECKBOX_TRUE_STRINGS,
  datetimeFieldType,
  findSelectOption,
  type LocaleContext,
} from '@cellhive/field-types';

import {
  datetimeDraft,
  datetimeInputText,
  numberDraft,
  numberInputText,
  selectDraft,
  textDraft,
  userDraft,
} from '../../../grid/editors/parse';

import type { FormQuestion, QuestionConfig } from './questions';
import type { EditorIssue } from '../../../grid/editors/types';
import type { FormMember } from '../../../lib/forms/renderer';

/**
 * What the inputs of a form hold, by question (T315): text as typed for
 * text, number and date inputs (dates in the field's display format, e.g.
 * `25/09/2026`, as in the grid editor — T320), option names / user ids for
 * choices, a boolean for a check box, picked records / finished uploads for
 * link and file questions (T410). Converted to the json write shape of
 * CONTRACTS §2 only when sent, with the same parsing and `field-types`
 * validation as the grid editors (FRONTEND §4.1): what the server would
 * refuse never leaves.
 */
export type InputValue = string | readonly string[] | boolean | readonly InputItem[];

/**
 * A picked record of a link question (`name` = its title) or a finished
 * upload of a file question (`name` = the file name, with `size`).
 */
export interface InputItem {
  readonly id: string;
  readonly name: string | null;
  readonly size?: number;
}

/** The items of a link or file question's input. */
export function itemsOf(value: InputValue): readonly InputItem[] {
  if (!Array.isArray(value)) return [];
  return (value as readonly unknown[]).filter(
    (item): item is InputItem => typeof item === 'object' && item !== null && 'id' in item,
  );
}

/** `REQUIRED_FIELD_MISSING`, as the server words a required question left empty (CONTRACTS §17). */
export const REQUIRED_ISSUE: EditorIssue = { code: 'REQUIRED_FIELD_MISSING' };

function isMulti(config: QuestionConfig): boolean {
  if (config.type === 'link' || config.type === 'attachment') return true;
  return (config.type === 'select' || config.type === 'user') && config.options.multiple;
}

/** The empty input of a question. */
export function emptyInput(config: QuestionConfig | null): InputValue {
  if (config === null) return '';
  if (config.type === 'checkbox') return false;
  return isMulti(config) ? [] : '';
}

/** Empty like the server counts it (CONTRACTS §17): blank text, no choice, an unchecked box. */
export function isEmptyInput(value: InputValue): boolean {
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'string') return value.trim() === '';
  return value.length === 0;
}

/** A date value as the question's input shows it: the field's display format and zone. */
function dateInputOf(value: unknown, config: QuestionConfig, ctx: LocaleContext): string {
  return config.type === 'datetime' ? datetimeInputText(value, config.options, ctx) : '';
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * The input a `?prefill_<field_id>=` value starts a question with. The raw
 * text is read like `typecast` would (option names or ids, `true`/`1`/`x`
 * for a check box, dates in ISO or the field format, user ids or emails);
 * what does not match stays empty — the person fills it in.
 */
export function prefillInput(
  config: QuestionConfig | null,
  raw: string,
  ctx: LocaleContext,
  members: readonly FormMember[] = [],
): InputValue {
  if (config === null) return '';
  switch (config.type) {
    case 'text':
      return raw;
    case 'number':
      return raw.trim();
    case 'checkbox':
      return CHECKBOX_TRUE_STRINGS.includes(raw.trim().toLowerCase());
    case 'datetime': {
      const cast = datetimeFieldType.typecast(raw.trim(), config.options, ctx);
      return cast.ok && cast.value !== null ? dateInputOf(cast.value, config, ctx) : '';
    }
    case 'select': {
      const tokens = config.options.multiple ? splitList(raw) : [raw.trim()];
      const names = tokens.flatMap((token) => {
        // Names typed into a URL are matched without regard to case.
        const option =
          findSelectOption(config.options, token) ??
          config.options.options.find((item) => item.name.toLowerCase() === token.toLowerCase());
        return option === undefined ? [] : [option.name];
      });
      return config.options.multiple ? [...new Set(names)] : (names[0] ?? '');
    }
    case 'user': {
      const ids = splitList(raw).flatMap((token) => {
        const member = members.find(
          (item) =>
            item.id === token ||
            (item.email !== null && item.email.toLowerCase() === token.toLowerCase()),
        );
        return member === undefined ? [] : [member.id];
      });
      return config.options.multiple ? [...new Set(ids)] : (ids[0] ?? '');
    }
    default:
      // Links and files are picked here (a hidden prefilled link is sent as typed: titles).
      return emptyInput(config);
  }
}

/** The input showing a json value (a field's default value). */
export function inputOfValue(
  config: QuestionConfig | null,
  value: unknown,
  ctx: LocaleContext,
): InputValue {
  if (config === null || value === null || value === undefined) return emptyInput(config);
  switch (config.type) {
    case 'text':
      return typeof value === 'string' ? value : '';
    case 'number':
      return numberInputText(value, config.options, ctx.locale);
    case 'checkbox':
      return value === true;
    case 'datetime':
      return dateInputOf(value, config, ctx);
    default:
      return emptyInput(config);
  }
}

/** The input a question starts with when nothing is prefilled: the field's default value. */
export function initialInput(config: QuestionConfig | null, ctx: LocaleContext): InputValue {
  if (config === null) return '';
  switch (config.type) {
    case 'text':
    case 'number':
    case 'datetime': {
      const fallback: unknown = config.options.default_value;
      return typeof fallback === 'string' || typeof fallback === 'number'
        ? inputOfValue(config, fallback, ctx)
        : emptyInput(config);
    }
    default:
      // Select, check box and user defaults are applied by the server on create.
      return emptyInput(config);
  }
}

export type WriteResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issue: EditorIssue };

/** A typed date (field format, or ISO 8601) read and checked like the grid editor does. */
function datetimeValue(text: string, config: QuestionConfig, ctx: LocaleContext): WriteResult {
  if (config.type !== 'datetime') return { ok: false, issue: { code: 'INVALID_CELL_VALUE' } };
  const draft = datetimeDraft(text, config.options, ctx);
  return draft.ok ? { ok: true, value: draft.commit.value } : { ok: false, issue: draft.issue };
}

/**
 * The json write value of a non-empty input, checked like the grid editors
 * check a cell (`grid/editors/parse.ts`). Forms never create select options
 * (CONTRACTS §17).
 */
export function writeValue(
  config: QuestionConfig,
  input: InputValue,
  ctx: LocaleContext,
  members: readonly FormMember[] = [],
): WriteResult {
  if (config.type === 'link') {
    const ids = itemsOf(input).map((item) => item.id);
    if (!config.options.allow_multiple && ids.length > 1) {
      return { ok: false, issue: { code: 'TOO_MANY_VALUES', params: { limit: 1 } } };
    }
    return { ok: true, value: ids };
  }
  if (config.type === 'attachment') {
    const files = itemsOf(input);
    if (files.length > config.options.max_files) {
      return {
        ok: false,
        issue: { code: 'TOO_MANY_VALUES', params: { limit: config.options.max_files } },
      };
    }
    return { ok: true, value: files.map((file) => ({ id: file.id })) };
  }
  const draft = (() => {
    switch (config.type) {
      case 'text':
        return textDraft(typeof input === 'string' ? input : '', config.options);
      case 'number':
        return numberDraft(typeof input === 'string' ? input : '', config.options, ctx);
      case 'checkbox':
        return {
          ok: true as const,
          commit: { value: input === true, display: input === true, typecast: false },
        };
      case 'select': {
        const names = typeof input === 'string' ? [input] : Array.isArray(input) ? input : [];
        return selectDraft(names as readonly string[], config.options, false);
      }
      case 'user': {
        const ids = typeof input === 'string' ? [input] : Array.isArray(input) ? input : [];
        const picked = (ids as readonly string[])
          .filter((id) => id !== '')
          .map((id) => {
            const member = members.find((item) => item.id === id);
            // Form links give no email (T321): the draft only keeps the id anyway.
            return { id, name: member?.name ?? '', email: member?.email ?? '' };
          });
        return userDraft(picked, config.options);
      }
      case 'datetime':
        return null;
      default:
        return { ok: false as const, issue: { code: 'FIELD_READ_ONLY' } };
    }
  })();
  if (draft === null) return datetimeValue(typeof input === 'string' ? input : '', config, ctx);
  return draft.ok ? { ok: true, value: draft.commit.value } : { ok: false, issue: draft.issue };
}

/** What a submission sends, or why it cannot be sent. */
export interface Submission {
  /** `fields` of the request body, by field id. */
  readonly fields: Record<string, unknown>;
  /** Problems by field id; empty = ready to send. */
  readonly issues: Record<string, EditorIssue>;
}

/**
 * Checks every question and builds `fields` (CONTRACTS §17): required
 * questions must not be empty; hidden prefilled questions send their raw
 * text (the server typecasts and validates it like any other value);
 * empty optional questions are not sent.
 */
export function buildSubmission(
  questions: readonly FormQuestion[],
  values: Readonly<Record<string, InputValue>>,
  hidden: Readonly<Record<string, string>>,
  ctx: LocaleContext,
  members: readonly FormMember[] = [],
): Submission {
  const fields: Record<string, unknown> = {};
  const issues: Record<string, EditorIssue> = {};
  for (const question of questions) {
    const fieldId = question.field.id;
    const raw = hidden[fieldId];
    if (raw !== undefined) {
      if (raw.trim() !== '') fields[fieldId] = raw;
      else if (question.required) issues[fieldId] = REQUIRED_ISSUE;
      continue;
    }
    const input = values[fieldId] ?? emptyInput(question.config);
    if (isEmptyInput(input)) {
      if (question.required) issues[fieldId] = REQUIRED_ISSUE;
      continue;
    }
    if (question.config === null) continue;
    const result = writeValue(question.config, input, ctx, members);
    if (result.ok) fields[fieldId] = result.value;
    else issues[fieldId] = result.issue;
  }
  return { fields, issues };
}
