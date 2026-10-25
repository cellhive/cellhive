import process from 'node:process';

import {
  assertSupportedPostgres,
  ConfigError,
  loadConfig,
  UnsupportedPostgresVersionError,
  type AppConfig,
  type Db,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';

import { createApp } from './app.factory.js';
import { createRootLogger } from './common/logging/root-logger.js';
import { DB } from './common/tokens.js';
import { runMigrations } from './migrate.js';

import type { Logger } from 'pino';

/** Time allowed for in-flight requests and connections to finish on shutdown. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

function readConfig(): AppConfig {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      // No logger yet (LOG_LEVEL itself may be invalid): plain text on stderr.
      // The message names the variables, never their values.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

function installProcessHandlers(logger: Logger, close: () => Promise<void>): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) {
      logger.warn({ signal }, 'second signal received, exiting now');
      process.exit(1);
    }
    closing = true;
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      logger.error({ timeout_ms: SHUTDOWN_TIMEOUT_MS }, 'graceful shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    close().then(
      () => {
        logger.info('shutdown complete');
        process.exitCode = 0;
      },
      (err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
}

/**
 * The background worker (`@cellhive/worker`) in this process: `MODE=worker`
 * runs only it, `MODE=all` runs it next to the HTTP API (SPEC §20 minimal
 * profile). It checks the PostgreSQL version itself before taking jobs.
 */
function startWorker(config: AppConfig, logger: Logger): Promise<WorkerHandle> {
  return createWorker(config, {
    logger: logger.child({ component: 'worker' }),
    onFatal: () => {
      process.exit(1);
    },
  });
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createRootLogger(config.logLevel);

  switch (config.mode) {
    case 'api':
    case 'all':
      break;
    case 'migrate':
      try {
        await runMigrations(config, logger);
      } catch (err) {
        fatal(logger, err, 'migrations failed');
      }
      return;
    case 'worker':
      try {
        const worker = await startWorker(config, logger);
        installProcessHandlers(logger, () => worker.close());
      } catch (err) {
        fatal(logger, err, 'failed to start');
      }
      return;
  }

  try {
    const app = await createApp(config, { logger });
    // Refuse to serve on an unsupported server (ADR-0019), before listening.
    const version = await assertSupportedPostgres(app.get<Db>(DB).kysely);
    logger.info({ postgres: version.version }, 'database version supported');
    const worker = config.mode === 'all' ? await startWorker(config, logger) : undefined;
    // Stop serving requests first, then let running jobs finish.
    installProcessHandlers(logger, async () => {
      await app.close();
      await worker?.close();
    });
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info({ port: config.port, mode: config.mode }, 'api listening');
  } catch (err) {
    fatal(logger, err, 'failed to start');
  }
}

/** Logs and exits; an unsupported PostgreSQL version is reported by its own message. */
function fatal(logger: Logger, err: unknown, message: string): never {
  logger.fatal({ err }, err instanceof UnsupportedPostgresVersionError ? err.message : message);
  process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
