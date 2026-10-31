import { enqueue } from '../../jobs/enqueue.js';

import type { Tx } from '../../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/** Job key of the `ai.generate` job of a field (one pending job per field). */
export function aiGenerateJobKey(fieldId: Id<'fld'>): string {
  return `ai.generate:${fieldId}`;
}

/** Wait before a queued field is generated: edits within it cost one call (debounce). */
export const AI_GENERATE_DEBOUNCE_MS = 2_000;

/**
 * Schedules `ai.generate` for `fieldId` in `tx` (with the rows it queued):
 * a pending job of the field moves to `runAt` (`replace`), so a burst of
 * writes runs once, after the last one.
 */
export async function enqueueAiGeneration(
  tx: Tx,
  organizationId: Id<'org'>,
  fieldId: Id<'fld'>,
  runAt: Date = new Date(Date.now() + AI_GENERATE_DEBOUNCE_MS),
): Promise<void> {
  await enqueue(
    tx,
    'ai.generate',
    { organization_id: organizationId, field_id: fieldId },
    { jobKey: aiGenerateJobKey(fieldId), runAt, maxAttempts: 5 },
  );
}
