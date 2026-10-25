import {
  BUTTON_CLICK_RECORD_INTERVAL_SECONDS,
  BUTTON_CLICKS_PER_MINUTE,
  type ButtonClickParams,
  type ButtonClickResponse,
} from '@cellhive/contracts';
import {
  ButtonClickService,
  RecordQueryService,
  type AppConfig,
  type Db,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { mutationContextOf } from '../../common/access/change-log.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import { RecordService } from './record.service.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';

/**
 * Button clicks (BACKLOG T517, ADR-32 §2, CONTRACTS §21): resolves the table
 * and the caller's access like every record route (`404` when unreachable),
 * applies the click limits in Valkey, then hands the click to
 * `ButtonClickService` (permission checks, `enabled_when`, event + run).
 * Share links have no click route.
 */
@Injectable()
export class ButtonService {
  private readonly clicks: ButtonClickService;

  constructor(
    @Inject(DB) db: Db,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(RecordQueryService) query: RecordQueryService,
    @Inject(RecordService) private readonly records: RecordService,
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
  ) {
    this.clicks = new ButtonClickService(db, {
      defaults: { timeZone: config.defaults.timezone, locale: config.defaults.locale },
      records: query,
    });
  }

  async click(
    principal: Principal,
    params: ButtonClickParams,
    meta: RequestMeta,
  ): Promise<ButtonClickResponse> {
    const table = await this.records.resolve(principal, params.tableId);
    // Counted before any other work (ADR-32 §2): ids only in the keys.
    await this.rateLimiter.hit(`button:${params.fieldId}:${principal.userId}`, {
      limit: BUTTON_CLICKS_PER_MINUTE,
      windowSeconds: 60,
    });
    await this.rateLimiter.hit(`button:${params.fieldId}:${params.recordId}:${principal.userId}`, {
      limit: 1,
      windowSeconds: BUTTON_CLICK_RECORD_INTERVAL_SECONDS,
    });
    const result = await this.clicks.click(table.scope, {
      tableId: params.tableId,
      recordId: params.recordId,
      fieldId: params.fieldId,
      access: table.access,
      context: mutationContextOf(meta, principal.userId),
    });
    return { run_id: result.runId };
  }
}
