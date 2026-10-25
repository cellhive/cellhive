import {
  DEFAULT_AUTO_FOLLOW_ASSIGNED,
  DEFAULT_AUTO_FOLLOW_CREATED,
  isId,
  MAX_RECORD_FOLLOWS_PER_USER,
  type Id,
  type RecordFollowSource,
} from '@cellhive/contracts';

import { OrgMembersRepository } from '../../db/repositories/org-members.repository.js';
import { NotificationSettingsRepository } from '../notification-preferences.repository.js';

import { RecordFollowsRepository } from './record-follows.repository.js';

import type { AuditContext } from '../../audit/audit-entry.js';
import type { Db } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { Causation } from '../../events/event.js';

/** An automatic source of following (`manual` is the follow button). */
export type AutoFollowSource = Exclude<RecordFollowSource, 'manual'>;

/** What `RecordMutationService.create` hands to {@link RecordFollowHooks.afterCreate}. */
export interface AfterCreateInput {
  readonly tableId: Id<'tbl'>;
  /** Records the call created. */
  readonly recordIds: readonly Id<'rec'>[];
  readonly context: AuditContext;
  readonly causation: Causation | undefined;
  /** The options of the `create` call (`CreateOptions`). */
  readonly options: {
    /** The caller asks for the creator's automatic follow (the record API, T543). */
    readonly autoFollow?: boolean;
    readonly importCells?: boolean;
    readonly formUpload?: unknown;
  };
}

/** Input of {@link RecordFollowHooks.autoFollow}. */
export interface AutoFollowInput {
  readonly tableId: Id<'tbl'>;
  readonly userId: Id<'usr'>;
  readonly recordIds: readonly Id<'rec'>[];
  readonly source: AutoFollowSource;
}

/**
 * Automatic following (CONTRACTS §22.5; ADR-34 §2; BACKLOG T543, T544): the
 * logic the record write path calls in its own transaction — the mutation
 * service only calls these hooks.
 *
 * - {@link afterCreate}: the person who created **one** record by hand
 *   follows it (`source = created`) when `auto_follow_created` is on. Bulk
 *   writes (ADR-26 §2: two or more records), imports, form submissions,
 *   share links, automations and API tokens never follow.
 * - {@link autoFollow}: the shared rule of every automatic source — the
 *   person's switch (`auto_follow_created` / `auto_follow_assigned`), the
 *   membership, the cap (`MAX_RECORD_FOLLOWS_PER_USER`, silently skipped
 *   past it) and "unfollowing by hand wins" (a muted row is never turned back
 *   into a follow). T544 calls it for `assigned`.
 * - {@link afterPurge}: purged records lose their follows in the purge
 *   transaction.
 */
export class RecordFollowHooks {
  private readonly follows: RecordFollowsRepository;
  private readonly settings: NotificationSettingsRepository;
  private readonly members: OrgMembersRepository;

  constructor(db: Db) {
    this.follows = new RecordFollowsRepository(db);
    this.settings = new NotificationSettingsRepository(db);
    this.members = new OrgMembersRepository(db);
  }

  /** Runs in the create's transaction (`scope.tx`), after the rows are inserted. */
  async afterCreate(scope: OrgScope, input: AfterCreateInput): Promise<void> {
    const creator = creatorOf(input);
    if (creator === null) return;
    await this.autoFollow(scope, {
      tableId: input.tableId,
      userId: creator,
      recordIds: input.recordIds,
      source: 'created',
    });
  }

  /**
   * Follows `recordIds` for `userId` from an automatic source, in the
   * caller's transaction. Returns the records followed because of this call
   * (none when the switch is off, the person left the organization, the
   * records are already followed or were unfollowed by hand, or the cap is
   * reached).
   */
  async autoFollow(scope: OrgScope, input: AutoFollowInput): Promise<Id<'rec'>[]> {
    if (scope.tx === undefined) throw new TypeError('autoFollow needs a transaction scope');
    if (input.recordIds.length === 0) return [];
    const [stored] = await this.settings.listForUsers(scope, [input.userId]);
    const enabled =
      input.source === 'created'
        ? (stored?.auto_follow_created ?? DEFAULT_AUTO_FOLLOW_CREATED)
        : (stored?.auto_follow_assigned ?? DEFAULT_AUTO_FOLLOW_ASSIGNED);
    if (!enabled) return [];
    if ((await this.members.get(scope, input.userId)) === undefined) return [];
    await this.follows.lockUser(scope, input.userId);
    const room =
      MAX_RECORD_FOLLOWS_PER_USER - (await this.follows.countForUser(scope, input.userId));
    return this.follows.followMany(scope, {
      tableId: input.tableId,
      userId: input.userId,
      recordIds: input.recordIds,
      source: input.source,
      limit: room,
    });
  }

  /** Purged records (`records/trash/purge`, `records.purge`): their follows go with them. */
  async afterPurge(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordIds: readonly Id<'rec'>[],
  ): Promise<void> {
    await this.follows.deleteForRecords(scope, tableId, recordIds);
  }
}

/**
 * The person who created the record by hand, or `null` when the write is not
 * one: asked for by the caller (the record API), a signed-in user acting
 * directly (no automation, API token, share link, import or revert —
 * `via = null` — and no automation causation), exactly one record (a bulk
 * write follows nothing, ADR-26 §2), not import cells nor a form upload.
 */
function creatorOf(input: AfterCreateInput): Id<'usr'> | null {
  const { context, options } = input;
  if (options.autoFollow !== true) return null;
  if (options.importCells === true || options.formUpload !== undefined) return null;
  if (context.actor.type !== 'user' || context.via !== null) return null;
  if (input.causation !== undefined || input.recordIds.length !== 1) return null;
  const id = context.actor.id;
  return id !== null && isId('usr', id) ? id : null;
}
