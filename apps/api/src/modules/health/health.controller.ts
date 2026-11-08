import { Controller, Get, Inject } from '@nestjs/common';

import { Public } from '../../common/auth/principal.js';
import { APP_CONFIG } from '../../common/tokens.js';

import { HealthService } from './health.service.js';

import type { HealthResponse, ReadinessResponse } from '@cellhive/contracts/openapi';
import type { AppConfig } from '@cellhive/server-core';

/** `/healthz` and `/readyz` (SPEC §19); outside `/api/v1`, unauthenticated. */
@Controller()
@Public({ ignoreSession: true })
export class HealthController {
  constructor(
    @Inject(HealthService) private readonly health: HealthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Liveness: answers while the process runs, with the version of the build
   * (`CELLHIVE_BUILD_VERSION`, public — BACKLOG T1023); checks nothing else.
   */
  @Get('healthz')
  healthz(): HealthResponse {
    return { status: 'ok', version: this.config.version };
  }

  @Get('readyz')
  readyz(): Promise<ReadinessResponse> {
    return this.health.readiness();
  }
}
