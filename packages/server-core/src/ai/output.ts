import type { LlmJsonSchema } from './json-schema.js';

/**
 * The structured-output ladder (CONTRACTS §29.7, ADR-39), best rung first:
 * `json_schema` (strict structured outputs), `json_object` (JSON mode, the
 * schema in the system prompt), `prompt` (no `response_format`, the schema
 * in the system prompt, the first JSON object of the answer). zod and the
 * feature's engine judge the answer on every rung.
 */
export const AI_OUTPUT_MODES = ['json_schema', 'json_object', 'prompt'] as const;

export type AiOutputMode = (typeof AI_OUTPUT_MODES)[number];

/** The rung below `mode`; `null` at the bottom. */
export function lowerOutputMode(mode: AiOutputMode): AiOutputMode | null {
  return AI_OUTPUT_MODES[AI_OUTPUT_MODES.indexOf(mode) + 1] ?? null;
}

/** `response_format.json_schema.name` (OpenAI: letters, digits, `_`, `-`; ≤ 64). */
const SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

/** `response_format` of a rung; `undefined` for `prompt` (the parameter is not sent). */
export function responseFormatOf(
  mode: AiOutputMode,
  name: string,
  schema: LlmJsonSchema,
): Record<string, unknown> | undefined {
  if (!SCHEMA_NAME.test(name)) throw new TypeError(`Invalid output schema name "${name}"`);
  switch (mode) {
    case 'json_schema':
      return { type: 'json_schema', json_schema: { name, strict: true, schema: schema.schema } };
    case 'json_object':
      return { type: 'json_object' };
    case 'prompt':
      return undefined;
  }
}

/** Precedes the schema in the system prompt of the lower rungs (the fake provider reads it). */
export const SCHEMA_INSTRUCTION_LEAD = 'It must match this JSON Schema:';

/**
 * System-prompt text of the lower rungs: the answer format and the schema
 * (JSON mode of OpenAI also requires the word "JSON" in the prompt).
 * `null` on `json_schema`, where `response_format` carries the schema.
 */
export function schemaInstruction(mode: AiOutputMode, schema: LlmJsonSchema): string | null {
  if (mode === 'json_schema') return null;
  return (
    'Answer with one JSON object only, without any other text or code fence. ' +
    `${SCHEMA_INSTRUCTION_LEAD}\n${JSON.stringify(schema.schema)}`
  );
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Index of the `}` closing the object opened at `start` (strings skipped), or `-1`. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Candidate `{` positions tried before giving up (bounds the work on a 1 MiB answer). */
const MAX_CANDIDATES = 20;

/**
 * The JSON object of an answer, on any rung: the whole text, or else the
 * first balanced `{…}` that parses (an answer wrapped in prose or a code
 * fence — the `prompt` rung, or a provider ignoring `response_format`).
 * `undefined` when there is none.
 */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const whole = parseObject(text.trim());
  if (whole !== undefined) return whole;
  let start = text.indexOf('{');
  for (let tries = 0; start !== -1 && tries < MAX_CANDIDATES; tries += 1) {
    const end = closingBrace(text, start);
    const found = end === -1 ? undefined : parseObject(text.slice(start, end + 1));
    if (found !== undefined) return found;
    start = text.indexOf('{', start + 1);
  }
  return undefined;
}
