import {
  AutomationDispatcher,
  AutomationRunEngine,
  AutomationTimeTriggers,
  createSendEmailAction,
  createSendNotificationAction,
  createSendTelegramAction,
  DateReminderScanner,
  defaultActionRegistry,
  createMailer,
  createMailService,
  createStorageDriver,
  domainOf,
  FollowedChangeGrouper,
  createHttpCallSlots,
  httpCallSlotsFor,
  HttpDeliverer,
  httpAllowlistSource,
  HttpOutbox,
  ImportsRepository,
  JOB_STATEMENT_TIMEOUT_MS,
  JobsRepository,
  createMemoryTelegramPacers,
  NotificationEmailDelivery,
  NotificationFanout,
  NotificationTelegramDelivery,
  NotificationFlusher,
  OrganizationsRepository,
  PasswordResetsRepository,
  publishComputedRecomputing,
  publishLinkTitlesChanged,
  RealtimeSchemaChangePublisher,
  RecordAssignedGrouper,
  realtimePublisherOf,
  RecordMutationService,
  RecordQueryService,
  RunAsRevalidator,
  SchemaService,
  TablesRepository,
  MemoryTelegramReplyLimiter,
  TelegramLinkPoller,
  TelegramReplySender,
  TelegramWebhookRegistrar,
  unpacedHostPacer,
  UsersRepository,
  type AppConfig,
  type Db,
  type EmailQuota,
  type HostLookup,
  type HostPacer,
  type HttpDeliverySecretSource,
  type Mailer,
  type NotificationGrouper,
  type RealtimePublisher,
  type StorageDriver,
  type TelegramClientOptions,
  type TelegramReplyLimiter,
  type TelegramSendPacers,
} from '@cellhive/server-core';

import { transcodeEmailImage } from '../thumbnails/email-image.js';

import { createAttachmentsCleanupTask } from './attachments-cleanup.js';
import { createAuditExportTask } from './audit-export.js';
import { createPasswordResetEmailTask } from './auth-password-reset-email.js';
import { createAutomationDateScanTask } from './automation-date-scan.js';
import { createAutomationRevalidateRunAsTask } from './automation-revalidate-run-as.js';
import { createAutomationRunTask } from './automation-run.js';
import { createAutomationRunsCleanupTask } from './automation-runs-cleanup.js';
import { createAutomationScheduleTickTask } from './automation-schedule-tick.js';
import { createComputedBackfillTask } from './computed-backfill.js';
import { createComputedRecomputeTask } from './computed-recompute.js';
import { createEventsDispatchTask } from './events-dispatch.js';
import { createExportsCleanupTask } from './exports-cleanup.js';
import { createFieldConversionCleanupTask } from './field-conversion-cleanup.js';
import { createFieldConvertTask } from './field-convert.js';
import { createFileThumbnailTask } from './file-thumbnail.js';
import { createHttpDeliverTask } from './http-deliver.js';
import { createHttpDeliveriesRescueTask } from './http-deliveries-rescue.js';
import { createImportsCleanupTask } from './imports-cleanup.js';
import { createMaintenanceCleanupTask } from './maintenance-cleanup.js';
import { createNotificationsCleanupTask } from './notifications-cleanup.js';
import { createNotificationsDailyDigestTask } from './notifications-daily-digest.js';
import { createNotificationsDateReminderScanTask } from './notifications-date-reminder-scan.js';
import { createNotificationsDeliverTask } from './notifications-deliver.js';
import { createNotificationsFanoutTask } from './notifications-fanout.js';
import { createNotificationsFlushTask } from './notifications-flush.js';
import { createNotificationsTelegramPollTask } from './notifications-telegram-poll.js';
import { createNotificationsTelegramReplyTask } from './notifications-telegram-reply.js';
import { createNotificationsTelegramSparsePollTask } from './notifications-telegram-sparse-poll.js';
import { createNotificationsTelegramWebhookCheckTask } from './notifications-telegram-webhook-check.js';
import { createPartitionsMaintainTask } from './partitions-maintain.js';
export {
  createRecordsPurgeOrgTask,
  createRecordsPurgeTask,
  RECORDS_PURGE_FANOUT_PAGE,
  RECORDS_PURGE_JOB_TYPE,
  RECORDS_PURGE_ORG_CAP,
  type RecordsPurgeDeps,
  type RecordsPurgeOrgDeps,
} from './records-purge.js';
import { createRecordsPurgeOrgTask, createRecordsPurgeTask } from './records-purge.js';
import { createSchemaCompactTableTask } from './schema-compact-table.js';
import { createSchemaRecomputeAutoNumberTask } from './schema-recompute-auto-number.js';
import { createSchemaRemoveSelectOptionsTask } from './schema-remove-select-options.js';
import { createTableImportTask } from './table-import.js';
import { createTablesPurgeOrgTask, createTablesPurgeTask } from './tables-purge.js';

import type { TaskList } from 'graphile-worker';
import type { Logger } from 'pino';

export interface TaskDeps {
  readonly config: AppConfig;
  readonly db: Db;
  readonly logger: Logger;
  /** Object storage for exports; default: the driver of `config` (STORAGE_DRIVER). */
  readonly storage?: StorageDriver;
  /** Outgoing email; default: SMTP of `config` (`null` when `SMTP_URL` is unset). */
  readonly mailer?: Mailer | null;
  /**
   * Notification emails (T512): counted against `EMAIL_MAX_PER_HOUR_PER_ORG`.
   * Default: the instance SMTP of `config` with `emailQuota` (`null` when
   * `SMTP_URL` is unset: pending emails are skipped, in-app is unaffected).
   */
  readonly notificationMailer?: Mailer | null;
  /** Hourly counter per organization (Valkey) for notification and automation emails. */
  readonly emailQuota?: EmailQuota | null;
  /** Hourly counter per sender identity with its own SMTP (Valkey; T530/T514). */
  readonly identityEmailQuota?: EmailQuota | null;
  /**
   * Automation emails (`send_email`, T514): instance SMTP and identity
   * SMTPs, counted against both quotas. Default: built from `config`.
   */
  readonly automationMailer?: Mailer;
  /** Wait of the `immediate` notification email batch (default 5 minutes; tests shorten it). */
  readonly notificationEmailBatchMs?: number;
  /** Realtime bus for schema changes made by jobs; default: the one attached to `db`, if any. */
  readonly realtime?: RealtimePublisher;
  /** Run engine of `automation.run` (tests pin its clock); default: built from `config`. */
  readonly automationEngine?: Pick<AutomationRunEngine, 'execute'>;
  /** Clock of `automation.schedule_tick` / `automation.date_scan` (tests pin it). */
  readonly timeTriggersNow?: () => Date;
  /** Clock of `notifications.date_reminder_scan` (T547; tests pin it). */
  readonly dateRemindersNow?: () => Date;
  /**
   * Groupers of `notifications.flush` by buffer kind (T542, ADR-34 §2);
   * default: those of the producing tasks (T544 `assigned`, T545
   * `followed`). Tests pass their own.
   */
  readonly notificationGroupers?: readonly NotificationGrouper[];
  /**
   * Tests only: a fake Telegram Bot API for `send_telegram` (T516). Never
   * configurable in production — the host is fixed to `api.telegram.org`.
   */
  readonly telegramClient?: TelegramClientOptions;
  /**
   * Telegram sending limits (T550): 25 messages per second per bot shared by
   * `send_telegram` and notification deliveries, 1 per second per chat. The
   * worker passes the Valkey pacers (shared by every process); default: the
   * pacers of this process.
   */
  readonly telegramPacers?: TelegramSendPacers;
  /**
   * "Link not valid" replies per chat (T609, QA S5b M5: 3 per hour): the
   * worker passes the Valkey limiter; default: the limiter of this process.
   */
  readonly telegramReplyLimiter?: TelegramReplyLimiter;
  /**
   * Outbound HTTP pacing (T605, ADR-35 §4): the worker passes the Valkey
   * pacer shared by every process; default (tests): no pacing.
   */
  readonly hostPacer?: HostPacer;
  /**
   * Tests only: phase 2 of the HTTP outbox — clock, jitter, DNS, secret
   * values, TLS CA of a fake destination.
   */
  readonly httpDelivery?: {
    readonly now?: () => Date;
    readonly random?: () => number;
    readonly lookup?: HostLookup;
    readonly secrets?: HttpDeliverySecretSource;
    readonly ca?: string;
  };
  /** Wait of the Telegram notification batch (default 5 seconds; tests shorten it). */
  readonly notificationTelegramBatchMs?: number;
  /** Tests only: clock of the Telegram notification delivery. */
  readonly telegramDeliveryNow?: () => Date;
  /**
   * Tests only: clock and waits of `notifications.telegram_poll` (T549) and
   * its time budget per job (default ~55 s).
   */
  readonly telegramPoll?: {
    readonly now?: () => Date;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly maxDurationMs?: number;
    readonly pollTimeoutSeconds?: number;
  };
  /** Tests only: clock of the Telegram replies and of the webhook check (T609). */
  readonly telegramNow?: () => Date;
}

/** Every task this worker runs, by identifier (`GraphileWorker.Tasks`). */
export function buildTaskList(deps: TaskDeps): TaskList {
  const realtime = deps.realtime ?? realtimePublisherOf(deps.db);
  const schema = new SchemaService(deps.db, {
    maxFieldsPerTable: deps.config.limits.maxFieldsPerTable,
    maxComputedFieldsPerBase: deps.config.limits.computedFieldsMaxPerBase,
    ...(realtime === undefined
      ? {}
      : {
          publisher: new RealtimeSchemaChangePublisher(realtime, {
            db: deps.db,
            onError: (err: unknown) => {
              deps.logger.warn({ err }, 'link title refresh publish failed');
            },
          }),
          onPublishError: (err: unknown) => {
            deps.logger.warn({ err }, 'schema change publish failed');
          },
        }),
  });
  const records = new RecordMutationService(deps.db, {
    schema,
    defaultTimeZone: deps.config.defaults.timezone,
    automationMaxRunsPerBatch: deps.config.limits.automationMaxRunsPerBatch,
  });
  const storage = deps.storage ?? createStorageDriver(deps.config);
  // Import batches of 1 000 records may run longer than a request (10 s).
  const importRecords = new RecordMutationService(deps.db, {
    schema,
    defaultTimeZone: deps.config.defaults.timezone,
    statementTimeoutMs: JOB_STATEMENT_TIMEOUT_MS,
    automationMaxRunsPerBatch: deps.config.limits.automationMaxRunsPerBatch,
  });
  const defaults = {
    timeZone: deps.config.defaults.timezone,
    locale: deps.config.defaults.locale,
  };
  const recordQuery = new RecordQueryService(deps.db, {
    defaultTimeZone: deps.config.defaults.timezone,
  });
  // One mail service per process: `SMTP_MAX_PER_SEC` and the identity transports are shared.
  const mailService =
    deps.automationMailer ??
    createMailService(deps.config, {
      orgQuota: deps.emailQuota ?? null,
      identityQuota: deps.identityEmailQuota ?? null,
    });
  // One per process: it remembers which date columns already have their scan index.
  const timeTriggers = new AutomationTimeTriggers(deps.db, {
    defaults,
    records: recordQuery,
    schema,
    maxRunsPerScan: deps.config.limits.automationMaxRunsPerBatch,
    onIndexError: (err: unknown, fieldId) => {
      deps.logger.warn({ err, field_id: fieldId }, 'automation date scan index not created');
    },
  });
  // One per process too (scan index cache), T547.
  const dateReminders = new DateReminderScanner(deps.db, {
    defaults,
    records: recordQuery,
    schema,
    onIndexError: (err: unknown, fieldId) => {
      deps.logger.warn({ err, field_id: fieldId }, 'date reminder scan index not created');
    },
  });
  const notificationFanout = new NotificationFanout(deps.db, recordQuery, {
    // No SMTP, no email queued (T512 sends the queued ones).
    emailEnabled: deps.config.mail !== null,
    ...(deps.notificationEmailBatchMs === undefined
      ? {}
      : { emailBatchMs: deps.notificationEmailBatchMs }),
    ...(deps.notificationTelegramBatchMs === undefined
      ? {}
      : { telegramBatchMs: deps.notificationTelegramBatchMs }),
    defaults,
  });
  // One per process: `send_telegram` and notification deliveries share the per-bot limit.
  const telegramPacers = deps.telegramPacers ?? createMemoryTelegramPacers();
  // Long polls and sparse polls of the notification bots (T549, T609).
  const telegramPoller = new TelegramLinkPoller(deps.db, {
    masterKey: deps.config.security.appMasterKey,
    defaults,
    ...(deps.telegramClient === undefined ? {} : { client: deps.telegramClient }),
    ...(deps.telegramPoll ?? {}),
  });
  const notificationMailer =
    deps.notificationMailer !== undefined
      ? deps.notificationMailer
      : deps.config.mail === null
        ? null
        : mailService;
  return {
    'attachments.cleanup': createAttachmentsCleanupTask({
      db: deps.db,
      storage,
      logger: deps.logger.child({ task: 'attachments.cleanup' }),
    }),
    'automation.run': createAutomationRunTask({
      engine:
        deps.automationEngine ??
        new AutomationRunEngine(deps.db, {
          defaults,
          query: recordQuery,
          actions: defaultActionRegistry({ records, query: recordQuery, schema }, [
            [
              'send_email',
              createSendEmailAction({
                db: deps.db,
                mailer: mailService,
                config: deps.config,
                storage,
                transcodeImage: transcodeEmailImage,
              }),
            ],
            [
              'send_notification',
              createSendNotificationAction({
                db: deps.db,
                query: recordQuery,
                defaults,
                // No SMTP, no email queued (T512 sends the queued ones).
                emailEnabled: deps.config.mail !== null,
                ...(deps.notificationEmailBatchMs === undefined
                  ? {}
                  : { emailBatchMs: deps.notificationEmailBatchMs }),
                ...(deps.notificationTelegramBatchMs === undefined
                  ? {}
                  : { telegramBatchMs: deps.notificationTelegramBatchMs }),
              }),
            ],
            [
              'send_telegram',
              createSendTelegramAction({
                db: deps.db,
                masterKey: deps.config.security.appMasterKey,
                pacer: telegramPacers.bot,
                ...(deps.telegramClient === undefined ? {} : { client: deps.telegramClient }),
              }),
            ],
          ]),
          maxRunningPerOrg: deps.config.limits.automationMaxRunningPerOrg,
          publicUrl: deps.config.publicUrl,
          // HTTP actions park on the outbox (T605); `http.deliver` makes the call.
          httpOutbox: new HttpOutbox(deps.db, { masterKey: deps.config.security.appMasterKey }),
        }),
      logger: deps.logger.child({ task: 'automation.run' }),
    }),
    'automation.revalidate_run_as': createAutomationRevalidateRunAsTask({
      revalidator: new RunAsRevalidator(deps.db, { defaults }),
      logger: deps.logger.child({ task: 'automation.revalidate_run_as' }),
    }),
    'automation.date_scan': createAutomationDateScanTask({
      triggers: timeTriggers,
      logger: deps.logger.child({ task: 'automation.date_scan' }),
      ...(deps.timeTriggersNow === undefined ? {} : { now: deps.timeTriggersNow }),
    }),
    'automation.schedule_tick': createAutomationScheduleTickTask({
      triggers: timeTriggers,
      logger: deps.logger.child({ task: 'automation.schedule_tick' }),
      ...(deps.timeTriggersNow === undefined ? {} : { now: deps.timeTriggersNow }),
    }),
    'automation.runs_cleanup': createAutomationRunsCleanupTask({
      db: deps.db,
      retentionDays: deps.config.limits.automationRunRetentionDays,
      logger: deps.logger.child({ task: 'automation.runs_cleanup' }),
    }),
    'audit.export': createAuditExportTask({
      db: deps.db,
      jobs: new JobsRepository(deps.db),
      storage,
      logger: deps.logger.child({ task: 'audit.export' }),
    }),
    'auth.password_reset_email': createPasswordResetEmailTask({
      db: deps.db,
      users: new UsersRepository(deps.db),
      organizations: new OrganizationsRepository(deps.db),
      passwordResets: new PasswordResetsRepository(deps.db),
      mailer: deps.mailer === undefined ? createMailer(deps.config) : deps.mailer,
      publicUrl: deps.config.publicUrl,
      logger: deps.logger.child({ task: 'auth.password_reset_email' }),
    }),
    'computed.backfill': createComputedBackfillTask({
      db: deps.db,
      schema,
      records,
      jobs: new JobsRepository(deps.db),
      logger: deps.logger.child({ task: 'computed.backfill' }),
      onProgress: (progress) => publishComputedRecomputing(deps.db, undefined, progress),
    }),
    'computed.recompute': createComputedRecomputeTask({
      schema,
      records,
      logger: deps.logger.child({ task: 'computed.recompute' }),
      onProgress: (progress) => publishComputedRecomputing(deps.db, undefined, progress),
    }),
    'events.dispatch': createEventsDispatchTask({
      dispatcher: new AutomationDispatcher(deps.db, {
        maxRunsPerBatch: deps.config.limits.automationMaxRunsPerBatch,
        defaults: {
          timeZone: deps.config.defaults.timezone,
          locale: deps.config.defaults.locale,
        },
        records: new RecordQueryService(deps.db, {
          defaultTimeZone: deps.config.defaults.timezone,
        }),
      }),
      logger: deps.logger.child({ task: 'events.dispatch' }),
    }),
    'exports.cleanup': createExportsCleanupTask({
      db: deps.db,
      jobs: new JobsRepository(deps.db),
      storage,
      logger: deps.logger.child({ task: 'exports.cleanup' }),
    }),
    'field.convert': createFieldConvertTask({
      db: deps.db,
      schema,
      records,
      jobs: new JobsRepository(deps.db),
      logger: deps.logger.child({ task: 'field.convert' }),
    }),
    'field.conversion_cleanup': createFieldConversionCleanupTask({
      db: deps.db,
      schema,
      logger: deps.logger.child({ task: 'field.conversion_cleanup' }),
    }),
    'file.thumbnail': createFileThumbnailTask({
      db: deps.db,
      storage,
      logger: deps.logger.child({ task: 'file.thumbnail' }),
    }),
    'http.deliver': createHttpDeliverTask({
      deliverer: new HttpDeliverer(deps.db, {
        masterKey: deps.config.security.appMasterKey,
        publicUrl: deps.config.publicUrl,
        pacer: deps.hostPacer ?? unpacedHostPacer,
        // QA S5c (T616): HTTP calls never take every job slot of this process.
        callSlots: createHttpCallSlots(httpCallSlotsFor(deps.config.limits.workerConcurrency)),
        allowlist: httpAllowlistSource(deps.db),
        privateAllowlist: deps.config.outboundHttp.privateAllowlist,
        ...(deps.httpDelivery?.now === undefined ? {} : { now: deps.httpDelivery.now }),
        ...(deps.httpDelivery?.random === undefined ? {} : { random: deps.httpDelivery.random }),
        ...(deps.httpDelivery?.lookup === undefined ? {} : { lookup: deps.httpDelivery.lookup }),
        ...(deps.httpDelivery?.secrets === undefined ? {} : { secrets: deps.httpDelivery.secrets }),
        ...(deps.httpDelivery?.ca === undefined ? {} : { request: { ca: deps.httpDelivery.ca } }),
      }),
      logger: deps.logger.child({ task: 'http.deliver' }),
    }),
    'http.deliveries_rescue': createHttpDeliveriesRescueTask({
      db: deps.db,
      logger: deps.logger.child({ task: 'http.deliveries_rescue' }),
    }),
    'imports.cleanup': createImportsCleanupTask({
      db: deps.db,
      imports: new ImportsRepository(deps.db),
      storage,
      logger: deps.logger.child({ task: 'imports.cleanup' }),
    }),
    'maintenance.cleanup': createMaintenanceCleanupTask({
      db: deps.db,
      logger: deps.logger.child({ task: 'maintenance.cleanup' }),
    }),
    'notifications.cleanup': createNotificationsCleanupTask({
      db: deps.db,
      retentionDays: deps.config.limits.notificationRetentionDays,
      logger: deps.logger.child({ task: 'notifications.cleanup' }),
    }),
    'notifications.daily_digest': createNotificationsDailyDigestTask({
      db: deps.db,
      defaults,
      logger: deps.logger.child({ task: 'notifications.daily_digest' }),
    }),
    'notifications.date_reminder_scan': createNotificationsDateReminderScanTask({
      scanner: dateReminders,
      logger: deps.logger.child({ task: 'notifications.date_reminder_scan' }),
      ...(deps.dateRemindersNow === undefined ? {} : { now: deps.dateRemindersNow }),
    }),
    'notifications.deliver': createNotificationsDeliverTask({
      delivery: new NotificationEmailDelivery(deps.db, recordQuery, notificationMailer, {
        publicUrl: deps.config.publicUrl,
        messageIdDomain: deps.config.mail === null ? null : domainOf(deps.config.mail.fromAddress),
        maxHtmlBytes: deps.config.email.maxHtmlBytes,
        defaults,
      }),
      telegram: new NotificationTelegramDelivery(deps.db, recordQuery, {
        publicUrl: deps.config.publicUrl,
        defaults,
        masterKey: deps.config.security.appMasterKey,
        pacers: telegramPacers,
        ...(deps.telegramClient === undefined ? {} : { client: deps.telegramClient }),
        ...(deps.telegramDeliveryNow === undefined ? {} : { now: deps.telegramDeliveryNow }),
      }),
      logger: deps.logger.child({ task: 'notifications.deliver' }),
    }),
    'notifications.fanout': createNotificationsFanoutTask({
      fanout: notificationFanout,
      logger: deps.logger.child({ task: 'notifications.fanout' }),
    }),
    'notifications.flush': createNotificationsFlushTask({
      flusher: new NotificationFlusher(
        deps.db,
        notificationFanout,
        deps.notificationGroupers ?? [
          // T544: `record.assigned`.
          new RecordAssignedGrouper(deps.db),
          // T545: `record.followed_changed`.
          new FollowedChangeGrouper(deps.db),
        ],
      ),
      logger: deps.logger.child({ task: 'notifications.flush' }),
    }),
    'notifications.telegram_poll': createNotificationsTelegramPollTask({
      db: deps.db,
      poller: telegramPoller,
      logger: deps.logger.child({ task: 'notifications.telegram_poll' }),
      ...(deps.telegramPoll?.now === undefined ? {} : { now: deps.telegramPoll.now }),
    }),
    'notifications.telegram_reply': createNotificationsTelegramReplyTask({
      sender: new TelegramReplySender(deps.db, {
        masterKey: deps.config.security.appMasterKey,
        pacers: telegramPacers,
        limiter: deps.telegramReplyLimiter ?? new MemoryTelegramReplyLimiter(),
        ...(deps.telegramClient === undefined ? {} : { client: deps.telegramClient }),
        ...(deps.telegramNow === undefined ? {} : { now: deps.telegramNow }),
      }),
      logger: deps.logger.child({ task: 'notifications.telegram_reply' }),
    }),
    'notifications.telegram_sparse_poll': createNotificationsTelegramSparsePollTask({
      db: deps.db,
      poller: telegramPoller,
      logger: deps.logger.child({ task: 'notifications.telegram_sparse_poll' }),
      ...(deps.telegramPoll?.now === undefined ? {} : { now: deps.telegramPoll.now }),
    }),
    'notifications.telegram_webhook_check': createNotificationsTelegramWebhookCheckTask({
      db: deps.db,
      registrar: new TelegramWebhookRegistrar(deps.db, {
        masterKey: deps.config.security.appMasterKey,
        publicUrl: deps.config.publicUrl,
        ...(deps.telegramClient === undefined ? {} : { client: deps.telegramClient }),
        ...(deps.telegramNow === undefined ? {} : { now: deps.telegramNow }),
      }),
      logger: deps.logger.child({ task: 'notifications.telegram_webhook_check' }),
    }),
    'partitions.maintain': createPartitionsMaintainTask({
      db: deps.db,
      logger: deps.logger.child({ task: 'partitions.maintain' }),
      auditRetentionDays: deps.config.limits.auditRetentionDays,
    }),
    'records.purge': createRecordsPurgeTask({
      db: deps.db,
      jobs: new JobsRepository(deps.db),
      logger: deps.logger.child({ task: 'records.purge' }),
    }),
    'records.purge_org': createRecordsPurgeOrgTask({
      db: deps.db,
      records,
      tables: new TablesRepository(deps.db),
      jobs: new JobsRepository(deps.db),
      logger: deps.logger.child({ task: 'records.purge_org' }),
    }),
    'schema.compact_table': createSchemaCompactTableTask({
      schema,
      logger: deps.logger.child({ task: 'schema.compact_table' }),
    }),
    'schema.recompute_auto_number': createSchemaRecomputeAutoNumberTask({
      records,
      logger: deps.logger.child({ task: 'schema.recompute_auto_number' }),
      onRenumbered: (orgId, tableId, fieldId) =>
        publishLinkTitlesChanged(deps.db, orgId, tableId, fieldId, (err: unknown) => {
          deps.logger.warn({ err }, 'link title refresh publish failed');
        }),
    }),
    'schema.remove_select_options': createSchemaRemoveSelectOptionsTask({
      records,
      jobs: new JobsRepository(deps.db),
      logger: deps.logger.child({ task: 'schema.remove_select_options' }),
    }),
    'table.import': createTableImportTask({
      db: deps.db,
      schema,
      records: importRecords,
      jobs: new JobsRepository(deps.db),
      imports: new ImportsRepository(deps.db),
      storage,
      defaults: { timeZone: deps.config.defaults.timezone, locale: deps.config.defaults.locale },
      maxFieldsPerTable: deps.config.limits.maxFieldsPerTable,
      logger: deps.logger.child({ task: 'table.import' }),
    }),
    'tables.purge': createTablesPurgeTask({
      db: deps.db,
      jobs: new JobsRepository(deps.db),
      logger: deps.logger.child({ task: 'tables.purge' }),
    }),
    'tables.purge_org': createTablesPurgeOrgTask({
      db: deps.db,
      schema,
      tables: new TablesRepository(deps.db),
      jobs: new JobsRepository(deps.db),
      logger: deps.logger.child({ task: 'tables.purge_org' }),
    }),
  };
}

export { createAutomationDateScanTask } from './automation-date-scan.js';
export {
  createAutomationRevalidateRunAsTask,
  type AutomationRevalidateRunAsDeps,
} from './automation-revalidate-run-as.js';
export { createAutomationRunTask, type AutomationRunDeps } from './automation-run.js';
export {
  createAutomationScheduleTickTask,
  logTimeTick,
  type AutomationTimeTaskDeps,
} from './automation-schedule-tick.js';
export {
  createAutomationRunsCleanupTask,
  type AutomationRunsCleanupDeps,
} from './automation-runs-cleanup.js';
export {
  ATTACHMENT_CLEANUP_BATCH,
  createAttachmentsCleanupTask,
  type AttachmentsCleanupDeps,
} from './attachments-cleanup.js';
export {
  AUDIT_EXPORT_ORG_CAP,
  createAuditExportTask,
  type AuditExportDeps,
} from './audit-export.js';
export {
  createPasswordResetEmailTask,
  type PasswordResetEmailDeps,
} from './auth-password-reset-email.js';
export {
  COMPUTED_ANALYZE_THRESHOLD,
  COMPUTED_BACKFILL_BATCH_ATTEMPTS,
  COMPUTED_BACKFILL_ORG_CAP,
  COMPUTED_BACKFILL_STATEMENT_TIMEOUT_MS,
  createComputedBackfillTask,
  type ComputedBackfillDeps,
  type ComputedBackfillProgress,
} from './computed-backfill.js';
export {
  COMPUTED_RECOMPUTE_ANALYZE_THRESHOLD,
  COMPUTED_RECOMPUTE_BATCH_ATTEMPTS,
  COMPUTED_RECOMPUTE_STATEMENT_TIMEOUT_MS,
  createComputedRecomputeTask,
  type ComputedRecomputeDeps,
  type ComputedRecomputeProgress,
} from './computed-recompute.js';
export { createEventsDispatchTask, type EventsDispatchDeps } from './events-dispatch.js';
export {
  createExportsCleanupTask,
  EXPORT_CLEANUP_BATCH,
  type ExportsCleanupDeps,
} from './exports-cleanup.js';
export {
  createFieldConversionCleanupTask,
  FIELD_CONVERSION_CLEANUP_BATCH,
  type FieldConversionCleanupDeps,
} from './field-conversion-cleanup.js';
export {
  createFieldConvertTask,
  FIELD_CONVERT_BATCH_ATTEMPTS,
  FIELD_CONVERT_ORG_CAP,
  type FieldConvertDeps,
} from './field-convert.js';
export {
  createFileThumbnailTask,
  FILE_THUMBNAIL_ORG_CAP,
  FILE_THUMBNAIL_SLOT_KIND,
  FILE_THUMBNAIL_STALE_MS,
  type FileThumbnailDeps,
} from './file-thumbnail.js';
export { createHttpDeliverTask, type HttpDeliverDeps } from './http-deliver.js';
export {
  createHttpDeliveriesRescueTask,
  HTTP_DELIVERIES_RESCUE_LIMIT,
  type HttpDeliveriesRescueDeps,
} from './http-deliveries-rescue.js';
export {
  createImportsCleanupTask,
  IMPORT_CLEANUP_BATCH,
  type ImportsCleanupDeps,
} from './imports-cleanup.js';
export {
  createTablesPurgeOrgTask,
  createTablesPurgeTask,
  TABLES_PURGE_FANOUT_PAGE,
  TABLES_PURGE_JOB_TYPE,
  TABLES_PURGE_ORG_CAP,
  TABLES_PURGE_PER_RUN,
  tableTrashCutoff,
  type TablesPurgeDeps,
  type TablesPurgeOrgDeps,
} from './tables-purge.js';
export {
  createTableImportTask,
  TABLE_IMPORT_ORG_CAP,
  type TableImportTaskDeps,
} from './table-import.js';
export {
  createMaintenanceCleanupTask,
  type MaintenanceCleanupDeps,
} from './maintenance-cleanup.js';
export {
  createNotificationsCleanupTask,
  NOTIFICATION_BUFFER_SWEEP_PAGE,
  type NotificationsCleanupDeps,
} from './notifications-cleanup.js';
export {
  createNotificationsDailyDigestTask,
  type NotificationsDailyDigestDeps,
} from './notifications-daily-digest.js';
export {
  createNotificationsDateReminderScanTask,
  logDateReminderTick,
  type NotificationsDateReminderScanDeps,
} from './notifications-date-reminder-scan.js';
export {
  createNotificationsDeliverTask,
  type NotificationsDeliverDeps,
} from './notifications-deliver.js';
export {
  createNotificationsFanoutTask,
  type NotificationsFanoutDeps,
} from './notifications-fanout.js';
export {
  createNotificationsFlushTask,
  type NotificationsFlushDeps,
} from './notifications-flush.js';
export {
  createNotificationsTelegramPollTask,
  TELEGRAM_POLL_BUSY_RETRY_MS,
  TELEGRAM_POLL_SWEEP_PAGE,
  type NotificationsTelegramPollDeps,
} from './notifications-telegram-poll.js';
export {
  createPartitionsMaintainTask,
  EVENT_RETENTION_DAYS,
  maintainPartitions,
  PARTITION_MONTHS_AHEAD,
  type PartitionMaintenanceOptions,
  type PartitionMaintenanceResult,
  type PartitionsMaintainDeps,
} from './partitions-maintain.js';
export {
  createSchemaCompactTableTask,
  type SchemaCompactTableDeps,
} from './schema-compact-table.js';
export {
  createSchemaRecomputeAutoNumberTask,
  type SchemaRecomputeAutoNumberDeps,
} from './schema-recompute-auto-number.js';
export {
  createSchemaRemoveSelectOptionsTask,
  type SchemaRemoveSelectOptionsDeps,
} from './schema-remove-select-options.js';
