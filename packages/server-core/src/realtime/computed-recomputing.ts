import { publishRealtime } from './bus.js';
import { REALTIME_ENVELOPE_VERSION, type ComputedRecomputingEnvelope } from './envelope.js';

import type { Db, Tx } from '../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/** Progress of the computation of one stored formula/lookup field (T459). */
export interface ComputedRecomputingProgress {
  readonly organizationId: Id<'org'>;
  readonly tableId: Id<'tbl'>;
  readonly fieldId: Id<'fld'>;
  /** 0–1 (clamped). */
  readonly progress: number;
  readonly status: ComputedRecomputingEnvelope['status'];
}

/** The `computed.recomputing` envelope of a progress report. */
export function computedRecomputingEnvelope(
  input: ComputedRecomputingProgress,
): ComputedRecomputingEnvelope {
  const progress = Number.isFinite(input.progress) ? input.progress : 0;
  return {
    v: REALTIME_ENVELOPE_VERSION,
    type: 'computed.recomputing',
    organization_id: input.organizationId,
    table_id: input.tableId,
    field_id: input.fieldId,
    progress: Math.min(Math.max(progress, 0), 1),
    status: input.status,
  };
}

/**
 * Tells `table:` subscribers who see the field how its backfill (T456) or
 * recompute job (T458) goes (CONTRACTS §7 `computed.recomputing`): at the
 * start, after each batch and at the end; after `tx` commits when given.
 * A no-op without a bus attached to `db`.
 */
export async function publishComputedRecomputing(
  db: Db,
  tx: Tx | undefined,
  input: ComputedRecomputingProgress,
): Promise<void> {
  await publishRealtime(db, tx, computedRecomputingEnvelope(input));
}
