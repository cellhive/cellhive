import type {
  AiCellMetaDto,
  AiCellReason,
  AiCellState,
  AiFieldStateDto,
  AiFieldTask,
  FieldDto,
  RecordDto,
} from '@cellhive/contracts';

/**
 * AI fields on the client (CONTRACTS §29.5, FRONTEND §4.10): a `text` or
 * single `select` field with `options.ai`. Pure helpers shared by the field
 * dialog, the grid, the record panel and the generate dialog — no schema
 * parse (the grid chunk stays small): the API gives `options.ai` checked.
 */

/** `options.ai` as the field API returns it (the prompt with field names). */
export interface AiFieldConfig {
  readonly task: AiFieldTask;
  readonly prompt: string;
  readonly instructions: string | null;
  readonly auto_update: boolean;
  readonly max_output_tokens: number;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `options.ai` of an AI field, `null` for any other field. */
export function aiConfigOf(field: Pick<FieldDto, 'type' | 'options'>): AiFieldConfig | null {
  if (field.type !== 'text' && field.type !== 'select') return null;
  const ai = field.options['ai'];
  if (!isObject(ai) || typeof ai['prompt'] !== 'string') return null;
  return {
    task: (typeof ai['task'] === 'string' ? ai['task'] : 'custom') as AiFieldTask,
    prompt: ai['prompt'],
    instructions: typeof ai['instructions'] === 'string' ? ai['instructions'] : null,
    auto_update: ai['auto_update'] !== false,
    max_output_tokens:
      typeof ai['max_output_tokens'] === 'number' ? ai['max_output_tokens'] : DEFAULT_OUTPUT,
  };
}

const DEFAULT_OUTPUT = 300;

export function isAiField(field: Pick<FieldDto, 'type' | 'options'>): boolean {
  return aiConfigOf(field) !== null;
}

/**
 * The state of an AI cell when it is not simply its value, and why it
 * failed or is paused (`record.meta.ai`: `{ state, reason? }`, T1002).
 */
export function aiCellOf(
  record: Pick<RecordDto, 'meta'> | undefined,
  fieldId: string,
): AiCellMetaDto | undefined {
  const cell: unknown = (record?.meta?.ai as Readonly<Record<string, unknown>> | undefined)?.[
    fieldId
  ];
  return isObject(cell) && typeof cell['state'] === 'string' ? (cell as AiCellMetaDto) : undefined;
}

/** The state of an AI cell when it is not simply its value (`record.meta.ai`). */
export function aiCellStateOf(
  record: Pick<RecordDto, 'meta'> | undefined,
  fieldId: string,
): AiCellState | undefined {
  return aiCellOf(record, fieldId)?.state;
}

/** Why an AI cell failed or is paused, as a code (`undefined`: no reason given). */
export function aiCellReasonOf(
  record: Pick<RecordDto, 'meta'> | undefined,
  fieldId: string,
): AiCellReason | undefined {
  return aiCellOf(record, fieldId)?.reason;
}

/** Paused rows of an AI field, why, and what the provider rejected (`ai_state`, `schema.changed`). */
export function aiPausedOf(field: Pick<FieldDto, 'ai_state'>): {
  readonly count: number;
  readonly reason: AiFieldStateDto['paused_reason'];
  readonly detail: AiFieldStateDto['paused_detail'];
} | null {
  const state = field.ai_state;
  if (state === undefined || state.paused === 0) return null;
  return { count: state.paused, reason: state.paused_reason, detail: state.paused_detail ?? null };
}

/**
 * When an AI field's queued rows go on while the organization waits for its
 * provider (T1002), `null` once that time has passed (at `now`).
 */
export function aiRetryAtOf(
  field: Pick<FieldDto, 'ai_state'>,
  now: number = Date.now(),
): string | null {
  const state = field.ai_state;
  if (state === undefined || state.queued === 0 || state.paused > 0) return null;
  const at = state.retry_at ?? null;
  return at === null || Date.parse(at) <= now ? null : at;
}

/**
 * Tokens to generate `rows` cells: from a preview's average per row when
 * there is one, else the server's rough upper bound — the prompt (values
 * unknown, `ceil(characters / 3)`) and the answer per row (CONTRACTS §29.5).
 */
export function estimateAiTokens(
  rows: number,
  config: Pick<AiFieldConfig, 'prompt' | 'max_output_tokens'>,
  perRow?: number,
): number {
  if (perRow !== undefined && Number.isFinite(perRow)) return Math.round(rows * perRow);
  // Code points, like the server's estimate (CONTRACTS §29.7).
  return rows * (Math.ceil(Array.from(config.prompt).length / 3) + config.max_output_tokens);
}
