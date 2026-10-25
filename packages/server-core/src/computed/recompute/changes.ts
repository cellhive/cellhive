import type { Tx } from '../../db/create-db.js';
import type { JsonValue } from '../../db/schema.js';
import type { Causation } from '../../events/event.js';
import type { EventBatch, EventVia, Id } from '@cellhive/contracts';

/**
 * What changed, as the sources of the incremental recompute describe it
 * (SPEC §5.9, BACKLOG T458 "one door"): record writes, and changes that
 * alter the values of fields on every record.
 */

/** A write of records of one table. */
export interface RecordsChange {
  readonly kind: 'records';
  readonly baseId: Id<'bse'>;
  readonly tableId: Id<'tbl'>;
  readonly recordIds: readonly string[];
  /**
   * - `updated`: cells of `fieldIds` changed (links and `parent` included;
   *   `updated_at`/`updated_by` fields of the table are added);
   * - `created`, `restored`: the records appeared (every stored computed
   *   field of the table is computed for them);
   * - `deleted`: the records went to the trash;
   * - `purged`: records of the trash were deleted for good (already out of
   *   every cell and formula: nothing to recompute, kept for completeness).
   */
  readonly event: 'updated' | 'created' | 'deleted' | 'restored' | 'purged';
  /** `updated` only: the fields whose values changed. */
  readonly fieldIds?: readonly string[];
}

/**
 * The values of `fieldIds` changed on every record of their table (select
 * option renamed — formulas see option names —, a zone of the field, a
 * type conversion that finished, a link field or table gone): computed
 * fields reading them are recomputed for every record, by the job.
 */
export interface FieldsChange {
  readonly kind: 'fields';
  readonly baseId: Id<'bse'>;
  readonly tableId: Id<'tbl'>;
  readonly fieldIds: readonly string[];
}

export type ComputedChange = RecordsChange | FieldsChange;

/** Rows found on the state before a write ({@link ComputedRecomputeService.before}). */
export interface ComputedBefore {
  readonly baseId: Id<'bse'>;
  /** Stored computed field → rows, or every row. */
  readonly rows: ReadonlyMap<Id<'fld'>, ReadonlySet<string> | 'all'>;
}

/**
 * The write a recompute follows (T509, S4b-decisions-followup §3.4): the
 * `record.updated` events of recomputed values carry its `batch` and
 * `causation`, and rows it leaves to the job keep its `causation`.
 */
export interface RecomputeSource {
  /** `batch` of the write's events (ADR-26 §1); absent: a fresh `job_…` per recompute. */
  readonly batch?: EventBatch;
  /** `via` of the write (its audit `via`), kept on the events. */
  readonly via?: EventVia;
  /**
   * Causation of the write: an automation's (`depth` ≥ 1), else rooted at
   * the write's first event; absent: unknown (each event roots itself).
   */
  readonly causation?: Causation;
  /** The `computed.recompute` run (`job_…`): every event of the run is one bulk batch. */
  readonly jobId?: Id<'job'>;
  /**
   * A synchronous recompute: adds the recomputed `changes` of a record the
   * write itself changed to that write's pending `record.updated` (no second
   * event). Returns whether it did; `false` → a separate event.
   */
  readonly fold?: (input: {
    readonly tableId: Id<'tbl'>;
    readonly recordId: string;
    readonly changes: Readonly<
      Record<string, { readonly from: JsonValue; readonly to: JsonValue }>
    >;
  }) => boolean;
}

export interface ComputedChanges {
  readonly organizationId: Id<'org'>;
  readonly changes: readonly ComputedChange[];
  /** The write these changes come from (events of recomputed values, T509). */
  readonly source?: RecomputeSource;
  /**
   * Rows found before the write (`cross_table` conditions on values the
   * write changed: the formula rows that selected the old values).
   */
  readonly before?: readonly ComputedBefore[];
}

/** Values of one stored computed field written by one recompute step. */
export interface RecomputedValues {
  readonly baseId: Id<'bse'>;
  readonly tableId: Id<'tbl'>;
  readonly fieldId: Id<'fld'>;
  /** Records whose value changed (no event, audit, `__version` change: ADR-23 §2). */
  readonly recordIds: readonly Id<'rec'>[];
  /**
   * Their values before the recompute (`to_jsonb` of the stored column), for
   * the before-images of realtime (T459). Absent: unknown.
   */
  readonly before?: ReadonlyMap<string, unknown>;
  /** Their new values (`to_jsonb`), for the `changes` of events (T509). Absent: unknown. */
  readonly after?: ReadonlyMap<string, unknown>;
  /** Those of `recordIds` in the trash (no `record.updated` event for them). */
  readonly trashed?: ReadonlySet<string>;
}

/** A stored computed field left to the `computed.recompute` job. */
export interface DeferredField {
  readonly baseId: Id<'bse'>;
  readonly tableId: Id<'tbl'>;
  readonly fieldId: Id<'fld'>;
  /** Records queued, or every record. */
  readonly rows: number | 'all';
}

export interface ComputedRecomputeResult {
  readonly recomputed: readonly RecomputedValues[];
  readonly deferred: readonly DeferredField[];
  /**
   * Fields whose `compute_state` changed (`ready` → `recomputing`): the
   * caller publishes `schema.changed` (field `updated`) after commit.
   */
  readonly stateChanged: readonly {
    readonly baseId: Id<'bse'>;
    readonly tableId: Id<'tbl'>;
    readonly fieldId: Id<'fld'>;
  }[];
}

/** What `afterRecompute` receives. */
export interface AfterRecomputeInput {
  readonly organizationId: Id<'org'>;
  readonly recomputed: readonly RecomputedValues[];
  /** The write (or job run) the recompute follows (T509). */
  readonly source?: RecomputeSource;
  /**
   * Records whose values are their first ones (just created or restored,
   * directly or through queue rows marked `created`): no `record.updated`.
   */
  readonly created?: ReadonlySet<string>;
}

/**
 * Hooks of the recompute, run in its transaction after values are written.
 * The default composes the realtime `record.updated` (`event_id: null`,
 * same `version`, after commit — `RealtimeComputedHooks`, T459) and the
 * `record.updated` events automations listen to (`RecomputeEventHooks`,
 * T509: `causation`/`batch` of the source write or of the job run).
 */
export interface ComputedRecomputeHooks {
  afterRecompute(tx: Tx, input: AfterRecomputeInput): Promise<void>;
}

export const noopComputedRecomputeHooks: ComputedRecomputeHooks = {
  afterRecompute: () => Promise.resolve(),
};

/** Runs `hooks` in order, in the same transaction. */
export function composeComputedRecomputeHooks(
  ...hooks: readonly ComputedRecomputeHooks[]
): ComputedRecomputeHooks {
  return {
    async afterRecompute(tx, input) {
      for (const hook of hooks) await hook.afterRecompute(tx, input);
    },
  };
}
