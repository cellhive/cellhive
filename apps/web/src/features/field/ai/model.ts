import {
  AI_FIELD_DEFAULT_OUTPUT_TOKENS,
  aiFieldOptionsSchema,
  type AiFieldOptions,
  type AiFieldPreview,
  type AiFieldTask,
  type FieldDto,
} from '@cellhive/contracts';

import { aiConfigOf } from '../../../lib/ai/ai-field';
import { issueToDetail } from '../../../lib/forms/zod-form';

import type { DraftIssue } from '../draft';

/**
 * The AI part of the field form (T915, CONTRACTS §29.5, research S8 §5.3):
 * a template (summarize, classify, extract, translate, custom) pre-fills
 * the prompt and the output — text, or one option of a single select —;
 * the prompt is a template with field names (`{{ [Mô tả] }}`), as the
 * field API takes and returns it. Pure functions; the section renders it.
 */

/** Output of an AI field: its type (`text`, or a single `select`). */
export type AiOutput = 'text' | 'select';

export interface AiDraft {
  readonly task: AiFieldTask;
  /** Template with field names (`{{ [Name] }}`). */
  readonly prompt: string;
  readonly instructions: string;
  readonly autoUpdate: boolean;
  /** As typed (validated on save). */
  readonly maxOutputTokens: string;
}

/** The templates in their order (board: Summarize, Classify, Extract, Translate, Custom). */
export const AI_TEMPLATES: readonly { readonly task: AiFieldTask; readonly output: AiOutput }[] = [
  { task: 'summarize', output: 'text' },
  { task: 'classify', output: 'select' },
  { task: 'extract', output: 'text' },
  { task: 'translate', output: 'text' },
  { task: 'custom', output: 'text' },
];

export function templateOf(task: AiFieldTask): { task: AiFieldTask; output: AiOutput } {
  return AI_TEMPLATES.find((item) => item.task === task) ?? { task: 'custom', output: 'text' };
}

/** `[Name]` as a formula names a field (`]` and `\` escaped, like the formula engine). */
export function bracketName(name: string): string {
  return `[${name.replace(/[\\\]]/gu, (char) => `\\${char}`)}]`;
}

/** The text of a template literal: `{` and `\` escaped so that it opens no placeholder. */
function literal(text: string): string {
  return text.replace(/[\\{]/gu, (char) => `\\${char}`);
}

/**
 * Types a prompt may name (the server refuses the others: attachment,
 * button, link, lookup, another AI field — CONTRACTS §29.5).
 */
const PROMPT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'number',
  'select',
  'datetime',
  'checkbox',
  'user',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'auto_number',
  'formula',
]);

/** Fields a prompt may name: same-record values, never AI fields nor the field itself. */
export function promptFields(fields: readonly FieldDto[], selfId?: string): FieldDto[] {
  return fields.filter(
    (field) =>
      field.id !== selfId &&
      PROMPT_TYPES.has(field.type) &&
      aiConfigOf(field) === null &&
      field.locked !== true,
  );
}

/**
 * The field a template starts from: the first plain text field that is not
 * the primary one (a description: "Mô tả"), else the primary field.
 */
export function sourceFieldOf(fields: readonly FieldDto[]): FieldDto | undefined {
  const usable = promptFields(fields);
  return (
    usable.find((field) => field.type === 'text' && !field.is_primary) ??
    usable.find((field) => field.is_primary) ??
    usable[0]
  );
}

/**
 * The prompt of a template: its lead ("Summarize in one sentence:") and the
 * source field as a placeholder; `custom` starts empty.
 */
export function templatePrompt(task: AiFieldTask, lead: string, source?: FieldDto): string {
  if (task === 'custom') return '';
  const text = literal(lead);
  return source === undefined ? text : `${text} {{ ${bracketName(source.name)} }}`;
}

export function newAiDraft(task: AiFieldTask, prompt: string): AiDraft {
  return {
    task,
    prompt,
    instructions: '',
    autoUpdate: true,
    maxOutputTokens: String(AI_FIELD_DEFAULT_OUTPUT_TOKENS),
  };
}

/** The AI part of a saved field, `null` for a field without AI. */
export function aiDraftOf(field: FieldDto | undefined): AiDraft | null {
  if (field === undefined) return null;
  const config = aiConfigOf(field);
  if (config === null) return null;
  return {
    task: config.task,
    prompt: config.prompt,
    instructions: config.instructions ?? '',
    autoUpdate: config.auto_update,
    maxOutputTokens: String(config.max_output_tokens),
  };
}

/** `options.ai` of the create/update body (and of the preview). */
export function aiOptionsBody(draft: AiDraft): AiFieldOptions {
  const typed = draft.maxOutputTokens.trim();
  const tokens = /^\d+$/u.test(typed) ? Number(typed) : Number.NaN;
  const instructions = draft.instructions.trim();
  return {
    task: draft.task,
    prompt: draft.prompt.trim(),
    instructions: instructions === '' ? null : instructions,
    auto_update: draft.autoUpdate,
    max_output_tokens: tokens,
  };
}

/** Whether a changed AI part asks to generate again (prompt, instructions, length, task). */
export function aiChangedValues(before: AiDraft | null, after: AiDraft | null): boolean {
  if (after === null) return false;
  if (before === null) return true;
  const a = aiOptionsBody(before);
  const b = aiOptionsBody(after);
  return (
    a.task !== b.task ||
    a.prompt !== b.prompt ||
    a.instructions !== b.instructions ||
    a.max_output_tokens !== b.max_output_tokens
  );
}

/** Issues of the AI part (contract schema, paths `options.ai.<key>`), and a select without options. */
export function aiIssues(draft: AiDraft, output: AiOutput, optionCount: number): DraftIssue[] {
  const issues: DraftIssue[] = [];
  // Not a whole number as typed ("3k"): said as such, not as a missing value.
  if (!/^\d+$/u.test(draft.maxOutputTokens.trim())) {
    issues.push({ path: 'options.ai.max_output_tokens', detail: { code: 'EXPECTED_NUMBER' } });
  }
  const parsed = aiFieldOptionsSchema.safeParse(aiOptionsBody(draft));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = ['options', 'ai', ...issue.path.map(String)].join('.');
      if (!issues.some((known) => known.path === path)) {
        issues.push({ path, detail: issueToDetail(issue) });
      }
    }
  }
  if (output === 'select' && optionCount === 0) {
    issues.push({ path: 'options.ai.choices', detail: { code: 'AI_CHOICES_REQUIRED' } });
  }
  return issues;
}

/**
 * Where a server error about the AI part goes: `options.ai.<key>` of a
 * save (`422`), `ai.<key>` of a preview — the prompt's problems carry the
 * position of the placeholder (`params.position`).
 */
export function serverAiIssue(
  errors: readonly {
    readonly path: string;
    readonly code: string;
    readonly params?: Record<string, unknown> | undefined;
  }[],
): DraftIssue | undefined {
  for (const item of errors) {
    const match = /^(?:options\.)?ai\.(prompt|instructions|max_output_tokens|task)$/u.exec(
      item.path,
    );
    if (match === null) continue;
    return {
      path: `options.ai.${match[1] ?? 'prompt'}`,
      detail:
        item.params === undefined ? { code: item.code } : { code: item.code, params: item.params },
    };
  }
  return undefined;
}

/** Average tokens of one row from a preview's estimate (`undefined` without one). */
export function tokensPerRow(estimate: AiFieldPreview['estimate'] | undefined): number | undefined {
  if (estimate === undefined || estimate.rows === 0) return undefined;
  return estimate.tokens / estimate.rows;
}
