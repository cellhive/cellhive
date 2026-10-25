import {
  RealtimeSchemaChangePublisher,
  SchemaService,
  type AppConfig,
  type Db,
  type RealtimePublisher,
  type SchemaChangePublisher,
} from '@cellhive/server-core';
import { Global, Module } from '@nestjs/common';

import { AppLogger } from '../logging/app-logger.js';
import { APP_CONFIG, DB, REALTIME_BUS } from '../tokens.js';

import { SchemaAccess } from './schema-access.js';

/**
 * Receives committed schema changes and forwards them to the realtime bus
 * (`schema.changed`, CONTRACTS §7).
 */
export const SCHEMA_CHANGE_PUBLISHER = Symbol('SCHEMA_CHANGE_PUBLISHER');

/**
 * `SchemaService` (the only DDL path, AGENTS.md rule 1) and `SchemaAccess`
 * for every module, injected by class.
 */
@Global()
@Module({
  providers: [
    {
      provide: SCHEMA_CHANGE_PUBLISHER,
      inject: [REALTIME_BUS, DB, AppLogger],
      useFactory: (bus: RealtimePublisher, db: Db, logger: AppLogger): SchemaChangePublisher =>
        // With `db`: a primary field change refreshes link cells of other tables (T459).
        new RealtimeSchemaChangePublisher(bus, {
          db,
          onError: (error) => {
            logger.warn({ err: error }, 'link title refresh publish failed');
          },
        }),
    },
    {
      provide: SchemaService,
      inject: [DB, APP_CONFIG, SCHEMA_CHANGE_PUBLISHER, AppLogger],
      useFactory: (
        db: Db,
        config: AppConfig,
        publisher: SchemaChangePublisher,
        logger: AppLogger,
      ) =>
        new SchemaService(db, {
          maxFieldsPerTable: config.limits.maxFieldsPerTable,
          maxComputedFieldsPerBase: config.limits.computedFieldsMaxPerBase,
          publisher,
          onPublishError: (error) => {
            logger.warn({ err: error }, 'schema change publish failed');
          },
        }),
    },
    SchemaAccess,
  ],
  exports: [SCHEMA_CHANGE_PUBLISHER, SchemaService, SchemaAccess],
})
export class SchemaCoreModule {}
