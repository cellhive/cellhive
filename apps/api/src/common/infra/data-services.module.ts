import {
  RecordHistoryService,
  RecordMutationService,
  RecordQueryService,
  SchemaService,
  type AppConfig,
  type Db,
} from '@cellhive/server-core';
import { Global, Module } from '@nestjs/common';

import { AppLogger } from '../logging/app-logger.js';
import { APP_CONFIG, DB } from '../tokens.js';

/**
 * The server-core services that read and write records (AGENTS.md rule 1),
 * one instance each, injected by class: `RecordQueryService` and
 * `RecordMutationService` (which uses the `SchemaService` of
 * `SchemaCoreModule` to create select options), and `RecordHistoryService`
 * (history and revert on top of both). Permission checks stay with the
 * callers.
 */
@Global()
@Module({
  providers: [
    {
      provide: RecordQueryService,
      inject: [DB, APP_CONFIG],
      useFactory: (db: Db, config: AppConfig) =>
        // Computed values use the organization zone, else the instance default (T457).
        new RecordQueryService(db, {
          defaultTimeZone: config.defaults.timezone,
          defaultLocale: config.defaults.locale,
        }),
    },
    {
      provide: RecordMutationService,
      inject: [DB, APP_CONFIG, SchemaService, RecordQueryService, AppLogger],
      useFactory: (
        db: Db,
        config: AppConfig,
        schema: SchemaService,
        query: RecordQueryService,
        logger: AppLogger,
      ) =>
        new RecordMutationService(db, {
          schema,
          query,
          defaultTimeZone: config.defaults.timezone,
          // Realtime is best effort (SPEC §7.3 step 7): the write has committed.
          onPublishError: (err: unknown) => {
            logger.warn({ err }, 'record change publisher failed');
          },
        }),
    },
    {
      provide: RecordHistoryService,
      inject: [DB, RecordQueryService, RecordMutationService],
      useFactory: (db: Db, query: RecordQueryService, mutation: RecordMutationService) =>
        new RecordHistoryService(db, query, mutation),
    },
  ],
  exports: [RecordQueryService, RecordMutationService, RecordHistoryService],
})
export class DataServicesModule {}
