import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { AppError, loadConfig, type AppConfig, type Env } from '@cellhive/server-core';
import { Body, Controller, Get, Inject, Module, Post } from '@nestjs/common';
import pg from 'pg';
import { pino, type Logger } from 'pino';
import { inject } from 'vitest';
import { z } from 'zod';

import { createApp, type CreateAppOptions } from '../../src/app.factory.js';
import { Public } from '../../src/common/auth/principal.js';
import { AppLogger } from '../../src/common/logging/app-logger.js';
import { rootLoggerOptions } from '../../src/common/logging/root-logger.js';
import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';
import { CACHE_CLIENT } from '../../src/common/tokens.js';
import { ZodValidationPipe } from '../../src/common/validation/zod-validation.pipe.js';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Redis } from 'ioredis';

export const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef';
export const TEST_PUBLIC_URL = 'https://cellhive.test';

export const echoSchema = z.strictObject({
  name: z.string().min(1),
  records: z.array(z.object({ fields: z.record(z.string(), z.number()) })).max(3),
});

/** Test-only routes under /api/v1/__test. */
@Controller('__test')
@Public()
class ProbeController {
  constructor(@Inject(AppLogger) private readonly logger: AppLogger) {}

  @Post('echo')
  echo(@Body(new ZodValidationPipe(echoSchema)) body: z.output<typeof echoSchema>): object {
    return { received_records: body.records.length };
  }

  @Get('boom')
  boom(): never {
    throw new Error('database password is hunter2 at /srv/secret/path.ts');
  }

  @Get('app-error')
  appError(): never {
    throw new AppError('SETUP_COMPLETED', { detail: 'Already set up.', params: { hidden: 'x' } });
  }

  @Get('log')
  log(): object {
    this.logger.info({ probe: true }, 'probe log line');
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
export class ProbeModule {}

export interface CapturedLogs {
  readonly lines: Record<string, unknown>[];
  readonly raw: () => string;
}

/** A pino logger with the production options, writing into memory. */
export function captureLogger(): { logger: Logger; logs: CapturedLogs } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = pino({ ...rootLoggerOptions('debug') }, stream);
  return {
    logger,
    logs: {
      get lines() {
        return chunks
          .join('')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      },
      raw: () => chunks.join(''),
    },
  };
}

export interface TestApp {
  readonly app: NestFastifyApplication;
  readonly config: AppConfig;
  readonly storageRoot: string;
  readonly logs: CapturedLogs;
  close(): Promise<void>;
}

/**
 * Builds the real application against the shared containers. The API rate
 * limits (SPEC §13.1) are raised so that fast test setups never trip them;
 * `rate-limits.int.test.ts` sets its own.
 */
export async function startTestApp(
  env: Env = {},
  options: Pick<CreateAppOptions, 'telegramClient'> = {},
): Promise<TestApp> {
  const storageRoot = await mkdtemp(join(tmpdir(), 'cellhive-api-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_URL: TEST_PUBLIC_URL,
    DATABASE_URL: inject('databaseUrl'),
    CACHE_URL: inject('cacheUrl'),
    APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    SESSION_SECRET: TEST_SESSION_SECRET,
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_PATH: storageRoot,
    LOG_LEVEL: 'debug',
    ...env,
  });
  const { logger, logs } = captureLogger();
  const app = await createApp(config, { logger, imports: [ProbeModule], ...options });
  const limits = app.get(ApiRateLimits);
  limits.perPrincipal = { limit: 100_000, windowSeconds: 1 };
  limits.perBase = { limit: 100_000, windowSeconds: 1 };
  return {
    app,
    config,
    storageRoot,
    logs,
    async close() {
      // QA S5 L13: `app.close()` rarely never resolves under load. When it
      // takes this long, print what is still open so CI logs show the cause.
      const watchdog = setTimeout(() => {
        void shutdownDiagnostics(app, config).then((text) => {
          process.stderr.write(text);
        });
      }, SHUTDOWN_WATCHDOG_MS);
      watchdog.unref();
      try {
        await app.close();
      } finally {
        clearTimeout(watchdog);
      }
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

const SHUTDOWN_WATCHDOG_MS = 20_000;

/**
 * State of a test application whose shutdown is stuck: Valkey clients,
 * active Node resources and the API's PostgreSQL sessions (seen from a
 * separate connection). Test-only; never throws.
 */
async function shutdownDiagnostics(app: NestFastifyApplication, config: AppConfig) {
  const lines = [
    `\n[shutdown watchdog] app.close() still running after ${String(SHUTDOWN_WATCHDOG_MS)} ms`,
  ];
  try {
    lines.push(`  cache client: ${app.get<Redis>(CACHE_CLIENT).status}`);
  } catch (error) {
    lines.push(`  cache client: ${String(error)}`);
  }
  lines.push(`  active resources: ${process.getActiveResourcesInfo().join(', ')}`);
  const client = new pg.Client({ connectionString: config.database.url });
  try {
    await client.connect();
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT pid, application_name, state, wait_event_type, wait_event,
              now() - state_change AS for, left(query, 160) AS query
         FROM pg_stat_activity
        WHERE application_name LIKE 'cellhive-api%' AND pid <> pg_backend_pid()
          AND datname = current_database()`,
    );
    lines.push(`  postgres sessions: ${String(rows.length)}`);
    for (const row of rows) lines.push(`    ${JSON.stringify(row)}`);
  } catch (error) {
    lines.push(`  postgres sessions: ${String(error)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
  return `${lines.join('\n')}\n`;
}

export function problemOf(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}
