import 'reflect-metadata';

import { IDEMPOTENT_REPLAYED_HEADER, newId } from '@cellhive/contracts';
import { formatCidr, type AppConfig } from '@cellhive/server-core';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { LogController } from 'fastify';

import { AppModule, type AppModuleOptions } from './app.module.js';
import { ProblemExceptionFilter } from './common/errors/problem.filter.js';
import { registerRawUploadSupport } from './common/http/raw-upload.js';
import { REQUEST_ID_HEADER, registerRequestHooks } from './common/http/request-hooks.js';
import { AppLogger, NestLoggerAdapter } from './common/logging/app-logger.js';
import { createRootLogger } from './common/logging/root-logger.js';
import { MetricsService } from './modules/metrics/metrics.service.js';
import { registerShareResponseHeaders } from './modules/share/share-headers.js';

import type { Logger } from 'pino';

/** Every public API route lives under this prefix (SPEC §13.1). */
export const API_PREFIX = 'api/v1';
/** Routes served at the root: probes and metrics (SPEC §19). */
export const ROOT_ROUTES = ['healthz', 'readyz', 'metrics'] as const;
/** Largest JSON request body; larger bodies get `413 PAYLOAD_TOO_LARGE`. */
export const JSON_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * Nest converts Fastify errors (`FST_ERR_CTP_*`) into bare `HttpException`s,
 * losing their `code`; keep them intact so that `ProblemExceptionFilter` can
 * tell malformed JSON from other client errors.
 */
class CellhiveFastifyAdapter extends FastifyAdapter {
  override mapException(error: unknown): unknown {
    return error;
  }
}

export interface CreateAppOptions {
  /** Root logger; defaults to JSON on stdout at LOG_LEVEL. */
  readonly logger?: Logger;
  /** Extra modules (tests register probe routes this way). */
  readonly imports?: AppModuleOptions['imports'];
  /** Tests only: a fake Telegram Bot API (T549); production uses `api.telegram.org`. */
  readonly telegramClient?: AppModuleOptions['telegramClient'];
  /** Tests only: DNS of the API's outbound calls (the fake AI provider on `localhost`, T906). */
  readonly outboundLookup?: AppModuleOptions['outboundLookup'];
}

/**
 * Builds and initialises the API application without listening, so tests can
 * use `app.inject()` or `app.listen()` on the same instance `main.ts` runs.
 */
export async function createApp(
  config: AppConfig,
  options: CreateAppOptions = {},
): Promise<NestFastifyApplication> {
  const rootLogger = options.logger ?? createRootLogger(config.logLevel);

  const adapter = new CellhiveFastifyAdapter({
    loggerInstance: rootLogger,
    logController: new LogController({
      // One access log line per request is written by `registerRequestHooks`.
      disableRequestLogging: true,
      requestIdLogLabel: 'request_id',
    }),
    // The request id is always generated here (CONTRACTS §1.1), never taken
    // from the client.
    genReqId: () => newId('req'),
    requestIdHeader: false,
    trustProxy: config.security.trustedProxies.map(formatCidr),
    bodyLimit: JSON_BODY_LIMIT_BYTES,
    return503OnClosing: true,
  });
  const fastify = adapter.getInstance();
  registerRawUploadSupport(fastify);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config,
      rootLogger,
      imports: options.imports,
      ...(options.telegramClient === undefined ? {} : { telegramClient: options.telegramClient }),
      ...(options.outboundLookup === undefined ? {} : { outboundLookup: options.outboundLookup }),
    }),
    adapter,
    {
      logger: new NestLoggerAdapter(rootLogger.child({ component: 'nest' })),
      // Throw instead of calling process.exit when a provider fails to build.
      abortOnError: false,
    },
  );

  const metrics = app.get(MetricsService);
  registerRequestHooks(fastify, {
    observe: (method, route, status, ms) => {
      metrics.observeRequest(method, route, status, ms);
    },
  });

  await app.register(fastifyHelmet);
  registerShareResponseHeaders(fastify);
  await app.register(fastifyCors, {
    origin: [...config.security.corsOrigins],
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER, 'etag', 'retry-after', IDEMPOTENT_REPLAYED_HEADER],
  });

  app.setGlobalPrefix(API_PREFIX, { exclude: [...ROOT_ROUTES] });
  app.useGlobalFilters(new ProblemExceptionFilter(app.get(AppLogger)));

  await app.init();
  return app;
}
