import {
  assertSupportedPostgres,
  createDb,
  createValkeyEmailQuota,
  createValkeyHostPacer,
  createValkeyTelegramPacers,
  createValkeyTelegramReplyLimiter,
  valkeyQuotaClient,
  JOB_STATEMENT_TIMEOUT_MS,
  type AppConfig,
  type Db,
  type RealtimePublisher,
} from '@cellhive/server-core';
import {
  Global,
  Inject,
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { CRON_ITEMS, startJobRunner } from './job-runner.js';
import {
  closeWorkerCacheClient,
  createWorkerCacheClient,
  createWorkerRealtimeBus,
} from './realtime.js';
import { buildTaskList } from './tasks/index.js';
import {
  APP_CONFIG,
  CACHE_CLIENT,
  DB,
  REALTIME_BUS,
  ROOT_LOGGER,
  WORKER_OPTIONS,
} from './tokens.js';

import type { Runner, TaskList } from 'graphile-worker';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export interface WorkerRuntimeOptions {
  /** Called when the job runner stops on an unrecoverable error. */
  readonly onFatal?: (error: unknown) => void;
  /** Replaces the task list (tests). */
  readonly taskList?: TaskList;
  readonly pollIntervalMs?: number;
}

export interface WorkerModuleOptions extends WorkerRuntimeOptions {
  readonly config: AppConfig;
  readonly rootLogger: Logger;
}

/** Prefix of Valkey keys, shared with the api (its `CACHE_KEY_PREFIX`): one quota counter. */
export const WORKER_CACHE_KEY_PREFIX = 'ob:';

/** Key of the `partitions.maintain` job added at start (deduplicated across workers). */
export const STARTUP_MAINTENANCE_JOB_KEY = 'partitions.maintain:startup';

/**
 * Owns the graphile-worker runner: starts it once the context is built (after
 * checking the PostgreSQL version, ADR-19) and stops it gracefully before the
 * pool is closed. Running jobs finish; new ones are not picked up.
 */
@Injectable()
export class JobRunnerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  #runner: Runner | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    @Inject(DB) private readonly db: Db,
    @Inject(WORKER_OPTIONS) private readonly options: WorkerRuntimeOptions,
    // Attached to `db` before any task runs.
    @Inject(REALTIME_BUS) private readonly realtime: RealtimePublisher,
    @Inject(CACHE_CLIENT) private readonly cache: Redis,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const version = await assertSupportedPostgres(this.db.kysely);
    this.logger.info({ postgres: version.version }, 'database version supported');
    const concurrency = this.config.limits.workerConcurrency;
    const runner = await startJobRunner({
      connectionString: this.config.database.url,
      concurrency,
      taskList:
        this.options.taskList ??
        buildTaskList({
          config: this.config,
          db: this.db,
          logger: this.logger,
          realtime: this.realtime,
          // Notification and automation emails count against EMAIL_MAX_PER_HOUR_PER_ORG (T512, T514).
          emailQuota: createValkeyEmailQuota(valkeyQuotaClient(this.cache), {
            limit: this.config.email.maxPerHourPerOrg,
            scope: 'org',
            keyPrefix: WORKER_CACHE_KEY_PREFIX,
          }),
          // Automation emails through a sender identity's own SMTP (T514).
          identityEmailQuota: createValkeyEmailQuota(valkeyQuotaClient(this.cache), {
            limit: this.config.email.maxPerHourPerIdentity,
            scope: 'identity',
            keyPrefix: WORKER_CACHE_KEY_PREFIX,
          }),
          // Telegram: 25 messages/s per bot shared by `send_telegram` and notifications
          // across every worker process, 1/s per chat (T550).
          telegramPacers: createValkeyTelegramPacers(valkeyQuotaClient(this.cache), {
            keyPrefix: WORKER_CACHE_KEY_PREFIX,
          }),
          // "Link not valid" replies: 3 per chat per hour across every worker (T609).
          telegramReplyLimiter: createValkeyTelegramReplyLimiter(valkeyQuotaClient(this.cache), {
            keyPrefix: WORKER_CACHE_KEY_PREFIX,
          }),
          // Outbound HTTP (T605, ADR-35 §4): per (org, host) bucket, `Retry-After` pauses and
          // 2 calls in flight per organization, shared by every worker process.
          hostPacer: createValkeyHostPacer(valkeyQuotaClient(this.cache), {
            keyPrefix: WORKER_CACHE_KEY_PREFIX,
          }),
        }),
      logger: this.logger,
      cron: CRON_ITEMS,
      ...(this.options.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: this.options.pollIntervalMs }),
    });
    this.#runner = runner;
    runner.promise.catch((err: unknown) => {
      this.logger.fatal({ err }, 'job runner stopped on an error');
      this.options.onFatal?.(err);
    });
    // Partitions for the coming months even if the daily run was missed.
    if (this.options.taskList === undefined) {
      await runner.addJob('partitions.maintain', {}, { jobKey: STARTUP_MAINTENANCE_JOB_KEY });
    }
    this.logger.info({ concurrency }, 'worker started');
  }

  async beforeApplicationShutdown(): Promise<void> {
    const runner = this.#runner;
    this.#runner = undefined;
    if (runner === undefined) return;
    this.logger.info('stopping job runner');
    await runner.stop('shutdown');
    this.logger.info('job runner stopped');
  }
}

/** Closes the pool and the Valkey connection after the runner stopped. */
@Injectable()
class ConnectionCloser implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CACHE_CLIENT) private readonly cache: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.db.destroy(), closeWorkerCacheClient(this.cache)]);
  }
}

/** NestJS application context of the worker (SPEC §3: "NestJS standalone app"). */
@Global()
@Module({})
export class WorkerModule {
  static register(options: WorkerModuleOptions): DynamicModule {
    const { config, rootLogger, ...runtime } = options;
    return {
      module: WorkerModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: ROOT_LOGGER, useValue: rootLogger },
        { provide: WORKER_OPTIONS, useValue: runtime },
        {
          provide: DB,
          useFactory: (): Db =>
            createDb({
              url: config.database.url,
              poolMax: config.database.poolMax,
              applicationName: 'cellhive-worker',
              statementTimeoutMs: JOB_STATEMENT_TIMEOUT_MS,
              onIdleError: (err) => {
                rootLogger.warn({ err, dependency: 'database' }, 'idle database client failed');
              },
            }),
        },
        {
          provide: CACHE_CLIENT,
          useFactory: (): Redis => createWorkerCacheClient(config, rootLogger),
        },
        {
          provide: REALTIME_BUS,
          inject: [DB, CACHE_CLIENT],
          useFactory: (db: Db, cache: Redis): RealtimePublisher =>
            createWorkerRealtimeBus(db, cache, rootLogger),
        },
        ConnectionCloser,
        JobRunnerService,
      ],
      exports: [APP_CONFIG, ROOT_LOGGER, DB, REALTIME_BUS],
    };
  }
}
