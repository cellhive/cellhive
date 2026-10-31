import {
  aiFieldStoredOptionsSchema,
  isId,
  type AiFieldOptions,
  type Id,
} from '@cellhive/contracts';
import { splitTemplate } from '@cellhive/formula-engine';

/**
 * AI fields (BACKLOG T910, ADR-39 §7, CONTRACTS §29.5): a `text` or single
 * `select` field whose options carry `ai`. Pure helpers shared by the
 * schema, record, realtime and worker code.
 */

/** Field types that may carry `options.ai`. */
export const AI_FIELD_TYPES: ReadonlySet<string> = new Set(['text', 'select']);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `options.ai` of an AI field (stored form: prompt with field ids), else `null`. */
export function aiOptionsOf(field: {
  readonly type: string;
  readonly options: unknown;
}): AiFieldOptions | null {
  if (!AI_FIELD_TYPES.has(field.type) || !isRecord(field.options)) return null;
  const ai = field.options['ai'];
  if (ai === null || ai === undefined) return null;
  const parsed = aiFieldStoredOptionsSchema.safeParse(ai);
  return parsed.success ? parsed.data : null;
}

/** Whether the field is an AI field (its cells are written by the AI worker only). */
export function isAiField(field: { readonly type: string; readonly options: unknown }): boolean {
  return aiOptionsOf(field) !== null;
}

const FIELD_ID = /fld_[0-9A-Za-z]{16}/gu;

/**
 * Field ids a stored prompt reads (`{{ [fld_…] }}` placeholders), sorted.
 * Any id inside a placeholder counts, so the list errs on the side of more
 * sources: a reader missing one of them never sees the value (always strict).
 */
export function aiSourceFieldIds(prompt: string): Id<'fld'>[] {
  const out = new Set<string>();
  for (const part of splitTemplate(prompt).parts) {
    if (part.kind !== 'expression') continue;
    for (const match of part.expression.matchAll(FIELD_ID)) {
      if (isId('fld', match[0])) out.add(match[0]);
    }
  }
  return [...out].sort() as Id<'fld'>[];
}

/** The source fields of an AI field (`[]` for any other field). */
export function aiSourcesOf(field: {
  readonly type: string;
  readonly options: unknown;
}): Id<'fld'>[] {
  const ai = aiOptionsOf(field);
  return ai === null ? [] : aiSourceFieldIds(ai.prompt);
}
