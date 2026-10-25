import { Controller, Get, Inject } from '@nestjs/common';

import { Public } from '../../common/auth/principal.js';

import { HealthService } from './health.service.js';

import type { ReadinessResponse } from '@cellhive/contracts/openapi';

/** `/healthz` and `/readyz` (SPEC §19); outside `/api/v1`, unauthenticated. */
@Controller()
@Public({ ignoreSession: true })
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** Liveness: answers while the process runs; checks nothing else. */
  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  readyz(): Promise<ReadinessResponse> {
    return this.health.readiness();
  }
}
