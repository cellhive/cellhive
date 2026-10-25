import { RecordFollowService, RecordQueryService, type Db } from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { DB } from '../../common/tokens.js';

import { RecordService } from './record.service.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RecordFollowDto, RecordFollowParams } from '@cellhive/contracts';

/**
 * `GET|PUT|DELETE /tables/:tableId/records/:recordId/follow` (CONTRACTS §22.5,
 * BACKLOG T543): resolves the table and the caller's access like every
 * record route (`404` when unreachable, also for another organization), then
 * hands the rest to `RecordFollowService` (the caller must read the record
 * now, else `404`; the cap; "unfollowing by hand wins"). Share links have no
 * follow route.
 */
@Injectable()
export class FollowService {
  private readonly follows: RecordFollowService;

  constructor(
    @Inject(DB) db: Db,
    @Inject(RecordQueryService) query: RecordQueryService,
    @Inject(RecordService) private readonly records: RecordService,
  ) {
    this.follows = new RecordFollowService(db, query);
  }

  async status(principal: Principal, params: RecordFollowParams): Promise<RecordFollowDto> {
    const table = await this.records.resolve(principal, params.tableId);
    const state = await this.follows.status(
      table.scope,
      params.tableId,
      params.recordId,
      table.access,
    );
    return { following: state.following, source: state.source };
  }

  async follow(principal: Principal, params: RecordFollowParams): Promise<void> {
    const table = await this.records.resolve(principal, params.tableId);
    await this.follows.follow(table.scope, params.tableId, params.recordId, table.access);
  }

  async unfollow(principal: Principal, params: RecordFollowParams): Promise<void> {
    const table = await this.records.resolve(principal, params.tableId);
    await this.follows.unfollow(table.scope, params.tableId, params.recordId, table.access);
  }
}
