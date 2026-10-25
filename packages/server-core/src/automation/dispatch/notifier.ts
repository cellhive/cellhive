import {
  notifyAutomationBatchOverflow,
  notifyAutomationDisabled,
} from '../../notifications/fanout.js';

import type { Tx } from '../../db/create-db.js';
import type { AutomationDisabledReasonKind } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

/** An automation the system turned off (ADR-25 §5, ADR-26 §5). */
export interface AutomationDisabledNotice {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly automationId: Id<'aut'>;
  readonly automationName: string;
  readonly runAsUserId: Id<'usr'>;
  readonly reason: AutomationDisabledReasonKind;
  /** `version` after the change: makes a retried producer idempotent. */
  readonly version: number;
}

/** A batch went over `AUTOMATION_MAX_RUNS_PER_BATCH` for one automation (ADR-26 §4). */
export interface AutomationBatchOverflowNotice {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly automationId: Id<'aut'>;
  readonly automationName: string;
  readonly runAsUserId: Id<'usr'>;
  /** The `skipped` run that stands for the records of the batch that got no run. */
  readonly runId: Id<'run'>;
  readonly batchId: string;
  readonly limit: number;
}

/**
 * Who hears about automations the dispatcher acts on (BACKLOG T503):
 * `run_as` + base owner/admins, through the in-app notifications of T511
 * (`automation.disabled`, `automation.batch_overflow`, ADR-25/26/29).
 * Called inside the dispatch transaction, so a notification exists iff the
 * change it reports commits.
 */
export interface AutomationNotifier {
  automationDisabled(tx: Tx, notice: AutomationDisabledNotice): Promise<void>;
  batchOverflow(tx: Tx, notice: AutomationBatchOverflowNotice): Promise<void>;
}

/** The notifications of T511 (`notifications.fanout` queued in the same transaction). */
export const AUTOMATION_NOTIFICATIONS: AutomationNotifier = {
  automationDisabled: (tx, notice) =>
    notifyAutomationDisabled(tx, {
      organizationId: notice.organizationId,
      baseId: notice.baseId,
      automationId: notice.automationId,
      runAsUserId: notice.runAsUserId,
      reason: notice.reason,
      groupKey: `${notice.automationId}:${String(notice.version)}`,
    }),
  batchOverflow: (tx, notice) =>
    notifyAutomationBatchOverflow(tx, {
      organizationId: notice.organizationId,
      baseId: notice.baseId,
      automationId: notice.automationId,
      runId: notice.runId,
      batchId: notice.batchId,
      limit: notice.limit,
      runAsUserId: notice.runAsUserId,
    }),
};

/** No notifications (tests that look at the dispatch alone). */
export const NO_AUTOMATION_NOTIFICATIONS: AutomationNotifier = {
  automationDisabled: () => Promise.resolve(),
  batchOverflow: () => Promise.resolve(),
};
