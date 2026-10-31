import type { TableImportPayload } from '../import/run-import.js';
import type { NotificationsFlushPayload } from '../notifications/buffer/notification-buffer.js';
import type { NotificationsTelegramPollPayload } from '../notifications/channels/telegram/telegram-poll-job.js';
import type { NotificationsTelegramReplyPayload } from '../notifications/channels/telegram/telegram-replies.js';
import type {
  NotificationsTelegramSparsePollPayload,
  NotificationsTelegramWebhookCheckPayload,
} from '../notifications/channels/telegram/telegram-sparse-poll.js';
import type { NotificationsDeliverPayload } from '../notifications/delivery/email-delivery.js';
import type { NotificationsFanoutPayload } from '../notifications/fanout.js';
import type { Id } from '@cellhive/contracts';
// Brings graphile-worker's global `GraphileWorker.Tasks` interface into scope.
import type {} from 'graphile-worker';

/** PostgreSQL schema owned by graphile-worker (SPEC §3). */
export const JOB_QUEUE_SCHEMA = 'graphile_worker';

/** Payload of `events.dispatch`: enough to find the event row in its partition. */
export interface EventsDispatchPayload {
  readonly event_id: Id<'evt'>;
  readonly organization_id: Id<'org'>;
  /** `created_at` of the event (partition key), ISO 8601 UTC with microseconds. */
  readonly created_at: string;
}

/**
 * Payload of `automation.run` (SPEC §11.1, §11.7): enqueued by
 * `events.dispatch` (BACKLOG T503) in the transaction that creates the
 * `queued` run; executed by the run engine (T505). Never a `queue_name`
 * (ADR-18): fairness between organizations is `AUTOMATION_MAX_RUNNING_PER_ORG`.
 */
export interface AutomationRunPayload {
  readonly organization_id: Id<'org'>;
  readonly run_id: Id<'run'>;
}

/**
 * Payload of `automation.revalidate_run_as` (ADR-25 §5, BACKLOG T507):
 * checks the enabled automations of one base (`base_id`) or of the whole
 * organization (`null`) against the current access of their `run_as`.
 * Enqueued in the transaction of a permission change (job key per base or
 * organization, debounced) and by the run engine when `run_as` lost a
 * table; a large organization continues in a new job after the automation
 * id `after` (keyset).
 */
export interface AutomationRevalidateRunAsPayload {
  readonly organization_id: Id<'org'>;
  readonly base_id: Id<'bse'> | null;
  readonly after: Id<'aut'> | null;
}

/**
 * Payload of `http.deliver` (ADR-35 §4, BACKLOG T605): phase 2 of the
 * outbound HTTP outbox for one `meta.http_deliveries` row. Job key
 * `http:<delivery_id>` (one pending job per delivery); never a `queue_name`.
 */
export interface HttpDeliverPayload {
  readonly organization_id: Id<'org'>;
  readonly delivery_id: Id<'hdl'>;
}

/** `partitions.maintain` takes no input; cron adds its own `_cron` key. */
export interface PartitionsMaintainPayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/** `maintenance.cleanup` takes no input; cron adds its own `_cron` key. */
export interface MaintenanceCleanupPayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/** `imports.cleanup` takes no input; cron adds its own `_cron` key. */
export interface ImportsCleanupPayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/** `attachments.cleanup` (T406) takes no input; cron adds its own `_cron` key. */
export interface AttachmentsCleanupPayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/**
 * Payload of `file.thumbnail` (BACKLOG T407): enqueued by `complete` for a
 * raster image, in the transaction that marks the upload ready. Renders the
 * WebP thumbnails of the attachment's object (`{object_key}_t<size>`).
 */
export interface FileThumbnailPayload {
  readonly organization_id: Id<'org'>;
  readonly attachment_id: Id<'att'>;
}

/**
 * `records.purge` (T408): daily cron, no input; starts one
 * `records.purge_org` job per organization with tables.
 */
export interface RecordsPurgePayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/**
 * Payload of `records.purge_org` (T408): permanently deletes the records of
 * the organization trashed more than 30 days ago, table by table, in
 * batches. `job_id` is its `meta.jobs` row (type `records.purge`, created
 * by the system), which the per-organization slot counts (ADR-18).
 */
export interface RecordsPurgeOrgPayload {
  readonly organization_id: Id<'org'>;
  readonly job_id: Id<'job'>;
}

/**
 * `tables.purge` (T461): daily cron, no input; starts one `tables.purge_org`
 * job per organization with tables in the trash for more than 30 days.
 */
export interface TablesPurgePayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/**
 * Payload of `tables.purge_org` (T461): permanently deletes the tables of
 * the organization trashed more than 30 days ago, one transaction each.
 * `job_id` is its `meta.jobs` row (type `tables.purge`, created by the
 * system), which the per-organization slot counts (ADR-18).
 */
export interface TablesPurgeOrgPayload {
  readonly organization_id: Id<'org'>;
  readonly job_id: Id<'job'>;
}

/** `exports.cleanup` takes no input; cron adds its own `_cron` key. */
export interface ExportsCleanupPayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/**
 * Payload of `schema.compact_table` (ADR-20), queue `schema:<tableId>`:
 * rebuilds the data table to give back the column slots of dropped columns.
 */
export interface SchemaCompactTablePayload {
  readonly organization_id: Id<'org'>;
  readonly table_id: Id<'tbl'>;
}

/**
 * Payload of `schema.recompute_auto_number` (SPEC §5.5), queue
 * `schema:<tableId>`: fills an `auto_number` column of existing records after
 * the field is added or its rules change. The record writes go through
 * `RecordMutationService` (AGENTS.md rule 1), so T107 implements the task.
 */
export interface SchemaRecomputeAutoNumberPayload {
  readonly organization_id: Id<'org'>;
  readonly table_id: Id<'tbl'>;
  readonly field_id: Id<'fld'>;
}

/**
 * Payload of `schema.remove_select_options` (T103), queue `schema:<tableId>`:
 * select options were deleted from a field, so their ids are removed from
 * the records that still hold them. The record writes go through
 * `RecordMutationService` (AGENTS.md rule 1); every changed record gets a
 * `record.updated` event and an audit entry with `batch_id` (ADR-23).
 */
export interface SchemaRemoveSelectOptionsPayload {
  readonly organization_id: Id<'org'>;
  readonly table_id: Id<'tbl'>;
  readonly field_id: Id<'fld'>;
  /** Ids of the deleted options (1–1 000). */
  readonly option_ids: readonly Id<'opt'>[];
  /** `batch_id` of the audit entries: groups every record the job changes. */
  readonly batch_id: Id<'job'>;
}

/**
 * Payload of `field.convert` (T403, SPEC §5.5 step 2), queue
 * `schema:<tableId>`: converts the values of a field whose type changed,
 * from its old column into the new one, in batches of 5 000 rows. The
 * conversion row (`meta.field_conversions`, keyed by `job_id`) holds the
 * definitions, columns and position, so the job resumes where it stopped.
 */
export interface FieldConvertPayload {
  readonly organization_id: Id<'org'>;
  readonly table_id: Id<'tbl'>;
  readonly field_id: Id<'fld'>;
  readonly job_id: Id<'job'>;
}

/**
 * Payload of `computed.backfill` (BACKLOG T456, SPEC §5.9), queue
 * `schema:<tableId>`: computes the stored values of a formula/lookup field
 * whose definition was created or changed, then of every stored computed
 * field reading it, in topological order, in batches of 5 000 rows.
 * `fingerprint` is the definition the job computes (`computedFingerprint`):
 * once the field has another one, the job stops (a newer job computes it).
 */
export interface ComputedBackfillPayload {
  readonly organization_id: Id<'org'>;
  readonly table_id: Id<'tbl'>;
  readonly field_id: Id<'fld'>;
  readonly job_id: Id<'job'>;
  readonly fingerprint: string;
}

/**
 * Payload of `computed.recompute` (BACKLOG T458, SPEC §5.9): recomputes the
 * records of a stored formula/lookup field queued in
 * `meta.computed_recompute_queue` (a write touched more rows than it could
 * recompute itself), in batches of 5 000, then the fields reading it.
 * Debounced per field (`job_key = computed.recompute:<fieldId>`,
 * `preserve_run_at`, 2 s; ADR-18 §5); no `meta.jobs` row.
 */
export interface ComputedRecomputePayload {
  readonly organization_id: Id<'org'>;
  readonly field_id: Id<'fld'>;
}

/** `field.conversion_cleanup` takes no input; cron adds its own `_cron` key. */
export interface FieldConversionCleanupPayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/**
 * Payload of `audit.export` (CONTRACTS §11.4): writes the organization's
 * audit entries matching `filters` as CSV to object storage and records the
 * download link in `meta.jobs.result` of `job_id` (an `audit.export` or,
 * with `filters.base_id`, an `audit.base_export` job — T709).
 */
export interface AuditExportPayload {
  readonly organization_id: Id<'org'>;
  readonly job_id: Id<'job'>;
  /**
   * CONTRACTS §11.4 filters by name (`actor_id`, `base_id`, … , `from`/`to`
   * as ISO 8601; repeatable filters as lists); the task validates them
   * again.
   */
  readonly filters: Readonly<Record<string, string | readonly string[]>>;
}

/**
 * Payload of `auth.password_reset_email` (`POST /auth/forgot-password`):
 * the address as typed and the client context of the request for the
 * audit entry. Never a token or link: the task creates the link.
 */
export interface PasswordResetEmailPayload {
  readonly email: string;
  readonly request_id: Id<'req'> | null;
  readonly ip: string | null;
  readonly user_agent: string | null;
}

/**
 * `notifications.cleanup` (T511): the daily cron purges expired
 * notifications and flushes buffer groups whose job was lost; the
 * 5-minute cron (T542) passes `buffers_only: true` and only does the latter.
 */
export interface NotificationsCleanupPayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
  readonly buffers_only?: boolean;
}

/** `automation.runs_cleanup` (T518, daily cron) takes no input; cron adds its own `_cron` key. */
export interface AutomationRunsCleanupPayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/** `notifications.daily_digest` (T512, hourly cron) takes no input; cron adds its own `_cron` key. */
export interface NotificationsDailyDigestPayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/** `automation.schedule_tick` (T508, every minute) takes no input; cron adds its own `_cron` key. */
export interface AutomationScheduleTickPayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/** `automation.date_scan` (T508, every minute) takes no input; cron adds its own `_cron` key. */
export interface AutomationDateScanPayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/**
 * `notifications.date_reminder_scan` (T547, every minute) takes no input;
 * cron adds its own `_cron` key.
 */
export interface NotificationsDateReminderScanPayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/**
 * `http.deliveries_rescue` (T702, every minute) takes no input; cron adds
 * its own `_cron` key.
 */
export interface HttpDeliveriesRescuePayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

/**
 * Payload of `ai.generate` (T910, ADR-39 §7): batches of the queued rows of
 * one AI field. Job key `ai.generate:<field_id>`; runs on the AI runner of
 * the worker only (`AI_CONCURRENCY`).
 */
export interface AiGeneratePayload {
  readonly organization_id: Id<'org'>;
  readonly field_id: Id<'fld'>;
}

/** `ai.generation_rescue` (T910, every minute) takes no input; cron adds its own `_cron` key. */
export interface AiGenerationRescuePayload {
  readonly _cron?: { readonly ts: string; readonly backfilled?: boolean };
}

declare global {
  // Registry of task identifiers and their payloads. `enqueue` and the
  // worker's task list are typed from it; a new task adds its entry here.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace GraphileWorker {
    interface Tasks {
      'ai.generate': AiGeneratePayload;
      'ai.generation_rescue': AiGenerationRescuePayload;
      'attachments.cleanup': AttachmentsCleanupPayload;
      'audit.export': AuditExportPayload;
      'automation.date_scan': AutomationDateScanPayload;
      'automation.revalidate_run_as': AutomationRevalidateRunAsPayload;
      'automation.run': AutomationRunPayload;
      'automation.schedule_tick': AutomationScheduleTickPayload;
      'automation.runs_cleanup': AutomationRunsCleanupPayload;
      'computed.backfill': ComputedBackfillPayload;
      'computed.recompute': ComputedRecomputePayload;
      'auth.password_reset_email': PasswordResetEmailPayload;
      'events.dispatch': EventsDispatchPayload;
      'exports.cleanup': ExportsCleanupPayload;
      'field.conversion_cleanup': FieldConversionCleanupPayload;
      'field.convert': FieldConvertPayload;
      'file.thumbnail': FileThumbnailPayload;
      'http.deliver': HttpDeliverPayload;
      'http.deliveries_rescue': HttpDeliveriesRescuePayload;
      'imports.cleanup': ImportsCleanupPayload;
      'maintenance.cleanup': MaintenanceCleanupPayload;
      'notifications.cleanup': NotificationsCleanupPayload;
      'notifications.daily_digest': NotificationsDailyDigestPayload;
      'notifications.date_reminder_scan': NotificationsDateReminderScanPayload;
      'notifications.deliver': NotificationsDeliverPayload;
      'notifications.fanout': NotificationsFanoutPayload;
      'notifications.flush': NotificationsFlushPayload;
      'notifications.telegram_poll': NotificationsTelegramPollPayload;
      'notifications.telegram_reply': NotificationsTelegramReplyPayload;
      'notifications.telegram_sparse_poll': NotificationsTelegramSparsePollPayload;
      'notifications.telegram_webhook_check': NotificationsTelegramWebhookCheckPayload;
      'partitions.maintain': PartitionsMaintainPayload;
      'records.purge': RecordsPurgePayload;
      'records.purge_org': RecordsPurgeOrgPayload;
      'schema.compact_table': SchemaCompactTablePayload;
      'schema.recompute_auto_number': SchemaRecomputeAutoNumberPayload;
      'schema.remove_select_options': SchemaRemoveSelectOptionsPayload;
      'table.import': TableImportPayload;
      'tables.purge': TablesPurgePayload;
      'tables.purge_org': TablesPurgeOrgPayload;
    }
  }
}

export type TaskName = keyof GraphileWorker.Tasks;
export type TaskPayload<T extends TaskName> = GraphileWorker.Tasks[T];
