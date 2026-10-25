import { httpDeliveryResponseSchema, type HttpDeliveryResult, type Id } from '@cellhive/contracts';
import {
  AutomationsRepository,
  deliveryErrorOf,
  HttpDeliveriesRepository,
  orgScope,
  type Db,
  type HttpDeliveryRow,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound } from '../../common/access/access.service.js';
import { iso } from '../../common/dto.js';
import { DB } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';

/**
 * Results of "Send a test" of `http_request` (BACKLOG T606, CONTRACTS
 * §25.5): `GET /http-deliveries/:id` for a `test` delivery, read **only**
 * by the person who sent it — the request was rendered with their
 * permissions, so its response may echo values others cannot read (the
 * hidden-value class of S5b H1). Anyone else, managers of the automation
 * included, and any `action` delivery (the run log shows those, redacted)
 * gets `404`.
 * The answer carries the kept response (status, `content-type`, body cut
 * at 10 KB) and the error code; never the URL, request headers, request
 * body or secret values (the encrypted request is not read).
 */
@Injectable()
export class HttpDeliveryService {
  private readonly deliveries: HttpDeliveriesRepository;

  constructor(
    @Inject(DB) db: Db,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AutomationsRepository) private readonly automations: AutomationsRepository,
  ) {
    this.deliveries = new HttpDeliveriesRepository(db);
  }

  async get(principal: Principal, deliveryId: Id<'hdl'>): Promise<HttpDeliveryResult> {
    for (const membership of await this.access.memberships(principal)) {
      const row = await this.deliveries.get(orgScope(membership.organizationId), deliveryId);
      if (row === undefined) continue;
      if (row.kind !== 'test' || row.requested_by !== principal.userId) throw notFound();
      if (principal.kind === 'api_token') {
        // An API token reaches only deliveries of automations in a base it
        // can open (its `base_ids`, BACKLOG T704); none without an automation
        // when it is limited to bases.
        const scope = orgScope(membership.organizationId);
        const baseId =
          row.automation_id === null
            ? undefined
            : await this.automations.baseIdOf(scope, row.automation_id);
        if (baseId === undefined) {
          if (principal.baseIds !== null) throw notFound();
        } else if ((await this.access.findBase(principal, baseId)) === undefined) {
          throw notFound();
        }
      }
      return resultOf(row);
    }
    throw notFound();
  }
}

function resultOf(row: HttpDeliveryRow): HttpDeliveryResult {
  const response = httpDeliveryResponseSchema.safeParse(row.response);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    target_host: row.target_host,
    attempts: row.attempts,
    response: response.success ? response.data : null,
    error: deliveryErrorOf(row.last_error),
    created_at: iso(row.created_at),
    completed_at: row.completed_at === null ? null : iso(row.completed_at),
  };
}
