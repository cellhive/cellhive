import {
  DEPENDENCY_DOWN,
  READINESS_DEPENDENCIES,
  type ReadinessDependency,
  type ReadinessResponse,
} from '@cellhive/contracts/openapi';
import { AppError, type Db, type StorageDriver } from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { pingCache } from '../../common/infra/connections.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { CACHE_CLIENT, DB, STORAGE_DRIVER } from '../../common/tokens.js';

import type { Redis } from 'ioredis';

/** Upper bound for each dependency check. */
export const READINESS_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CACHE_CLIENT) private readonly cache: Redis,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /**
   * Checks every dependency in parallel (SPEC §19). Throws
   * `503 DEPENDENCY_UNAVAILABLE` listing the unavailable ones; reasons are
   * logged, never returned (the endpoint is unauthenticated).
   */
  async readiness(): Promise<ReadinessResponse> {
    const checks: Record<ReadinessDependency, () => Promise<unknown>> = {
      database: () => sql`SELECT 1`.execute(this.db.kysely),
      cache: () => pingCache(this.cache),
      storage: () => this.storage.health(AbortSignal.timeout(READINESS_TIMEOUT_MS)),
    };
    const results = await Promise.allSettled(
      READINESS_DEPENDENCIES.map((name) => withTimeout(checks[name](), READINESS_TIMEOUT_MS)),
    );

    const down: ReadinessDependency[] = [];
    results.forEach((result, index) => {
      const name = READINESS_DEPENDENCIES[index];
      if (name !== undefined && result.status === 'rejected') {
        down.push(name);
        this.logger.warn({ dependency: name, err: result.reason }, 'readiness check failed');
      }
    });

    if (down.length > 0) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', {
        detail: `Unavailable: ${down.join(', ')}.`,
        errors: down.map((name) => ({
          path: `checks.${name}`,
          code: DEPENDENCY_DOWN,
          message: `The ${name} dependency is unavailable`,
        })),
      });
    }
    return { status: 'ok', checks: { database: 'up', cache: 'up', storage: 'up' } };
  }
}
