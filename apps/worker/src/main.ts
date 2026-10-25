import process from 'node:process';

import {
  ConfigError,
  loadConfig,
  UnsupportedPostgresVersionError,
  type AppConfig,
} from '@cellhive/server-core';

import { createWorker } from './create-worker.js';
import { createWorkerLogger } from './logger.js';

/**
 * Standalone worker process (`pnpm --filter @cellhive/worker dev|start`).
 * Production images run the same code through the api entry with
 * `MODE=worker` (or `MODE=all`); this entry always runs the worker.
 */

/** Time allowed for running jobs to finish on shutdown. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

function readConfig(): AppConfig {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      // The message names the variables, never their values.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createWorkerLogger(config.logLevel);
  try {
    const worker = await createWorker(config, {
      logger,
      onFatal: () => {
        process.exit(1);
      },
    });
    let closing = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (closing) {
        logger.warn({ signal }, 'second signal received, exiting now');
        process.exit(1);
      }
      closing = true;
      logger.info({ signal }, 'shutting down');
      setTimeout(() => {
        logger.error({ timeout_ms: SHUTDOWN_TIMEOUT_MS }, 'graceful shutdown timed out');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS).unref();
      worker.close().then(
        () => {
          logger.info('shutdown complete');
        },
        (err: unknown) => {
          logger.error({ err }, 'shutdown failed');
          process.exit(1);
        },
      );
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (err) {
    logger.fatal(
      { err },
      err instanceof UnsupportedPostgresVersionError ? err.message : 'failed to start',
    );
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
