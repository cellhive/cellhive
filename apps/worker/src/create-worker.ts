import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { NestLoggerAdapter } from './nest-logger.js';
import { WorkerModule, type WorkerRuntimeOptions } from './worker.module.js';

import type { AppConfig } from '@cellhive/server-core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Logger } from 'pino';

export interface CreateWorkerOptions extends WorkerRuntimeOptions {
  readonly logger: Logger;
}

export interface WorkerHandle {
  readonly app: INestApplicationContext;
  /** Stops taking jobs, waits for running ones, closes the pool. */
  close(): Promise<void>;
}

/**
 * Builds the worker's NestJS application context and starts the job runner.
 * Used by `apps/worker/src/main.ts` and by the api process for `MODE=worker`
 * and `MODE=all` (one process, SPEC §20 minimal profile).
 */
export async function createWorker(
  config: AppConfig,
  options: CreateWorkerOptions,
): Promise<WorkerHandle> {
  const { logger, ...runtime } = options;
  const app = await NestFactory.createApplicationContext(
    WorkerModule.register({ config, rootLogger: logger, ...runtime }),
    {
      logger: new NestLoggerAdapter(logger.child({ component: 'nest' })),
      abortOnError: false,
    },
  );
  let closing: Promise<void> | undefined;
  return {
    app,
    close: () => (closing ??= app.close()),
  };
}
