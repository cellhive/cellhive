import type { JsonValue } from '../db/schema.js';
import type { Actor } from '../events/event.js';
import type { ComputedFieldMeta } from '../realtime/envelope.js';
import type { Id } from '@cellhive/contracts';

export type RecordChangeType =
  | 'record.created'
  | 'record.updated'
  | 'record.deleted'
  | 'record.restored'
  /** Permanently deleted from the trash (T408); its event is the purge's summary event. */
  | 'record.purged';

/** Storage-form values (CONTRACTS §8 `changes`) keyed by field id. */
export type StoredImage = Readonly<Record<string, JsonValue>>;

/**
 * One committed record change, handed to the realtime layer (SPEC §15)
 * **after** the transaction commits. It carries what the WS gateway needs to
 * decide, per subscriber and without reading the database, what may be
 * sent (T210):
 *
 * - `before` / `after`: storage-form images of the fields referenced by the
 *   read/edit rules of any role of the base, plus the changed fields, so the
 *   gateway can evaluate each subscriber's read rule on both sides;
 * - `values`: `cell_format=json` values the message may carry, of every
 *   field (`record.created`) or of the changed fields plus the table's
 *   `updated_at`/`updated_by` fields (`record.updated`).
 *
 * Nothing here is filtered for a person: the gateway drops `no_perm` fields
 * and records outside the subscriber's read scope.
 */
export interface RecordChange {
  readonly type: RecordChangeType;
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly tableId: Id<'tbl'>;
  readonly recordId: Id<'rec'>;
  /** `__version` after the change (unchanged for a recompute of computed values). */
  readonly version: number;
  /** Fields whose stored value changed (every field with a value for `record.created`). */
  readonly changedFieldIds: readonly Id<'fld'>[];
  /**
   * The `meta.events` row written for the change; `null` for system
   * recomputes of computed fields, which write no event (ADR-23 §2).
   */
  readonly eventId: Id<'evt'> | null;
  readonly actor: Actor;
  /** The user behind the change (`__updated_by`): `null` for the system and automations. */
  readonly actorUserId: Id<'usr'> | null;
  /** Image before the change; `null` for `record.created` and `record.restored`. */
  readonly before: StoredImage | null;
  /** Image after the change; `null` for `record.deleted`. */
  readonly after: StoredImage | null;
  /** `cell_format=json` values by field id (empty for delete/restore). */
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * What the gateway needs to evaluate record rules on the images: type and
 * raw options (`meta.fields.options`) of every field present in them.
 */
export interface RecordChangeField {
  readonly id: Id<'fld'>;
  readonly type: string;
  readonly options: JsonValue;
  /**
   * Formula/lookup fields in images or values (T459): result type and what
   * they read, for the per-subscriber `locked`/scope decisions.
   */
  readonly computed?: ComputedFieldMeta;
}

/**
 * A `link` field whose values a change carries (T401): `values` hold
 * `[{ id, title }]` with the title of every linked record, and the gateway
 * keeps a title only for subscribers who read `title_field_id` of
 * `table_id` (the linked table) with no record rule there (CONTRACTS §7);
 * others get `title: null`.
 */
export interface RecordChangeLink {
  readonly id: Id<'fld'>;
  /** The linked table. */
  readonly tableId: Id<'tbl'>;
  /** Its primary field (the title); `null` when it has none. */
  readonly titleFieldId: Id<'fld'> | null;
}

/**
 * Changes of link cells caused by **another** table (T402): records of that
 * table linked by `fieldId` changed their title (primary field) or entered /
 * left the trash. Every change is a `record.updated` of the linking record
 * with `eventId: null` and its version unchanged (nothing was written to
 * it).
 *
 * - `titlesOnly`: only titles changed (the ids of the cells did not), so a
 *   subscriber who may not see the titles gets nothing;
 * - `values: false`: too many records for full cells (more than
 *   `REALTIME_RECORD_BATCH_THRESHOLD`): `values` are empty and every
 *   subscriber group with something to receive gets one `record.batch`.
 */
export interface RecordChangeFanout {
  readonly fieldId: Id<'fld'>;
  readonly titlesOnly: boolean;
  readonly values: boolean;
}

/**
 * Hook called by `RecordMutationService` after each committed transaction
 * (SPEC §7.3 step 7), with every change of that transaction (one table).
 * Realtime is best effort: a failing publisher never fails the mutation (the
 * data is committed; clients resync on reconnect).
 */
export interface RecordChangePublisher {
  /**
   * `false` when nobody listens (no realtime bus): the mutation service then
   * skips capturing images. Absent means active.
   */
  readonly active?: boolean;
  publish(
    changes: readonly RecordChange[],
    fields: readonly RecordChangeField[],
    /** Link fields whose values the changes carry (T401); absent = none. */
    links?: readonly RecordChangeLink[],
    /** Link cells changed by another table (T402); absent for ordinary writes. */
    fanout?: RecordChangeFanout,
  ): void | Promise<void>;
}

/** Drops everything (processes without a realtime bus, tests). */
export const noopRecordChangePublisher: RecordChangePublisher = {
  active: false,
  publish: () => undefined,
};
