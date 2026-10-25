import { HTTP_TEST_SENDS_PER_MIN } from '@cellhive/contracts';
import { HttpRequestTester } from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { requireTokenScope } from '../../common/auth/scope.guard.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';

import { AutomationService } from './automation.service.js';

import type { Principal } from '../../common/auth/principal.js';
import type { HttpTestAccepted, HttpTestRequest, Id } from '@cellhive/contracts';

/**
 * "Send a test" of an `http_request` step (BACKLOG T606, CONTRACTS §25.5):
 * for people who manage the automation (`404`/`403` like the other
 * automation routes), at most `HTTP_TEST_SENDS_PER_MIN` per person per
 * minute (`429`). The request is rendered with the caller's own
 * permissions (`HttpRequestTester`, never `run_as`'s) and goes through the
 * outbox as a `test` delivery: the API never calls the destination. The
 * result is read with `GET /http-deliveries/:id`.
 */
@Injectable()
export class AutomationHttpTestService {
  constructor(
    @Inject(AutomationService) private readonly automations: AutomationService,
    @Inject(HttpRequestTester) private readonly tester: HttpRequestTester,
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
  ) {}

  async test(
    principal: Principal,
    automationId: Id<'aut'>,
    actionId: string,
    body: HttpTestRequest,
    meta: RequestMeta,
  ): Promise<HttpTestAccepted> {
    const { base, row } = await this.automations.locate(principal, automationId);
    // A test request carries the record's values to the destination: through an API token,
    // that is `records:read` too (CONTRACTS §26.2 — QA S6).
    if (body.record_id !== null) requireTokenScope(principal, 'records:read');
    await this.rateLimiter.hit(`automation-http-test:${principal.userId}`, {
      limit: HTTP_TEST_SENDS_PER_MIN,
      windowSeconds: 60,
    });
    const { deliveryId, warnings } = await this.tester.send(
      base.org.scope,
      {
        automation: {
          id: row.id,
          name: row.name,
          base_id: row.base_id,
          definition: row.definition,
          trigger_table_id: row.trigger_table_id,
        },
        actionId,
        ...(body.draft === undefined ? {} : { draft: body.draft }),
        recordId: body.record_id,
        requesterUserId: principal.userId,
      },
      auditContextOf(meta, { type: 'user', id: principal.userId }),
    );
    return { delivery_id: deliveryId, warnings: [...warnings] };
  }
}
