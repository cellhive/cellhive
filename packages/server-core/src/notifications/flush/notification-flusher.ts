import { orgScope } from '../../db/repository.js';
import {
  NotificationBufferRepository,
  type NotificationBufferRow,
} from '../buffer/notification-buffer.repository.js';

import type { Db, Tx } from '../../db/create-db.js';
import type { NotificationsFlushPayload } from '../buffer/notification-buffer.js';
import type {
  GroupedNotificationRequest,
  NotificationFanout,
  RecipientSkipReason,
} from '../fanout.js';
import type { Id, NotificationBufferKind } from '@cellhive/contracts';

/** One group of the buffer, locked for its flush. */
export interface NotificationGroup {
  readonly organizationId: Id<'org'>;
  readonly kind: NotificationBufferKind;
  readonly groupKey: string;
  /** In append order. */
  readonly rows: readonly NotificationBufferRow[];
  /** graphile-worker id of the flush job (stable across its retries), or `null`. */
  readonly jobId: string | null;
  /** The flush transaction: reads that must see the group's state (e.g. follows). */
  readonly tx: Tx;
}

/**
 * Turns one group into the notifications to write (ADR-34 §2): registered
 * per `kind` by the task that produces it (T544 `assigned`, T545
 * `followed`). Recipients' access is not the grouper's business: each
 * request goes through `NotificationFanout.runGrouped`.
 */
export interface NotificationGrouper {
  readonly kind: NotificationBufferKind;
  group(
    group: NotificationGroup,
  ): readonly GroupedNotificationRequest[] | Promise<readonly GroupedNotificationRequest[]>;
}

/** What one flush did (ids and counts only: logged by the job). */
export type NotificationFlushOutcome =
  | { readonly status: 'empty' }
  /** No grouper for the kind: rows kept (programming error; logged). */
  | { readonly status: 'no_grouper'; readonly rows: number }
  | {
      readonly status: 'flushed';
      readonly rows: number;
      readonly requests: number;
      /** Notifications recorded (a `group_key` already written records nothing). */
      readonly recorded: number;
      readonly skipped: Readonly<Partial<Record<RecipientSkipReason, number>>>;
    };

/**
 * The work of `notifications.flush` (BACKLOG T542, ADR-34 §2), in **one**
 * transaction: lock the rows of the group (`FOR UPDATE SKIP LOCKED`), ask
 * the grouper of its kind for the notifications, check and write them
 * through `NotificationFanout.runGrouped` (per-recipient access in one read
 * of their records; turns of at most `MAX_NOTIFICATION_RECIPIENTS`), delete
 * the rows. A failure rolls everything back: the rows stay for the retry,
 * and the notifications' `group_key` keeps a re-run from writing twice.
 */
export class NotificationFlusher {
  readonly #repository: NotificationBufferRepository;
  readonly #groupers: ReadonlyMap<NotificationBufferKind, NotificationGrouper>;

  constructor(
    private readonly db: Db,
    private readonly fanout: NotificationFanout,
    groupers: readonly NotificationGrouper[],
  ) {
    this.#repository = new NotificationBufferRepository(db);
    const byKind = new Map<NotificationBufferKind, NotificationGrouper>();
    for (const grouper of groupers) {
      if (byKind.has(grouper.kind)) {
        throw new TypeError(`NotificationFlusher: two groupers for '${grouper.kind}'`);
      }
      byKind.set(grouper.kind, grouper);
    }
    this.#groupers = byKind;
  }

  flush(
    payload: NotificationsFlushPayload,
    context: { readonly jobId: string | null } = { jobId: null },
  ): Promise<NotificationFlushOutcome> {
    return this.db.withTx(async (tx) => {
      const scope = orgScope(payload.organization_id, tx);
      const rows = await this.#repository.lockGroup(scope, payload.kind, payload.group_key);
      if (rows.length === 0) return { status: 'empty' };
      const grouper = this.#groupers.get(payload.kind);
      if (grouper === undefined) return { status: 'no_grouper', rows: rows.length };

      const requests = await grouper.group({
        organizationId: payload.organization_id,
        kind: payload.kind,
        groupKey: payload.group_key,
        rows,
        jobId: context.jobId,
        tx,
      });
      let recorded = 0;
      const skipped: Partial<Record<RecipientSkipReason, number>> = {};
      for (const request of requests) {
        const result = await this.fanout.runGrouped(tx, payload.organization_id, request);
        recorded += result.written.filter((item) => item.id !== null).length;
        for (const item of result.skipped) skipped[item.reason] = (skipped[item.reason] ?? 0) + 1;
      }
      await this.#repository.delete(
        scope,
        rows.map((row) => row.id),
      );
      return {
        status: 'flushed',
        rows: rows.length,
        requests: requests.length,
        recorded,
        skipped,
      };
    });
  }
}
