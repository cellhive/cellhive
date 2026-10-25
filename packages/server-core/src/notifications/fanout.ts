import {
  ACTIVE_NOTIFICATION_TYPES,
  NOTIFICATION_DATA_SCHEMAS,
  type Id,
  type NotificationEntityType,
  type NotificationType,
} from '@cellhive/contracts';

import { OrgMembersRepository } from '../db/repositories/org-members.repository.js';
import { UsersRepository } from '../db/repositories/users.repository.js';
import { orgScope, type OrgScope } from '../db/repository.js';
import {
  loadMemberAccessBase,
  resolveMemberBaseAccess,
  type AccessDefaults,
  type MemberAccessBase,
  type MemberBaseAccess,
} from '../import/member-access.js';
import { enqueue } from '../jobs/enqueue.js';

import {
  NotificationWriter,
  type PreparedNotification,
  type WrittenNotification,
} from './notification-writer.js';
import { readableRecordTitles } from './record-titles.js';

import type { Db, Tx } from '../db/create-db.js';
import type { ActorType, JsonObject } from '../db/schema.js';
import type { RecordQueryService } from '../records/record-query.service.js';

/** Most explicit recipients of one notification request. */
export const MAX_NOTIFICATION_RECIPIENTS = 1000;

/**
 * Payload of `notifications.fanout` (ADR-29 §1, BACKLOG T511): who may
 * receive a notification, and what they must be able to read **when it is
 * sent**. Stored-form data only (ids, parameters).
 */
export interface NotificationsFanoutPayload {
  readonly organization_id: Id<'org'>;
  readonly type: NotificationType;
  readonly base_id: Id<'bse'> | null;
  readonly table_id: Id<'tbl'> | null;
  readonly entity_type: NotificationEntityType;
  readonly entity_id: string;
  readonly actor: { readonly type: ActorType; readonly id: string } | null;
  /** Idempotency of the producer: one notification per (user, type, key). */
  readonly group_key: string | null;
  readonly recipients: {
    readonly user_ids: readonly Id<'usr'>[];
    /** Also every current admin of `base_id` (org owner/admin, base owner, workspace or role admin). */
    readonly base_admins: boolean;
  };
  /**
   * A record every recipient must read (in `table_id`), fields of it they
   * must all read, and fields they must read at least one of
   * (`any_field_ids`, T542: a `field_ids` array in `data` then keeps only the
   * ones each recipient reads). `any_field_ids` is optional: jobs queued
   * before T542 have none.
   */
  readonly requires: {
    readonly record_id: Id<'rec'> | null;
    readonly field_ids: readonly Id<'fld'>[];
    readonly any_field_ids?: readonly Id<'fld'>[] | undefined;
  };
  /** Leave out the user behind the change (ADR-29: the default, except `automation.message`). */
  readonly skip_actor: boolean;
  readonly data: JsonObject;
}

/** Why a candidate recipient was left out (counted in logs, never with values). */
export type RecipientSkipReason =
  'actor' | 'not_member' | 'cannot_read_base' | 'cannot_read_record' | 'cannot_read_field';

export interface FanoutResult {
  readonly written: readonly WrittenNotification[];
  readonly skipped: readonly { readonly userId: Id<'usr'>; readonly reason: RecipientSkipReason }[];
}

export interface NotificationRequest {
  readonly organizationId: Id<'org'>;
  readonly type: NotificationType;
  readonly baseId: Id<'bse'> | null;
  readonly tableId?: Id<'tbl'> | null;
  readonly entityType: NotificationEntityType;
  readonly entityId: string;
  readonly actor?: { readonly type: ActorType; readonly id: string } | null;
  readonly groupKey?: string | null;
  readonly userIds?: readonly Id<'usr'>[];
  readonly baseAdmins?: boolean;
  readonly recordId?: Id<'rec'> | null;
  readonly fieldIds?: readonly Id<'fld'>[];
  /** At least one must be readable; `data.field_ids` is filtered per recipient (T542). */
  readonly anyFieldIds?: readonly Id<'fld'>[];
  readonly skipActor?: boolean;
  readonly data: JsonObject;
  /**
   * graphile-worker priority of the fan-out job (lower runs first; default
   * 0): a producer whose own change queued many jobs just before (an
   * import's `events.dispatch` jobs, T548) puts its notification ahead.
   */
  readonly priority?: number;
}

/**
 * Queues `notifications.fanout` in the caller's transaction (ADR-06): the
 * notification exists only if the change that causes it commits. The job
 * computes recipients and checks their access when it runs (ADR-29 §1).
 * The `data` of an S5 type is validated here (programming error otherwise).
 */
export async function enqueueNotification(tx: Tx, request: NotificationRequest): Promise<void> {
  const schema = (
    NOTIFICATION_DATA_SCHEMAS as Partial<Record<NotificationType, { parse(v: unknown): unknown }>>
  )[request.type];
  if (
    !(ACTIVE_NOTIFICATION_TYPES as readonly NotificationType[]).includes(request.type) ||
    schema === undefined
  ) {
    throw new TypeError(`enqueueNotification: '${request.type}' is not produced yet`);
  }
  schema.parse(request.data);
  const userIds = [...new Set(request.userIds ?? [])];
  if (userIds.length > MAX_NOTIFICATION_RECIPIENTS) {
    throw new RangeError(
      `enqueueNotification: more than ${String(MAX_NOTIFICATION_RECIPIENTS)} recipients`,
    );
  }
  if ((request.recordId ?? null) !== null && (request.tableId ?? null) === null) {
    throw new TypeError('enqueueNotification: a record needs its table');
  }
  if ((request.tableId ?? null) !== null && request.baseId === null) {
    throw new TypeError('enqueueNotification: a table needs its base');
  }
  const payload: NotificationsFanoutPayload = {
    organization_id: request.organizationId,
    type: request.type,
    base_id: request.baseId,
    table_id: request.tableId ?? null,
    entity_type: request.entityType,
    entity_id: request.entityId,
    actor: request.actor ?? null,
    group_key: request.groupKey ?? null,
    recipients: { user_ids: userIds, base_admins: request.baseAdmins ?? false },
    requires: {
      record_id: request.recordId ?? null,
      field_ids: request.fieldIds ?? [],
      ...(request.anyFieldIds === undefined || request.anyFieldIds.length === 0
        ? {}
        : { any_field_ids: request.anyFieldIds }),
    },
    skip_actor: request.skipActor ?? request.type !== 'automation.message',
    data: request.data,
  };
  await enqueue(
    tx,
    'notifications.fanout',
    payload,
    request.priority === undefined ? {} : { priority: request.priority },
  );
}

/**
 * `automation.disabled` (ADR-25 §2, ADR-26): to the automation's `run_as`
 * user and every admin of its base. Mandatory: cannot be turned off in-app
 * and ignores base mutes. `groupKey` makes a retried producer idempotent
 * (e.g. `<automation_id>:<version>`).
 */
export function notifyAutomationDisabled(
  tx: Tx,
  input: {
    readonly organizationId: Id<'org'>;
    readonly baseId: Id<'bse'>;
    readonly automationId: Id<'aut'>;
    readonly runAsUserId: Id<'usr'> | null;
    readonly reason: 'circuit_breaker' | 'run_as_lost_access';
    readonly groupKey: string;
  },
): Promise<void> {
  return enqueueNotification(tx, {
    organizationId: input.organizationId,
    type: 'automation.disabled',
    baseId: input.baseId,
    entityType: 'automation',
    entityId: input.automationId,
    actor: null,
    groupKey: input.groupKey,
    userIds: input.runAsUserId === null ? [] : [input.runAsUserId],
    baseAdmins: true,
    data: { automation_id: input.automationId, reason: input.reason },
  });
}

/** `automation.batch_overflow` (ADR-26): `run_as` + base admins, once per batch. */
export function notifyAutomationBatchOverflow(
  tx: Tx,
  input: {
    readonly organizationId: Id<'org'>;
    readonly baseId: Id<'bse'>;
    readonly automationId: Id<'aut'>;
    readonly runId: Id<'run'>;
    readonly batchId: string;
    readonly limit: number;
    readonly runAsUserId: Id<'usr'> | null;
  },
): Promise<void> {
  return enqueueNotification(tx, {
    organizationId: input.organizationId,
    type: 'automation.batch_overflow',
    baseId: input.baseId,
    entityType: 'automation',
    entityId: input.automationId,
    actor: null,
    groupKey: `${input.automationId}:${input.batchId}`,
    userIds: input.runAsUserId === null ? [] : [input.runAsUserId],
    baseAdmins: true,
    data: {
      automation_id: input.automationId,
      run_id: input.runId,
      batch_id: input.batchId,
      limit: input.limit,
    },
  });
}

export interface NotificationFanoutOptions {
  readonly emailEnabled: boolean;
  /** Wait of the `immediate` email batch (T512; default 5 minutes). */
  readonly emailBatchMs?: number;
  /** Wait of the Telegram batch (T550; default 5 seconds). */
  readonly telegramBatchMs?: number;
  readonly defaults: AccessDefaults;
}

/**
 * One notification for many candidates, each checked and given their own
 * `data` (T542, ADR-34 §2): what a buffer grouper (`notifications.flush`)
 * asks {@link NotificationFanout.runGrouped} to write.
 */
export interface GroupedNotificationRequest {
  readonly type: NotificationType;
  readonly baseId: Id<'bse'> | null;
  readonly tableId: Id<'tbl'> | null;
  readonly entityType: NotificationEntityType;
  readonly entityId: string;
  readonly actor: { readonly type: ActorType; readonly id: string } | null;
  readonly groupKey: string | null;
  /**
   * Candidates: a list, or a function computing it (e.g. the followers of a
   * record). Any number: written in turns of at most
   * {@link MAX_NOTIFICATION_RECIPIENTS}.
   */
  readonly recipients: readonly Id<'usr'>[] | (() => Promise<readonly Id<'usr'>[]>);
  /** Users behind the change(s): left out (reason `actor`). */
  readonly skipUserIds?: readonly Id<'usr'>[];
  readonly requires?: {
    /** Records of `tableId`: the recipient must read **at least one** (all checked in one read). */
    readonly recordIds?: readonly Id<'rec'>[];
    /** Fields of `tableId` the recipient must **all** read. */
    readonly fieldIds?: readonly Id<'fld'>[];
    /** Fields of `tableId` the recipient must read **at least one** of. */
    readonly anyFieldIds?: readonly Id<'fld'>[];
  };
  /**
   * `data` of one recipient from what they read now (`recordIds`,
   * `anyFieldIds` filtered, in the given order); `null` leaves them out
   * (reason `cannot_read_record`). Validated against the type's schema.
   */
  readonly dataFor: (userId: Id<'usr'>, readable: ReadableParts) => JsonObject | null;
  /**
   * Called for each recipient whose `data` was accepted, in the flush
   * transaction, before the notification is written (T544: the automatic
   * follow of the records an assignee reads). Runs whatever the recipient's
   * channel preferences, and again on a re-run of the flush: it must be
   * idempotent.
   */
  readonly onAccepted?: (userId: Id<'usr'>, readable: ReadableParts) => Promise<void>;
  /**
   * The `actor` of one recipient's notification from what they read now
   * (T545: the latest change they can see, so that a change to fields they
   * cannot read never names its author); default: `actor` for everyone.
   */
  readonly actorFor?: (
    userId: Id<'usr'>,
    readable: ReadableParts,
  ) => { readonly type: ActorType; readonly id: string } | null;
}

/** What one recipient reads of a request's requirements. */
export interface ReadableParts {
  readonly recordIds: readonly Id<'rec'>[];
  readonly fieldIds: readonly Id<'fld'>[];
}

/** What a recipient must read (both fan-out flavours). */
interface Requirement {
  readonly baseId: Id<'bse'> | null;
  readonly tableId: Id<'tbl'> | null;
  /** `all`: every record (a single one in practice); `any`: at least one. */
  readonly records: { readonly ids: readonly Id<'rec'>[]; readonly mode: 'all' | 'any' };
  readonly fieldIds: readonly Id<'fld'>[];
  readonly anyFieldIds: readonly Id<'fld'>[];
}

type CheckOutcome =
  | { readonly ok: true; readonly readable: ReadableParts }
  | { readonly ok: false; readonly reason: RecipientSkipReason };

/** Access of every candidate to one base, resolved once per user. */
interface BaseAccessCache {
  /** `undefined`: no base, or the base is gone (nobody reads it). */
  readonly shared: MemberAccessBase | undefined;
  readonly resolve: (userId: Id<'usr'>) => Promise<MemberBaseAccess | undefined>;
}

/**
 * The work of `notifications.fanout` (ADR-29 §1): expands the recipients,
 * checks **each** one's current access — active member; reads the base;
 * reads the record, every required field and at least one of the "any"
 * fields — leaves out the others without disclosing anything, then records
 * the notifications through `NotificationWriter` (preferences, mutes, email
 * queue, realtime), in turns of at most {@link MAX_NOTIFICATION_RECIPIENTS}.
 * `runGrouped` does the same for a notification `notifications.flush`
 * gathered from the buffer (T542), in the flush transaction.
 */
export class NotificationFanout {
  readonly #writer: NotificationWriter;

  constructor(
    private readonly db: Db,
    private readonly query: RecordQueryService,
    private readonly options: NotificationFanoutOptions,
  ) {
    this.#writer = new NotificationWriter(db, {
      emailEnabled: options.emailEnabled,
      ...(options.emailBatchMs === undefined ? {} : { emailBatchMs: options.emailBatchMs }),
      ...(options.telegramBatchMs === undefined
        ? {}
        : { telegramBatchMs: options.telegramBatchMs }),
    });
  }

  async run(payload: NotificationsFanoutPayload): Promise<FanoutResult> {
    const scope = orgScope(payload.organization_id);
    const skipped: { userId: Id<'usr'>; reason: RecipientSkipReason }[] = [];
    const candidates = new Set<Id<'usr'>>(payload.recipients.user_ids);
    const cache = await this.baseAccess(scope, payload.base_id);
    if (payload.base_id !== null && cache.shared === undefined) {
      // The base is gone (or in the trash): nobody can read it.
      return {
        written: [],
        skipped: [...candidates].map((userId) => ({ userId, reason: 'cannot_read_base' })),
      };
    }

    if (payload.recipients.base_admins && cache.shared !== undefined) {
      for (const member of await new OrgMembersRepository(this.db).list(scope)) {
        if ((await cache.resolve(member.user_id))?.isAdmin === true) {
          candidates.add(member.user_id);
        }
      }
    }
    if (payload.skip_actor && payload.actor?.type === 'user') {
      const actorId = payload.actor.id as Id<'usr'>;
      if (candidates.delete(actorId)) skipped.push({ userId: actorId, reason: 'actor' });
    }

    const requirement: Requirement = {
      baseId: payload.base_id,
      tableId: payload.table_id,
      records: {
        ids: payload.requires.record_id === null ? [] : [payload.requires.record_id],
        mode: 'all',
      },
      fieldIds: payload.requires.field_ids,
      anyFieldIds: payload.requires.any_field_ids ?? [],
    };
    const prepared: PreparedNotification[] = [];
    for (const userId of [...candidates].sort()) {
      const outcome = await this.check(scope, requirement, userId, cache);
      if (!outcome.ok) {
        skipped.push({ userId, reason: outcome.reason });
        continue;
      }
      prepared.push({
        userId,
        type: payload.type,
        baseId: payload.base_id,
        tableId: payload.table_id,
        entityType: payload.entity_type,
        entityId: payload.entity_id,
        actor: payload.actor,
        groupKey: payload.group_key,
        data: dataWithReadableFields(payload.data, requirement, outcome.readable),
      });
    }

    const written = await this.db.withTx((tx) =>
      this.writeInTurns(tx, payload.organization_id, prepared),
    );
    return { written, skipped };
  }

  /**
   * Checks and writes one grouped notification **in `tx`** (the flush
   * transaction of `notifications.flush`, T542): candidates from
   * `request.recipients`, the users behind the change left out, each
   * recipient's access checked now with one read of every required record,
   * `data` built per recipient by `request.dataFor`. Access is read outside
   * `tx` (plain reads); writes, email queueing and the realtime
   * announcements (after commit) go through `tx`.
   */
  async runGrouped(
    tx: Tx,
    organizationId: Id<'org'>,
    request: GroupedNotificationRequest,
  ): Promise<FanoutResult> {
    if (request.tableId !== null && request.baseId === null) {
      throw new TypeError('runGrouped: a table needs its base');
    }
    const records = request.requires?.recordIds ?? [];
    if (records.length > 0 && request.tableId === null) {
      throw new TypeError('runGrouped: records need their table');
    }
    const schema = (
      NOTIFICATION_DATA_SCHEMAS as Partial<Record<NotificationType, { parse(v: unknown): unknown }>>
    )[request.type];
    if (schema === undefined) {
      throw new TypeError(`runGrouped: '${request.type}' has no data schema`);
    }

    const scope = orgScope(organizationId);
    const skipped: { userId: Id<'usr'>; reason: RecipientSkipReason }[] = [];
    const listed =
      typeof request.recipients === 'function' ? await request.recipients() : request.recipients;
    const candidates = new Set<Id<'usr'>>(listed);
    for (const userId of new Set(request.skipUserIds ?? [])) {
      if (candidates.delete(userId)) skipped.push({ userId, reason: 'actor' });
    }
    const cache = await this.baseAccess(scope, request.baseId);
    if (request.baseId !== null && cache.shared === undefined) {
      return {
        written: [],
        skipped: [
          ...skipped,
          ...[...candidates].sort().map((userId) => ({
            userId,
            reason: 'cannot_read_base' as const,
          })),
        ],
      };
    }

    const requirement: Requirement = {
      baseId: request.baseId,
      tableId: request.tableId,
      records: { ids: [...new Set(records)], mode: 'any' },
      fieldIds: request.requires?.fieldIds ?? [],
      anyFieldIds: request.requires?.anyFieldIds ?? [],
    };
    const prepared: PreparedNotification[] = [];
    for (const userId of [...candidates].sort()) {
      const outcome = await this.check(scope, requirement, userId, cache);
      if (!outcome.ok) {
        skipped.push({ userId, reason: outcome.reason });
        continue;
      }
      const data = request.dataFor(userId, outcome.readable);
      if (data === null) {
        skipped.push({ userId, reason: 'cannot_read_record' });
        continue;
      }
      schema.parse(data);
      await request.onAccepted?.(userId, outcome.readable);
      prepared.push({
        userId,
        type: request.type,
        baseId: request.baseId,
        tableId: request.tableId,
        entityType: request.entityType,
        entityId: request.entityId,
        actor:
          request.actorFor === undefined
            ? request.actor
            : request.actorFor(userId, outcome.readable),
        groupKey: request.groupKey,
        data,
      });
    }
    return { written: await this.writeInTurns(tx, organizationId, prepared), skipped };
  }

  /** Writes in turns of at most {@link MAX_NOTIFICATION_RECIPIENTS} rows, in `tx`. */
  private async writeInTurns(
    tx: Tx,
    organizationId: Id<'org'>,
    prepared: readonly PreparedNotification[],
  ): Promise<WrittenNotification[]> {
    const written: WrittenNotification[] = [];
    for (let start = 0; start < prepared.length; start += MAX_NOTIFICATION_RECIPIENTS) {
      written.push(
        ...(await this.#writer.write(
          tx,
          organizationId,
          prepared.slice(start, start + MAX_NOTIFICATION_RECIPIENTS),
        )),
      );
    }
    return written;
  }

  /** The base read once, each member's access resolved once (like a request of theirs). */
  private async baseAccess(scope: OrgScope, baseId: Id<'bse'> | null): Promise<BaseAccessCache> {
    const shared = baseId === null ? undefined : await loadMemberAccessBase(this.db, scope, baseId);
    const accessOf = new Map<Id<'usr'>, MemberBaseAccess | undefined>();
    return {
      shared,
      resolve: async (userId) => {
        if (baseId === null || shared === undefined) return undefined;
        if (!accessOf.has(userId)) {
          accessOf.set(
            userId,
            await resolveMemberBaseAccess(
              this.db,
              scope,
              { userId, baseId },
              this.options.defaults,
              shared,
            ),
          );
        }
        return accessOf.get(userId);
      },
    };
  }

  private async check(
    scope: OrgScope,
    requirement: Requirement,
    userId: Id<'usr'>,
    cache: BaseAccessCache,
  ): Promise<CheckOutcome> {
    const none: ReadableParts = { recordIds: [], fieldIds: [] };
    if (cache.shared === undefined) {
      const [user, member] = await Promise.all([
        new UsersRepository(this.db).findById(userId),
        new OrgMembersRepository(this.db).get(scope, userId),
      ]);
      return user?.status === 'active' && member !== undefined
        ? { ok: true, readable: none }
        : { ok: false, reason: 'not_member' };
    }
    const access = await cache.resolve(userId);
    if (access === undefined) return { ok: false, reason: 'cannot_read_base' };
    const tableId = requirement.tableId;
    if (tableId === null) return { ok: true, readable: none };
    const table = access.record.resolved.access.tables[tableId];
    if (table === undefined) return { ok: false, reason: 'cannot_read_record' };

    let recordIds: Id<'rec'>[] = [];
    if (requirement.records.ids.length > 0) {
      // One read for every record of this recipient (ADR-34 §2).
      const titles = await readableRecordTitles(
        this.db,
        this.query,
        scope,
        access.record,
        tableId,
        requirement.records.ids,
      );
      recordIds = requirement.records.ids.filter((id) => titles.has(id));
      const enough =
        requirement.records.mode === 'all'
          ? recordIds.length === requirement.records.ids.length
          : recordIds.length > 0;
      if (!enough) return { ok: false, reason: 'cannot_read_record' };
    }
    for (const fieldId of requirement.fieldIds) {
      if (table.fields[fieldId] === undefined) return { ok: false, reason: 'cannot_read_field' };
    }
    const fieldIds = requirement.anyFieldIds.filter((id) => table.fields[id] !== undefined);
    if (requirement.anyFieldIds.length > 0 && fieldIds.length === 0) {
      return { ok: false, reason: 'cannot_read_field' };
    }
    return { ok: true, readable: { recordIds, fieldIds } };
  }
}

/**
 * `data` of a queued fan-out for one recipient: with "any" fields, a
 * `field_ids` array keeps only the fields that recipient reads (ADR-29 §1:
 * never name a field they cannot read).
 */
function dataWithReadableFields(
  data: JsonObject,
  requirement: Requirement,
  readable: ReadableParts,
): JsonObject {
  if (requirement.anyFieldIds.length === 0 || !Array.isArray(data.field_ids)) return data;
  const keep = new Set<string>(readable.fieldIds);
  return {
    ...data,
    field_ids: data.field_ids.filter((id) => typeof id === 'string' && keep.has(id)),
  };
}
