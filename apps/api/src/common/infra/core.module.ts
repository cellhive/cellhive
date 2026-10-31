import {
  createMailService,
  createStorageDriver,
  createValkeyEmailQuota,
  TelegramBotApi,
  valkeyQuotaClient,
  type AppConfig,
  type EmailQuota,
  type HostLookup,
  type Mailer,
  type StorageDriver,
  type TelegramClientOptions,
} from '@cellhive/server-core';
import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { AppLogger } from '../logging/app-logger.js';
import { CACHE_KEY_PREFIX } from '../rate-limit/rate-limiter.js';
import {
  APP_CONFIG,
  CACHE_CLIENT,
  EMAIL_QUOTA,
  MAIL_SERVICE,
  MAILER,
  OUTBOUND_LOOKUP,
  ROOT_LOGGER,
  STORAGE_DRIVER,
  TELEGRAM_BOT_API,
} from '../tokens.js';

import { closeCacheClient, createCacheClient } from './connections.js';

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export interface CoreModuleOptions {
  readonly config: AppConfig;
  readonly rootLogger: Logger;
  /**
   * Replaces the SMTP mail service built from `config` (the demo seed: the
   * configuration still decides sender modes, but nothing is sent).
   */
  readonly mailService?: Mailer;
  /**
   * Tests only: a fake Telegram Bot API (base URL) for `getMe` of the
   * notification bot (T549). Never configurable in production.
   */
  readonly telegramClient?: TelegramClientOptions;
  /** Tests only: DNS of the API's outbound calls (the AI provider on `localhost`, T906). */
  readonly outboundLookup?: HostLookup;
}

/** Closes shared connections after the HTTP server stopped accepting requests. */
@Injectable()
class ConnectionCloser implements OnApplicationShutdown {
  constructor(
    @Inject(CACHE_CLIENT) private readonly cache: Redis,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
    @Inject(MAIL_SERVICE) private readonly mailer: Mailer,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.mailer.close();
    await Promise.allSettled([closeCacheClient(this.cache), this.storage.close()]);
  }
}

/**
 * Process-wide singletons: configuration, logging and connections to Valkey,
 * object storage and SMTP (only when SMTP_URL is set). PostgreSQL lives in
 * `DbModule`.
 */
@Global()
@Module({})
export class CoreModule {
  static forRoot(options: CoreModuleOptions): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: APP_CONFIG, useValue: options.config },
        { provide: ROOT_LOGGER, useValue: options.rootLogger },
        AppLogger,
        {
          provide: CACHE_CLIENT,
          inject: [APP_CONFIG, ROOT_LOGGER],
          useFactory: (config: AppConfig, logger: Logger) => createCacheClient(config, logger),
        },
        {
          provide: STORAGE_DRIVER,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) => createStorageDriver(config),
        },
        {
          provide: EMAIL_QUOTA,
          inject: [APP_CONFIG, CACHE_CLIENT],
          useFactory: (config: AppConfig, cache: Redis): EmailQuota =>
            createValkeyEmailQuota(valkeyQuotaClient(cache), {
              limit: config.email.maxPerHourPerOrg,
              scope: 'org',
              keyPrefix: CACHE_KEY_PREFIX,
            }),
        },
        {
          provide: MAIL_SERVICE,
          inject: [APP_CONFIG, EMAIL_QUOTA, CACHE_CLIENT],
          useFactory: (config: AppConfig, orgQuota: EmailQuota, cache: Redis): Mailer =>
            options.mailService ??
            createMailService(config, {
              orgQuota,
              identityQuota: createValkeyEmailQuota(valkeyQuotaClient(cache), {
                limit: config.email.maxPerHourPerIdentity,
                scope: 'identity',
                keyPrefix: CACHE_KEY_PREFIX,
              }),
            }),
        },
        {
          provide: MAILER,
          inject: [MAIL_SERVICE],
          useFactory: (mailer: Mailer): Mailer | null =>
            mailer.instanceConfigured ? mailer : null,
        },
        { provide: TELEGRAM_BOT_API, useValue: new TelegramBotApi(options.telegramClient) },
        { provide: OUTBOUND_LOOKUP, useValue: options.outboundLookup ?? null },
        ConnectionCloser,
      ],
      exports: [
        APP_CONFIG,
        ROOT_LOGGER,
        AppLogger,
        CACHE_CLIENT,
        STORAGE_DRIVER,
        MAILER,
        MAIL_SERVICE,
        EMAIL_QUOTA,
        TELEGRAM_BOT_API,
        OUTBOUND_LOOKUP,
      ],
    };
  }
}
