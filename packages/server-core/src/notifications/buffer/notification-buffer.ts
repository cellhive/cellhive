import {
  NOTIFICATION_BUFFER_FLUSH_DELAY_MS,
  type Id,
  type NotificationBufferKind,
} from '@cellhive/contracts';

import { orgScope } from '../../db/repository.js';
import { enqueue } from '../../jobs/enqueue.js';

import {
  NotificationBufferRepository,
  type NewNotificationBufferRow,
} from './notification-buffer.repository.js';

import type { Db, Tx } from '../../db/create-db.js';

/** Payload of `notifications.flush` (T542): one group of the buffer. */
export interface NotificationsFlushPayload {
  readonly organization_id: Id<'org'>;
  readonly kind: NotificationBufferKind;
  readonly group_key: string;
}

/** Longest `group_key` (a `batch.id` or a record id in practice). */
export const NOTIFICATION_BUFFER_GROUP_KEY_MAX = 200;

/** The graphile-worker job key of a group's flush (ADR-34 §2): one pending flush per group. */
export function notificationFlushJobKey(kind: NotificationBufferKind, groupKey: string): string {
  return `${kind}:${groupKey}`;
}

export interface NotificationBufferAppend {
  readonly organizationId: Id<'org'>;
  readonly kind: NotificationBufferKind;
  /** `batch.id` (`assigned`) or the record id (`followed`). */
  readonly groupKey: string;
  readonly rows: readonly NewNotificationBufferRow[];
  /**
   * Flush right away once the group holds this many distinct records (e.g.
   * `batch.size` of the last event of a batch); otherwise after the delay of
   * `kind` from the first row.
   */
  readonly flushWhenCount?: number;
  /**
   * When the pending flush runs (T544). `from_first` (default, ADR-34 §2):
   * the kind's delay after the **first** row of the group — rows appended
   * later join it. `from_last`: the kind's delay after **this** row — every
   * append pushes the flush back, so a group fed by many separate commits
   * (the chunks of one import share one `batch.id`, ADR-26 §1) is flushed
   * once, after its last row, instead of in parts.
   */
  readonly debounce?: 'from_first' | 'from_last';
  /**
   * Wait of the flush instead of the kind's delay (T608: the writes of an
   * incoming webhook's runs wait `NOTIFICATION_WEBHOOK_WINDOW_MS` for both
   * kinds). `options.delays` of the buffer still wins (tests).
   */
  readonly delayMs?: number;
}

export interface NotificationBufferOptions {
  /** Clock of the flush time (tests pin it). */
  readonly now?: () => Date;
  /** Delays per kind (default `NOTIFICATION_BUFFER_FLUSH_DELAY_MS`, CONTRACTS §22.2). */
  readonly delays?: Partial<Record<NotificationBufferKind, number>>;
}

/**
 * The grouping buffer of notifications (BACKLOG T542, ADR-34 §2): a
 * producer appends rows **in its own transaction** (the outbox rule of
 * ADR-06 — the rows and the flush job exist iff the change commits) and the
 * group gets one `notifications.flush` job: `jobKey = <kind>:<group_key>`,
 * `preserve_run_at` (debounce: rows appended later join the pending flush),
 * run after the delay of the kind — or now once `flushWhenCount` distinct
 * records are buffered (`replace`: the pending flush moves to now). With
 * `debounce: 'from_last'` every append moves the pending flush to the delay
 * after it (`replace`). A flush already running leaves the rows appended
 * meanwhile to a new job.
 */
export class NotificationBuffer {
  readonly #repository: NotificationBufferRepository;
  readonly #now: () => Date;

  constructor(
    db: Db,
    private readonly options: NotificationBufferOptions = {},
  ) {
    this.#repository = new NotificationBufferRepository(db);
    this.#now = options.now ?? (() => new Date());
  }

  /** Appends rows and schedules the group's flush; `flushNow`: the count was reached. */
  async append(tx: Tx, input: NotificationBufferAppend): Promise<{ readonly flushNow: boolean }> {
    if (input.groupKey.length === 0 || input.groupKey.length > NOTIFICATION_BUFFER_GROUP_KEY_MAX) {
      throw new RangeError(
        `NotificationBuffer.append: groupKey must be 1…${String(NOTIFICATION_BUFFER_GROUP_KEY_MAX)} characters`,
      );
    }
    if (
      input.flushWhenCount !== undefined &&
      (!Number.isInteger(input.flushWhenCount) || input.flushWhenCount < 1)
    ) {
      throw new RangeError('NotificationBuffer.append: flushWhenCount must be a positive integer');
    }
    if (input.delayMs !== undefined && (!Number.isInteger(input.delayMs) || input.delayMs < 0)) {
      throw new RangeError('NotificationBuffer.append: delayMs must be a non-negative integer');
    }
    if (input.rows.length === 0) return { flushNow: false };
    const scope = orgScope(input.organizationId, tx);
    await this.#repository.append(scope, input.kind, input.groupKey, input.rows);
    const flushNow =
      input.flushWhenCount !== undefined &&
      (await this.#repository.countRecords(scope, input.kind, input.groupKey)) >=
        input.flushWhenCount;
    const now = this.#now();
    const delay =
      this.options.delays?.[input.kind] ??
      input.delayMs ??
      NOTIFICATION_BUFFER_FLUSH_DELAY_MS[input.kind];
    await enqueue(
      tx,
      'notifications.flush',
      { organization_id: input.organizationId, kind: input.kind, group_key: input.groupKey },
      {
        jobKey: notificationFlushJobKey(input.kind, input.groupKey),
        jobKeyMode: flushNow || input.debounce === 'from_last' ? 'replace' : 'preserve_run_at',
        runAt: flushNow ? now : new Date(now.getTime() + delay),
      },
    );
    return { flushNow };
  }
}

/**
 * Schedules a group's flush now (cron `notifications.cleanup` for rows whose
 * job was lost), in `tx` or on its own.
 */
export async function scheduleNotificationFlush(
  tx: Tx,
  payload: NotificationsFlushPayload,
  runAt: Date,
): Promise<void> {
  await enqueue(tx, 'notifications.flush', payload, {
    jobKey: notificationFlushJobKey(payload.kind, payload.group_key),
    jobKeyMode: 'replace',
    runAt,
  });
}
