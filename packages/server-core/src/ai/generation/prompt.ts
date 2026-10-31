import {
  AI_FIELD_MAX_INPUT_LENGTH,
  AI_FIELD_MAX_OUTPUT_LENGTH,
  AUTOMATION_DISALLOWED_FUNCTIONS,
  type AiFieldOptions,
} from '@cellhive/contracts';
import {
  checkTemplate,
  evaluate,
  formatTemplateValue,
  type FormulaRecord,
  type SchemaSnapshot,
} from '@cellhive/formula-engine';
import { z } from 'zod';

import { UNTRUSTED_DATA_INSTRUCTIONS, untrustedBlock } from '../untrusted.js';

import type { AiChatMessage } from '../client.js';

/**
 * Prompt of one record of an AI field (BACKLOG T910, research §2.6
 * "map-reduce"): each record is one isolated call — the template's own text
 * (written by the field's managers) with every value of the record in an
 * untrusted data block, no tools, a bounded answer written to that field
 * only. Pure.
 */

/** What the field holds: text, or one option of a single select (by name). */
export type AiFieldTarget =
  | { readonly kind: 'text' }
  | { readonly kind: 'select'; readonly options: readonly { id: string; name: string }[] };

/** A placeholder that no longer resolves (a source deleted or unreadable). */
export class AiRenderError extends Error {
  override readonly name = 'AiRenderError';
}

export interface RenderedAiInput {
  /** The template with values as plain text, cut at `AI_FIELD_MAX_INPUT_LENGTH` (preview, limits). */
  readonly plain: string;
  /** The same with each value in a data block (what the model reads). */
  readonly marked: string;
}

export interface RenderContext {
  readonly timeZone: string;
  readonly locale: string;
  readonly now: Date;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Display names of the users in a `cell_format=json` row (`{ id, name }` cells). */
function userNamesOf(row: FormulaRecord): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (
      isRecord(value) &&
      typeof value['id'] === 'string' &&
      typeof value['name'] === 'string'
    ) {
      out.set(value['id'], value['name']);
    }
  };
  Object.values(row.fields).forEach(visit);
  return out;
}

/**
 * The stored prompt (`{{ [fld_…] }}`) of a field on one record. Values past
 * `AI_FIELD_MAX_INPUT_LENGTH` characters altogether are cut; a placeholder
 * that does not resolve against `snapshot` throws {@link AiRenderError}.
 */
export function renderAiInput(
  prompt: string,
  snapshot: SchemaSnapshot,
  row: FormulaRecord,
  context: RenderContext,
): RenderedAiInput {
  const check = checkTemplate(prompt, snapshot, {
    form: 'stored',
    allowTables: false,
    disallow: AUTOMATION_DISALLOWED_FUNCTIONS,
  });
  if (check.errors.length > 0) throw new AiRenderError('The prompt names a field that is gone');
  const names = userNamesOf(row);
  const placeholders = new Map(check.placeholders.map((item) => [item.index, item]));
  let left = AI_FIELD_MAX_INPUT_LENGTH;
  for (const part of check.parts) if (part.kind === 'text') left -= part.text.length;
  let plain = '';
  let marked = '';
  for (const part of check.parts) {
    if (part.kind === 'text') {
      plain += part.text;
      marked += part.text;
      continue;
    }
    const placeholder = placeholders.get(part.index);
    if (placeholder === undefined) throw new AiRenderError('The prompt does not resolve');
    const value = evaluate(placeholder.ast, {
      snapshot,
      row,
      tz: context.timeZone,
      now: context.now,
      types: placeholder.types,
      disallow: new Set(AUTOMATION_DISALLOWED_FUNCTIONS),
    });
    const text = Array.from(
      formatTemplateValue(value, placeholder.type, placeholder.style, {
        locale: context.locale,
        timeZone: context.timeZone,
        userName: (id) => names.get(id) ?? null,
      }),
    );
    const kept = text.slice(0, Math.max(0, left)).join('');
    left -= text.length;
    plain += kept;
    marked += `\n${untrustedBlock('value', kept)}\n`;
  }
  return { plain, marked };
}

const TASK_LINES: Readonly<Record<AiFieldOptions['task'], string>> = {
  summarize: 'Summarize the record as the request says.',
  classify: 'Classify the record as the request says.',
  extract: 'Extract what the request asks for from the record.',
  translate: 'Translate as the request says.',
  custom: 'Do what the request says.',
};

/** Messages of one call: rules and the field's guidance, then the rendered request. */
export function aiFieldMessages(
  ai: Pick<AiFieldOptions, 'task' | 'instructions'>,
  input: RenderedAiInput,
  target: AiFieldTarget,
): AiChatMessage[] {
  const answer =
    target.kind === 'select'
      ? 'Answer with the one option that fits best, as JSON.'
      : 'Answer with the text of the cell only: plain text, no Markdown, no HTML, no preamble.';
  const system = [
    'You fill one cell of a table in a database application, for one record at a time.',
    TASK_LINES[ai.task],
    answer,
    UNTRUSTED_DATA_INSTRUCTIONS,
    ...(ai.instructions === null || ai.instructions === ''
      ? []
      : ['Guidance from the person who set up this column:', ai.instructions]),
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: input.marked },
  ];
}

/** The JSON answer of a select field: one option name (an `enum` of the options). */
export function aiSelectAnswerSchema(
  options: readonly { name: string }[],
): z.ZodType<{ option: string }> {
  const names = options.map((option) => option.name);
  return z.strictObject({ option: z.enum(names as [string, ...string[]]) });
}

/** A text answer as stored: trimmed, `null` when empty, `null` + `invalid` when too long. */
export function aiTextValue(content: string): { value: string | null; invalid: boolean } {
  const text = content.trim();
  if (Array.from(text).length > AI_FIELD_MAX_OUTPUT_LENGTH) return { value: null, invalid: true };
  return { value: text === '' ? null : text, invalid: false };
}
