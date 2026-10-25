import { EventEmitter } from 'node:events';

import { createQueueLogger, JOB_QUEUE_SCHEMA } from '@cellhive/server-core';
import {
  parseCronItems,
  run,
  type CronItem,
  type Runner,
  type TaskList,
  type WorkerEvents,
} from 'graphile-worker';

import { createWorkerId, unlockDeadWorkersOfHost, workerHost } from './worker-identity.js';
import { WorkerLivenessLock, WorkerLivenessTakenError } from './worker-liveness.js';

import type { Logger } from 'pino';

/** Daily at 00:15 UTC. */
export const PARTITIONS_MAINTAIN_CRON = '15 0 * * *';

/** Hourly at minute 25. */
export const MAINTENANCE_CLEANUP_CRON = '25 * * * *';

/** Hourly at minute 35 (export links live one hour). */
export const EXPORTS_CLEANUP_CRON = '35 * * * *';

/** Hourly at minute 45 (import uploads live 24 hours). */
export const IMPORTS_CLEANUP_CRON = '45 * * * *';

/** Hourly at minute 5 (old columns of type conversions live 7 days, T403). */
export const FIELD_CONVERSION_CLEANUP_CRON = '5 * * * *';
/** Hourly at minute 55 (unattached uploads live 24 hours, detached files 30 days). */
export const ATTACHMENTS_CLEANUP_CRON = '55 * * * *';

/** Daily at 01:45 UTC (records trashed more than 30 days ago, T408). */
export const RECORDS_PURGE_CRON = '45 1 * * *';

/**
 * Daily at 01:15 UTC (tables trashed more than 30 days ago, T461), before
 * `records.purge`, which then no longer visits them.
 */
export const TABLES_PURGE_CRON = '15 1 * * *';

/** Daily at 02:30 UTC (notifications older than NOTIFICATION_RETENTION_DAYS, T511). */
export const NOTIFICATIONS_CLEANUP_CRON = '30 2 * * *';

/**
 * Every 5 minutes: flush the notification buffer groups whose job was lost
 * (rows older than 10 minutes, T542; the daily run above does it too).
 */
export const NOTIFICATION_BUFFERS_SWEEP_CRON = '*/5 * * * *';

/** Daily at 02:45 UTC (automation runs older than AUTOMATION_RUN_RETENTION_DAYS, T518). */
export const AUTOMATION_RUNS_CLEANUP_CRON = '45 2 * * *';

/**
 * Hourly at minute 0: daily notification summaries due at this whole hour
 * of each recipient's time zone (T512, "Quyết định S5 thiết kế" #7).
 */
export const NOTIFICATIONS_DAILY_DIGEST_CRON = '0 * * * *';

/**
 * Every minute: `schedule` automations due since the last tick, and
 * `record.date_reached` records whose date passed (T508, SPEC §11.2).
 */
export const AUTOMATION_SCHEDULE_TICK_CRON = '* * * * *';
export const AUTOMATION_DATE_SCAN_CRON = '* * * * *';

/**
 * Every minute: poll the notification bots that have pending personal links
 * (`/start <token>`, T549, ADR-34 §3); a link also queues its poll at once.
 */
export const NOTIFICATIONS_TELEGRAM_POLL_CRON = '* * * * *';

/**
 * Every 15 minutes: one non-waiting `getUpdates` per notification bot in
 * `polling` mode with linked channels, so `/stop` is handled within 15
 * minutes even when no link waits (T609, QA S5b M4).
 */
export const NOTIFICATIONS_TELEGRAM_SPARSE_POLL_CRON = '*/15 * * * *';

/**
 * Hourly at minute 20: `getWebhookInfo` for every notification bot in
 * `webhook` mode — re-register after a `PUBLIC_URL` change, show delivery
 * errors (T609, ADR-35 §7).
 */
export const NOTIFICATIONS_TELEGRAM_WEBHOOK_CHECK_CRON = '20 * * * *';

/**
 * Every minute: date reminders whose moment passed since the last scan
 * (T547, ADR-34 §1); each field keeps a cursor, so a missed minute is caught
 * up by the next scan.
 */
export const NOTIFICATIONS_DATE_REMINDER_SCAN_CRON = '* * * * *';

/**
 * Every minute: queue `http.deliver` again for deliveries whose job was lost
 * (T702, ADR-36 §5); a missed minute is caught up by the next run.
 */
export const HTTP_DELIVERIES_RESCUE_CRON = '* * * * *';

/** Recurring jobs of the worker. */
export const CRON_ITEMS: readonly CronItem[] = [
  {
    task: 'partitions.maintain',
    match: PARTITIONS_MAINTAIN_CRON,
    identifier: 'partitions.maintain',
    options: { backfillPeriod: 0, maxAttempts: 5 },
  },
  {
    task: 'maintenance.cleanup',
    match: MAINTENANCE_CLEANUP_CRON,
    identifier: 'maintenance.cleanup',
    options: { backfillPeriod: 0, maxAttempts: 3 },
  },
  {
    task: 'exports.cleanup',
    match: EXPORTS_CLEANUP_CRON,
    identifier: 'exports.cleanup',
    options: { backfillPeriod: 0, maxAttempts: 3 },
  },
  {
    task: 'imports.cleanup',
    match: IMPORTS_CLEANUP_CRON,
    identifier: 'imports.cleanup',
    options: { backfillPeriod: 0, maxAttempts: 3 },
  },
  {
    task: 'field.conversion_cleanup',
    match: FIELD_CONVERSION_CLEANUP_CRON,
    identifier: 'field.conversion_cleanup',
    options: { backfillPeriod: 0, maxAttempts: 3 },
  },
  {
    task: 'tables.purge',
    match: TABLES_PURGE_CRON,
    identifier: 'tables.purge',
    options: { backfillPeriod: 0, maxAttempts: 3 },
  },
  {
    task: 'records.purge',
    match: RECORDS_PURGE_CRON,
    identifier: 'records.purge',
    options: { backfillPeriod: 0, maxAttempts: 3 },
  },
  {
    task: 'notifications.cleanup',
    match: NOTIFICATIONS_CLEANUP_CRON,
    identifier: 'notifications.cleanup',
    options: { backfillPeriod: 0, maxAttempts: 3 },
  },
  {
    task: 'notifications.cleanup',
    match: NOTIFICATION_BUFFERS_SWEEP_CRON,
    identifier: 'notifications.cleanup.buffers',
    payload: { buffers_only: true },
    options: { backfillPeriod: 0, maxAttempts: 3 },
  },
  {
    task: 'notifications.daily_digest',
    match: NOTIFICATIONS_DAILY_DIGEST_CRON,
    identifier: 'notifications.daily_digest',
    options: { backfillPeriod: 0, maxAttempts: 3 },
  },
  {
    task: 'automation.schedule_tick',
    match: AUTOMATION_SCHEDULE_TICK_CRON,
    identifier: 'automation.schedule_tick',
    // Each automation keeps a cursor: a missed minute is caught up by the next tick.
    options: { backfillPeriod: 0, maxAttempts: 1 },
  },
  {
    task: 'automation.date_scan',
    match: AUTOMATION_DATE_SCAN_CRON,
    identifier: 'automation.date_scan',
    options: { backfillPeriod: 0, maxAttempts: 1 },
  },
  {
    task: 'notifications.date_reminder_scan',
    match: NOTIFICATIONS_DATE_REMINDER_SCAN_CRON,
    identifier: 'notifications.date_reminder_scan',
    options: { backfillPeriod: 0, maxAttempts: 1 },
  },
  {
    task: 'notifications.telegram_poll',
    match: NOTIFICATIONS_TELEGRAM_POLL_CRON,
    identifier: 'notifications.telegram_poll',
    // Pending links are found again by the next minute's run.
    options: { backfillPeriod: 0, maxAttempts: 1 },
  },
  {
    task: 'notifications.telegram_sparse_poll',
    match: NOTIFICATIONS_TELEGRAM_SPARSE_POLL_CRON,
    identifier: 'notifications.telegram_sparse_poll',
    options: { backfillPeriod: 0, maxAttempts: 1 },
  },
  {
    task: 'notifications.telegram_webhook_check',
    match: NOTIFICATIONS_TELEGRAM_WEBHOOK_CHECK_CRON,
    identifier: 'notifications.telegram_webhook_check',
    options: { backfillPeriod: 0, maxAttempts: 1 },
  },
  {
    task: 'automation.runs_cleanup',
    match: AUTOMATION_RUNS_CLEANUP_CRON,
    identifier: 'automation.runs_cleanup',
    options: { backfillPeriod: 0, maxAttempts: 3 },
  },
  {
    task: 'attachments.cleanup',
    match: ATTACHMENTS_CLEANUP_CRON,
    identifier: 'attachments.cleanup',
    options: { backfillPeriod: 0, maxAttempts: 3 },
  },
  {
    task: 'http.deliveries_rescue',
    match: HTTP_DELIVERIES_RESCUE_CRON,
    identifier: 'http.deliveries_rescue',
    options: { backfillPeriod: 0, maxAttempts: 1 },
  },
];

export interface JobRunnerOptions {
  readonly connectionString: string;
  /** Jobs run at once by this process (`WORKER_CONCURRENCY`). */
  readonly concurrency: number;
  readonly taskList: TaskList;
  readonly logger: Logger;
  readonly cron?: readonly CronItem[];
  /** Fallback polling for jobs scheduled in the future; new jobs arrive by LISTEN/NOTIFY. */
  readonly pollIntervalMs?: number;
  /** Time given to running jobs on shutdown before they are asked to abort. */
  readonly gracefulShutdownAbortTimeoutMs?: number;
  /** Host part of the worker id (T702); default: the machine's hostname. Tests set it. */
  readonly hostname?: string;
  /** Pid part of the worker id (T702); default `process.pid`. Tests set it. */
  readonly pid?: number;
}

/** New worker ids tried when the liveness key of one is already held (a hash collision). */
const WORKER_ID_ATTEMPTS = 5;

/**
 * Starts graphile-worker: migrates its schema if needed, then runs `taskList`
 * with `concurrency` jobs at once and the cron items. No named queue per
 * organization (ADR-18). Signals are handled by the process (`main.ts`),
 * which stops the runner gracefully.
 *
 * Worker identity (T702, ADR-36 §5): every job this process takes is locked
 * as `ob-<host>-<pid>-<8 base62>`, and the process holds the liveness
 * advisory lock of that id (`WorkerLivenessLock`) until the runner stops.
 * Before taking any job, the jobs still locked by another id of the same
 * host whose liveness lock is free (its process died) are unlocked
 * (`unlockDeadWorkersOfHost`); a live process keeps its locks, whatever PID
 * namespace it runs in. graphile-worker locks
 * with the id of its worker pool (its `workerId` option names one worker
 * and is refused with `concurrency > 1`), so the pool takes our id when it
 * is created, before its workers start.
 */
export async function startJobRunner(options: JobRunnerOptions): Promise<Runner> {
  const host = workerHost(options.hostname);
  const { workerId, liveness } = await acquireWorkerIdentity(options, host);
  try {
    await unlockDeadWorkersOfHost({
      connectionString: options.connectionString,
      workerId,
      host,
      logger: options.logger,
    });
    const runner = await runQueue(options, workerId);
    const stop = runner.stop.bind(runner);
    runner.stop = async (...args: Parameters<Runner['stop']>) => {
      try {
        await stop(...args);
      } finally {
        await liveness.close();
      }
    };
    const release = () => liveness.close();
    runner.promise.then(release, release);
    return runner;
  } catch (err) {
    await liveness.close();
    throw err;
  }
}

async function acquireWorkerIdentity(
  options: JobRunnerOptions,
  host: string,
): Promise<{ workerId: string; liveness: WorkerLivenessLock }> {
  for (let attempt = 1; ; attempt += 1) {
    const workerId = createWorkerId(host, options.pid === undefined ? {} : { pid: options.pid });
    try {
      const liveness = await WorkerLivenessLock.acquire({
        connectionString: options.connectionString,
        workerId,
        logger: options.logger,
      });
      return { workerId, liveness };
    } catch (err) {
      if (!(err instanceof WorkerLivenessTakenError) || attempt >= WORKER_ID_ATTEMPTS) throw err;
    }
  }
}

function runQueue(options: JobRunnerOptions, workerId: string): Promise<Runner> {
  const events: WorkerEvents = new EventEmitter();
  events.on('pool:create', ({ workerPool }) => {
    workerPool.id = workerId;
  });
  options.logger.info({ worker_id: workerId }, 'job runner starting');
  return run({
    events,
    connectionString: options.connectionString,
    schema: JOB_QUEUE_SCHEMA,
    concurrency: options.concurrency,
    // Dequeue, completion and failure queries need their own connections.
    maxPoolSize: options.concurrency + 2,
    pollInterval: options.pollIntervalMs ?? 2_000,
    gracefulShutdownAbortTimeout: options.gracefulShutdownAbortTimeoutMs ?? 5_000,
    noHandleSignals: true,
    logger: createQueueLogger(options.logger.child({ component: 'job-queue' })),
    taskList: options.taskList,
    parsedCronItems: parseCronItems([...(options.cron ?? [])]),
    preset: {
      worker: {
        // Without batching, graphile-worker marks a job complete/failed
        // without awaiting it, so a graceful stop can close the pool first
        // and leave a finished job locked (re-run only after the 4 h lock
        // timeout). The batchers (delay 0: no extra latency) are drained on
        // shutdown before the pool is released.
        completeJobBatchDelay: 0,
        failJobBatchDelay: 0,
      },
    },
  });
}
