import { MAX_RECORD_FOLLOWS_PER_USER, TOO_MANY_FOLLOWS, type Id } from '@cellhive/contracts';

import { withTxScope, type OrgScope } from '../../db/repository.js';
import { AppError } from '../../errors/app-error.js';

import {
  RecordFollowsRepository,
  type RecordFollowState,
  type RecordFollowTarget,
} from './record-follows.repository.js';

import type { Db } from '../../db/create-db.js';
import type { RecordQueryService } from '../../records/record-query.service.js';
import type { RecordAccessContext } from '../../records/types.js';

const recordNotFound = () => new AppError('NOT_FOUND', { detail: 'The record does not exist.' });

/**
 * Following and unfollowing a record by hand (CONTRACTS §22.5; ADR-29 §1,
 * ADR-34 §2; BACKLOG T543). The caller must read the record **now** through
 * `RecordQueryService` (table permission, read rule, outside the trash):
 * anything else — including a table or base the caller cannot read — is
 * `404`, exactly like a missing record. A person only ever follows for
 * themselves (`access.userId`). Nothing is audited and no event is written:
 * following is a personal setting (like CONTRACTS §22.3).
 */
export class RecordFollowService {
  private readonly follows: RecordFollowsRepository;

  constructor(
    private readonly db: Db,
    private readonly query: RecordQueryService,
  ) {
    this.follows = new RecordFollowsRepository(db);
  }

  /** `GET …/follow`. */
  async status(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
    access: RecordAccessContext,
  ): Promise<RecordFollowState> {
    const target = await this.readableTarget(scope, tableId, recordId, access);
    return this.follows.isFollowing(scope, target);
  }

  /**
   * `PUT …/follow`: idempotent; an existing follow keeps its source, else
   * `manual`. Following one more record than the cap is
   * `422 VALIDATION_FAILED` / `TOO_MANY_FOLLOWS` (nothing written).
   */
  async follow(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
    access: RecordAccessContext,
  ): Promise<void> {
    await this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      const target = await this.readableTarget(txScope, tableId, recordId, access);
      await this.follows.lockUser(txScope, target.userId);
      if ((await this.follows.isFollowing(txScope, target)).following) return;
      if (
        (await this.follows.countForUser(txScope, target.userId)) >= MAX_RECORD_FOLLOWS_PER_USER
      ) {
        throw new AppError('VALIDATION_FAILED', {
          detail: `A person follows at most ${String(MAX_RECORD_FOLLOWS_PER_USER)} records.`,
          errors: [
            {
              path: 'record_id',
              code: TOO_MANY_FOLLOWS,
              message: `You already follow ${String(MAX_RECORD_FOLLOWS_PER_USER)} records`,
              params: { maximum: MAX_RECORD_FOLLOWS_PER_USER },
            },
          ],
        });
      }
      await this.follows.follow(txScope, target, 'manual');
    });
  }

  /**
   * `DELETE …/follow`: idempotent. The follow becomes a muted row, so no
   * automatic source (creating, being assigned) follows the record again for
   * the caller — only `PUT …/follow` does (BACKLOG "Câu hỏi mở S5b" #2).
   */
  async unfollow(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
    access: RecordAccessContext,
  ): Promise<void> {
    await this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      const target = await this.readableTarget(txScope, tableId, recordId, access);
      await this.follows.unfollow(txScope, target);
    });
  }

  /** The caller and the record when the caller reads it now, else `404`. */
  private async readableTarget(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
    access: RecordAccessContext,
  ): Promise<RecordFollowTarget> {
    const userId = access.userId;
    // Share links (anonymous) and the system never follow.
    if (userId === null) throw recordNotFound();
    if (!(await this.query.matchRecord(scope, tableId, recordId, access, null))) {
      throw recordNotFound();
    }
    return { tableId, recordId, userId };
  }
}
