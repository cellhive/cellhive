import { attachRealtimePublisher, ValkeyRealtimeBus, type Db } from '@cellhive/server-core';
import { Global, Module } from '@nestjs/common';

import { AppLogger } from '../../common/logging/app-logger.js';
import { CACHE_CLIENT, DB, REALTIME_BUS } from '../../common/tokens.js';

import type { Redis } from 'ioredis';

/**
 * The publishing side of the realtime bus (SPEC §15): `REALTIME_BUS`
 * publishes envelopes on Valkey (`rt:org:<id>`) through the shared cache
 * client. It is also attached to `DB`, so repositories built on it
 * (`BasesRepository`, `JobsRepository`) publish after their transactions
 * commit. Failures are logged and never reach the caller.
 */
@Global()
@Module({
  providers: [
    {
      provide: REALTIME_BUS,
      inject: [CACHE_CLIENT, DB, AppLogger],
      useFactory: (cache: Redis, db: Db, logger: AppLogger) => {
        const bus = new ValkeyRealtimeBus(cache, (err, envelope) => {
          logger.warn(
            { err, envelope_type: envelope.type, org_id: envelope.organization_id },
            'realtime publish failed',
          );
        });
        attachRealtimePublisher(db, bus);
        return bus;
      },
    },
  ],
  exports: [REALTIME_BUS],
})
export class RealtimeBusModule {}
