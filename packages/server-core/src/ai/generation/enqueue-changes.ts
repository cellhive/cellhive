import { orgScope } from '../../db/repository.js';
import { FieldsRepository } from '../../schema/fields.repository.js';

import { enqueueAiGeneration } from './jobs.js';
import { aiOptionsOf, aiSourceFieldIds } from './options.js';
import { AiGenerationQueueRepository } from './queue.repository.js';

import type {
  ComputedChange,
  RecomputedValues,
  RecomputeSource,
} from '../../computed/recompute/changes.js';
import type { Tx } from '../../db/create-db.js';
import type { JsonValue } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

/**
 * The AI side of the "one door" of computed changes (BACKLOG T910, ADR-39
 * §7, research S8 §4.5): AI fields are `same_row` nodes of the dependency
 * graph, but instead of an SQL recompute their rows are queued in
 * `meta.ai_generation_queue` — in the transaction of the write — and
 * `ai.generate` is scheduled, for fields with `auto_update`:
 *
 * - records created or restored: every AI field of their table;
 * - cells changed by the write, or values of formulas/lookups recomputed
 *   because of it: the AI fields whose prompt reads them.
 *
 * Schema-wide changes (an option renamed, a zone changed) queue nothing:
 * regenerating every row costs quota, so the user asks for it. A value an
 * AI field just wrote never queues that same field again (a formula reading
 * it in its prompt would otherwise loop).
 */
export class AiGenerationEnqueuer {
  private readonly fields: FieldsRepository;
  private readonly queue: AiGenerationQueueRepository;

  constructor(db: ConstructorParameters<typeof FieldsRepository>[0]) {
    this.fields = new FieldsRepository(db);
    this.queue = new AiGenerationQueueRepository(db);
  }

  async enqueue(
    tx: Tx,
    organizationId: Id<'org'>,
    changes: readonly ComputedChange[],
    recomputed: readonly RecomputedValues[],
    source?: RecomputeSource,
  ): Promise<void> {
    const tableIds = new Set<Id<'tbl'>>();
    for (const change of changes) if (change.kind === 'records') tableIds.add(change.tableId);
    for (const item of recomputed) tableIds.add(item.tableId);
    if (tableIds.size === 0) return;
    const scope = orgScope(organizationId, tx);
    const candidates = await this.fields.listAiCandidatesByTables(scope, [...tableIds].sort());
    if (candidates.length === 0) return;
    const causation = (source?.causation ?? null) as JsonValue | null;
    for (const field of candidates) {
      const ai = aiOptionsOf(field);
      if (ai === null || !ai.auto_update || source?.via?.ai_field_id === field.id) continue;
      const sources = new Set<string>(aiSourceFieldIds(ai.prompt));
      const ids = new Set<string>();
      for (const change of changes) {
        if (change.kind !== 'records' || change.tableId !== field.table_id) continue;
        const touched =
          change.event === 'created' ||
          change.event === 'restored' ||
          (change.event === 'updated' && (change.fieldIds ?? []).some((id) => sources.has(id)));
        if (touched) for (const id of change.recordIds) ids.add(id);
      }
      for (const item of recomputed) {
        if (item.tableId !== field.table_id || !sources.has(item.fieldId)) continue;
        for (const id of item.recordIds) if (item.trashed?.has(id) !== true) ids.add(id);
      }
      if (ids.size === 0) continue;
      await this.queue.enqueue(scope, field.id, [...ids], { causation });
      await enqueueAiGeneration(tx, organizationId, field.id);
    }
  }
}
