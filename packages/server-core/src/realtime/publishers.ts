import { randomUUID } from 'node:crypto';

import { publishRealtime, realtimePublisherOf, type RealtimePublisher } from './bus.js';
import {
  REALTIME_ENVELOPE_VERSION,
  type JobProgressEnvelope,
  type RecordChangeItem,
  type RecordChangeOp,
  type RecordChangesEnvelope,
} from './envelope.js';
import { publishLinkTitlesOfField } from './link-titles.js';

import type { Db, Tx } from '../db/create-db.js';
import type { JobRecord } from '../jobs/jobs.repository.js';
import type {
  RecordChange,
  RecordChangeFanout,
  RecordChangeField,
  RecordChangeLink,
  RecordChangePublisher,
  RecordChangeType,
} from '../records/record-change-publisher.js';
import type { SchemaChange, SchemaChangePublisher } from '../schema/schema-change-publisher.js';
import type { Id } from '@cellhive/contracts';

export interface RealtimeSchemaChangePublisherOptions {
  /**
   * The database the changes were made in: with it, a change of a table's
   * primary field (`updated`, `converted`) also refreshes the link cells of
   * other tables that show its records (`publishLinkTitlesChanged`, T459).
   */
  readonly db?: Db;
  readonly onError?: (error: unknown) => void;
}

/** `SchemaChangePublisher` (hook of `SchemaService`) that forwards to the realtime bus. */
export class RealtimeSchemaChangePublisher implements SchemaChangePublisher {
  constructor(
    private readonly bus: RealtimePublisher,
    private readonly options: RealtimeSchemaChangePublisherOptions = {},
  ) {}

  async publish(change: SchemaChange): Promise<void> {
    await this.bus.publish({
      v: REALTIME_ENVELOPE_VERSION,
      type: 'schema.changed',
      organization_id: change.organization_id,
      base_id: change.base_id,
      table_id: change.table_id,
      entity: change.entity,
      entity_id: change.entity_id,
      action: change.action,
      ...(change.ai_state === undefined ? {} : { ai_state: change.ai_state }),
    });
    const db = this.options.db;
    if (
      db !== undefined &&
      change.entity === 'field' &&
      (change.action === 'updated' || change.action === 'converted')
    ) {
      await publishLinkTitlesOfField(
        db,
        change.organization_id,
        change.entity_id as Id<'fld'>,
        this.options.onError,
      );
    }
  }
}

/**
 * The `job.progress` envelope of a `meta.jobs` row, for its creator;
 * `undefined` for jobs started by the system (nobody to tell).
 */
export function jobProgressEnvelope(job: JobRecord): JobProgressEnvelope | undefined {
  if (job.created_by === null) return undefined;
  return {
    v: REALTIME_ENVELOPE_VERSION,
    type: 'job.progress',
    organization_id: job.organization_id,
    user_id: job.created_by,
    job_id: job.id,
    progress: job.progress,
    status: job.status,
  };
}

/**
 * Tells the creator of a job (`user:<created_by>`, CONTRACTS §7) its new
 * state and progress, after `tx` commits when given. Called by every
 * `JobsRepository` update, in the api and in the worker.
 */
export async function publishJobProgress(
  db: Db,
  tx: Tx | undefined,
  job: JobRecord | undefined,
): Promise<void> {
  const envelope = job === undefined ? undefined : jobProgressEnvelope(job);
  if (envelope !== undefined) await publishRealtime(db, tx, envelope);
}

/**
 * Asks every api instance to re-check subscriptions of these bases, after
 * `tx` commits when given (`BasesRepository` calls it whenever
 * `permission_version` moves or a base leaves or returns from the trash).
 */
export async function publishPermissionChanged(
  db: Db,
  tx: Tx | undefined,
  organizationId: Id<'org'>,
  baseIds: readonly Id<'bse'>[],
): Promise<void> {
  if (baseIds.length === 0) return;
  await publishRealtime(db, tx, {
    v: REALTIME_ENVELOPE_VERSION,
    type: 'permission.changed',
    organization_id: organizationId,
    base_ids: [...new Set(baseIds)],
  });
}

/**
 * Asks every api instance to close the WebSocket connections of these
 * sessions of `userId` (every session of the user without `sessionIds`),
 * after `tx` commits when given: one envelope on the bus of each of the
 * user's organizations (a connection only receives data through those).
 */
export async function publishSessionsRevoked(
  db: Db,
  tx: Tx | undefined,
  organizationIds: readonly Id<'org'>[],
  userId: Id<'usr'>,
  sessionIds?: readonly Id<'ses'>[],
): Promise<void> {
  if (sessionIds?.length === 0) return;
  for (const organizationId of new Set(organizationIds)) {
    await publishRealtime(db, tx, {
      v: REALTIME_ENVELOPE_VERSION,
      type: 'session.revoked',
      organization_id: organizationId,
      user_id: userId,
      ...(sessionIds === undefined ? {} : { session_ids: [...sessionIds] }),
    });
  }
}

/** Most changes in one `record.changes` envelope. */
export const MAX_RECORD_CHANGES_PER_ENVELOPE = 500;
/** Approximate largest serialized `record.changes` envelope (a larger change still goes alone). */
export const MAX_RECORD_ENVELOPE_BYTES = 512 * 1024;

const OP_OF: Record<RecordChangeType, RecordChangeOp> = {
  'record.created': 'created',
  'record.updated': 'updated',
  'record.deleted': 'deleted',
  'record.restored': 'restored',
  'record.purged': 'purged',
};

export interface RecordEnvelopeLimits {
  readonly maxChanges?: number;
  readonly maxBytes?: number;
}

/**
 * The `record.changes` envelopes of one transaction's changes: one per
 * table and actor, in order, split so that none holds more than
 * `maxChanges` changes or (roughly) `maxBytes` of JSON.
 */
export function recordChangesEnvelopes(
  changes: readonly RecordChange[],
  fields: readonly RecordChangeField[],
  limits: RecordEnvelopeLimits = {},
  links: readonly RecordChangeLink[] = [],
  fanout?: RecordChangeFanout,
): RecordChangesEnvelope[] {
  const maxChanges = limits.maxChanges ?? MAX_RECORD_CHANGES_PER_ENVELOPE;
  const maxBytes = limits.maxBytes ?? MAX_RECORD_ENVELOPE_BYTES;
  const envelopes: RecordChangesEnvelope[] = [];
  const linkMeta = links.map((link) => ({
    field_id: link.id,
    table_id: link.tableId,
    title_field_id: link.titleFieldId,
  }));
  const fieldsBytes = JSON.stringify(fields).length + JSON.stringify(linkMeta).length;
  let current: RecordChangesEnvelope | undefined;
  let bytes = 0;
  for (const change of changes) {
    const item: RecordChangeItem = {
      op: OP_OF[change.type],
      record_id: change.recordId,
      version: change.version,
      event_id: change.eventId,
      changed: [...change.changedFieldIds],
      before: change.before,
      after: change.after,
      values: change.values,
    };
    const size = JSON.stringify(item).length + 1;
    if (
      current?.table_id !== change.tableId ||
      current.actor_id !== change.actorUserId ||
      current.changes.length >= maxChanges ||
      (current.changes.length > 0 && bytes + size > maxBytes)
    ) {
      current = {
        v: REALTIME_ENVELOPE_VERSION,
        type: 'record.changes',
        organization_id: change.organizationId,
        base_id: change.baseId,
        table_id: change.tableId,
        actor_id: change.actorUserId,
        fields: fields.map((field) => ({ ...field })),
        ...(linkMeta.length === 0 ? {} : { links: linkMeta.map((link) => ({ ...link })) }),
        ...(fanout === undefined
          ? {}
          : {
              link_fanout: {
                field_id: fanout.fieldId,
                titles_only: fanout.titlesOnly,
                values: fanout.values,
              },
            }),
        changes: [],
      };
      envelopes.push(current);
      // Envelope keys, ids and the `batch` marker of a split write.
      bytes = fieldsBytes + 384;
    }
    current.changes.push(item);
    bytes += size;
  }
  markBatches(envelopes);
  return envelopes;
}

/**
 * Envelopes of the same table (one write) split into several parts get a
 * shared `batch` marker (T303), so receivers see the write as a whole.
 */
function markBatches(envelopes: RecordChangesEnvelope[]): void {
  const byTable = new Map<string, RecordChangesEnvelope[]>();
  for (const envelope of envelopes) {
    const list = byTable.get(envelope.table_id) ?? [];
    list.push(envelope);
    byTable.set(envelope.table_id, list);
  }
  for (const list of byTable.values()) {
    if (list.length < 2) continue;
    const id = randomUUID();
    list.forEach((envelope, part) => {
      envelope.batch = { id, part, parts: list.length };
    });
  }
}

/**
 * `RecordChangePublisher` of `RecordMutationService` on the realtime bus
 * attached to `db` (`attachRealtimePublisher`), looked up at publish time.
 * Without a bus it is inactive, so writes skip capturing images (CLI, seed).
 * Envelopes are published one after the other, in order.
 */
export class RealtimeRecordChangePublisher implements RecordChangePublisher {
  constructor(
    private readonly db: Db,
    private readonly limits: RecordEnvelopeLimits = {},
  ) {}

  get active(): boolean {
    return realtimePublisherOf(this.db) !== undefined;
  }

  async publish(
    changes: readonly RecordChange[],
    fields: readonly RecordChangeField[],
    links: readonly RecordChangeLink[] = [],
    fanout?: RecordChangeFanout,
  ): Promise<void> {
    const bus = realtimePublisherOf(this.db);
    if (bus === undefined || changes.length === 0) return;
    for (const envelope of recordChangesEnvelopes(changes, fields, this.limits, links, fanout)) {
      await bus.publish(envelope);
    }
  }
}
