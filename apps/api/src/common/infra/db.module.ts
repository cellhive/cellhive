import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';

import { APP_CONFIG, DB, ROOT_LOGGER } from '../tokens.js';

import { createApiDb } from './connections.js';

import type { AppConfig, Db } from '@cellhive/server-core';
import type { Logger } from 'pino';

/** Closes the pool after the HTTP server stopped accepting requests. */
@Injectable()
class DbCloser implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

/**
 * The PostgreSQL layer (`Db`: Kysely + `withTx`), injected with
 * `@Inject(DB)`. Repositories are built on it by the modules that own them.
 * The server version is checked by `main.ts` before listening (ADR-0019), so
 * building the module never needs a connection.
 */
@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [APP_CONFIG, ROOT_LOGGER],
      useFactory: (config: AppConfig, logger: Logger) => createApiDb(config, logger),
    },
    DbCloser,
  ],
  exports: [DB],
})
export class DbModule {}
