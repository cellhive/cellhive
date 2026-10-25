import { IdempotencyKeysRepository, type Db } from '@cellhive/server-core';
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { ApiRateLimits } from '../rate-limit/api-rate-limits.js';
import { DB } from '../tokens.js';

import { IdempotencyService } from './idempotency.service.js';
import { RequestPoliciesInterceptor } from './request-policies.interceptor.js';

/**
 * Cross-cutting request policies of the API: `Idempotency-Key`
 * (CONTRACTS §1.1) and the per-principal / per-base rate limits
 * (SPEC §13.1), applied to every authenticated route by the global
 * `RequestPoliciesInterceptor`.
 */
@Global()
@Module({
  providers: [
    {
      provide: IdempotencyKeysRepository,
      inject: [DB],
      useFactory: (db: Db) => new IdempotencyKeysRepository(db),
    },
    IdempotencyService,
    ApiRateLimits,
    { provide: APP_INTERCEPTOR, useClass: RequestPoliciesInterceptor },
  ],
  exports: [IdempotencyService, ApiRateLimits],
})
export class RequestPoliciesModule {}
