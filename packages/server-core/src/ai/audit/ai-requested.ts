import { Buffer } from 'node:buffer';

import {
  AI_AUDIT_TEXT_MAX_BYTES,
  type AiFeature,
  type AiOutputRung,
  type Id,
} from '@cellhive/contracts';

import { AuditWriter } from '../../audit/audit-writer.js';

import type { AuditContext } from '../../audit/audit-entry.js';
import type { Tx } from '../../db/create-db.js';
import type { JsonObject } from '../../db/schema.js';
import type { AiUsage } from '../client.js';
import type { AiRequestStatus } from '../metrics.js';

export interface AiRequestedEntry {
  readonly organizationId: Id<'org'>;
  readonly baseId?: Id<'bse'> | null;
  readonly tableId?: Id<'tbl'> | null;
  /** What the request was about: `table`, `base`, `field`, `ai_settings`… */
  readonly entityType: string;
  readonly entityId: string | null;
  readonly feature: AiFeature;
  readonly model: string;
  readonly status: AiRequestStatus;
  /** Calls made (1 + repair rounds); `0` when none was sent. */
  readonly attempts: number;
  readonly usage: AiUsage;
  readonly durationMs: number;
  readonly outputMode: AiOutputRung | null;
  /** `log_prompts` of the organization. */
  readonly logPrompts: boolean;
  /** What the person typed (never record values) and the answer: kept only with `log_prompts`. */
  readonly input?: string;
  readonly output?: string;
  /** Records of a background batch (AI field, T910). */
  readonly records?: number;
  readonly context: AuditContext;
}

/** Features whose prompts carry record values: never logged, whatever `log_prompts` says. */
const RECORD_DATA_FEATURES: ReadonlySet<AiFeature> = new Set(['field', 'action']);

/** `text` cut to at most `maxBytes` of UTF-8, never inside a character. */
export function truncateUtf8(text: string, maxBytes: number = AI_AUDIT_TEXT_MAX_BYTES): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * `after` of an `ai.requested` audit entry (CONTRACTS §8, §29.1; Quyết định
 * S8 #12): the call's shape and tokens; `input`/`output` (≤ 4 KB each) only
 * when the organization logs prompts and never for AI fields or actions.
 */
export function aiRequestedAfter(entry: AiRequestedEntry): JsonObject {
  const after: JsonObject = {
    feature: entry.feature,
    model: entry.model,
    status: entry.status,
    attempts: entry.attempts,
    prompt_tokens: entry.usage.promptTokens,
    completion_tokens: entry.usage.completionTokens,
    estimated: entry.usage.estimated,
    duration_ms: Math.round(entry.durationMs),
    output_mode: entry.outputMode,
    ...(entry.records === undefined ? {} : { records: entry.records }),
  };
  if (entry.logPrompts && !RECORD_DATA_FEATURES.has(entry.feature)) {
    if (entry.input !== undefined) after['input'] = truncateUtf8(entry.input);
    if (entry.output !== undefined) after['output'] = truncateUtf8(entry.output);
  }
  return after;
}

const audit = new AuditWriter();

/** One `ai.requested` entry per operation (request, batch, action step), on `tx`. */
export async function writeAiRequestedAudit(tx: Tx, entry: AiRequestedEntry): Promise<void> {
  await audit.write(tx, {
    action: 'ai.requested',
    organizationId: entry.organizationId,
    baseId: entry.baseId ?? null,
    tableId: entry.tableId ?? null,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: null,
    after: aiRequestedAfter(entry),
    context: entry.context,
  });
}
