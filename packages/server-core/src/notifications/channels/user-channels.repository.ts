import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { UserChannelRow } from '../../db/schema.js';
import type { Id, UserChannelErrorReason, UserChannelKind } from '@cellhive/contracts';

/** What a `/start` writes: the sealed chat and its lookup HMAC, never the chat id itself. */
export interface LinkedUserChannel {
  readonly id: Id<'uch'>;
  readonly userId: Id<'usr'>;
  readonly kind: UserChannelKind;
  readonly secretId: Id<'sec'>;
  readonly addressEnc: string;
  readonly addressHmac: string;
  readonly linkedAt: Date;
}

/** A channel's identity and state, without its sealed address. */
export type UserChannelState = Pick<
  UserChannelRow,
  'id' | 'user_id' | 'kind' | 'secret_id' | 'status' | 'error_reason' | 'linked_at'
>;

const STATE_COLUMNS = [
  'id',
  'user_id',
  'kind',
  'secret_id',
  'status',
  'error_reason',
  'linked_at',
] as const;

/**
 * `meta.user_channels` (BACKLOG T549, ADR-34 §3): personal notification
 * channels, one per (member, kind) in an organization. Every query is
 * scoped by `organization_id`. Reads of state never select `address_enc`;
 * only {@link findLinked} (the Telegram delivery, T550) does.
 */
export class UserChannelsRepository
  extends TenantRepository<'user_channels'>
  implements TenantRepositoryContract<UserChannelsRepository>
{
  constructor(db: Db) {
    super(db, 'user_channels');
  }

  /** The caller's channels (state only), by kind. */
  async listForUser(scope: OrgScope, userId: Id<'usr'>): Promise<UserChannelState[]> {
    return this.executor(scope)
      .selectFrom('meta.user_channels')
      .select(STATE_COLUMNS)
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .orderBy('kind')
      .execute();
  }

  /** The channel of `kind` with its sealed address when it is `linked`. */
  async findLinked(
    scope: OrgScope,
    userId: Id<'usr'>,
    kind: UserChannelKind,
  ): Promise<UserChannelRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.user_channels')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .where('kind', '=', kind)
      .where('status', '=', 'linked')
      .executeTakeFirst();
  }

  /**
   * Of `userIds`, the members whose channel of `kind` is `linked` through
   * the bot `secretId` (T550: who gets a Telegram delivery queued).
   */
  async linkedUsers(
    scope: OrgScope,
    userIds: readonly Id<'usr'>[],
    kind: UserChannelKind,
    secretId: Id<'sec'>,
  ): Promise<Set<Id<'usr'>>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.executor(scope)
      .selectFrom('meta.user_channels')
      .select('user_id')
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', 'in', [...userIds])
      .where('kind', '=', kind)
      .where('secret_id', '=', secretId)
      .where('status', '=', 'linked')
      .execute();
    return new Set(rows.map((row) => row.user_id));
  }

  /**
   * Links (or links again) the member's channel of `kind`: a new link
   * replaces the previous chat, bot and state (ADR-34 §3).
   */
  async upsertLinked(scope: OrgScope, channel: LinkedUserChannel): Promise<UserChannelState> {
    return this.executor(scope)
      .insertInto('meta.user_channels')
      .values({
        id: channel.id,
        organization_id: scope.organizationId,
        user_id: channel.userId,
        kind: channel.kind,
        secret_id: channel.secretId,
        address_enc: channel.addressEnc,
        address_hmac: channel.addressHmac,
        status: 'linked',
        error_reason: null,
        linked_at: channel.linkedAt,
      })
      .onConflict((oc) =>
        oc.constraint('user_channels_member_kind_key').doUpdateSet({
          secret_id: channel.secretId,
          address_enc: channel.addressEnc,
          address_hmac: channel.addressHmac,
          status: 'linked',
          error_reason: null,
          linked_at: channel.linkedAt,
        }),
      )
      .returning(STATE_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** Removes the member's channel of `kind`; the removed state, if there was one. */
  async deleteForUser(
    scope: OrgScope,
    userId: Id<'usr'>,
    kind: UserChannelKind,
  ): Promise<UserChannelState | undefined> {
    return this.executor(scope)
      .deleteFrom('meta.user_channels')
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .where('kind', '=', kind)
      .returning(STATE_COLUMNS)
      .executeTakeFirst();
  }

  /** Removes the channels linked to one chat of one bot (`/stop`); the removed states. */
  async deleteByAddress(
    scope: OrgScope,
    secretId: Id<'sec'>,
    addressHmac: string,
  ): Promise<UserChannelState[]> {
    return this.executor(scope)
      .deleteFrom('meta.user_channels')
      .where('organization_id', '=', scope.organizationId)
      .where('secret_id', '=', secretId)
      .where('address_hmac', '=', addressHmac)
      .returning(STATE_COLUMNS)
      .execute();
  }

  /** Whether the member's channel of `kind` is linked to this chat of this bot. */
  async isLinkedTo(
    scope: OrgScope,
    userId: Id<'usr'>,
    kind: UserChannelKind,
    secretId: Id<'sec'>,
    addressHmac: string,
  ): Promise<boolean> {
    const row = await this.executor(scope)
      .selectFrom('meta.user_channels')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .where('kind', '=', kind)
      .where('secret_id', '=', secretId)
      .where('address_hmac', '=', addressHmac)
      .where('status', '=', 'linked')
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Puts every channel of `kind` of the organization in `error` with
   * `reason`, except those already in that state; returns the members whose
   * channel changed (to tell them in realtime).
   */
  async markAllError(
    scope: OrgScope,
    kind: UserChannelKind,
    reason: UserChannelErrorReason,
  ): Promise<Id<'usr'>[]> {
    const rows = await this.executor(scope)
      .updateTable('meta.user_channels')
      .set({ status: 'error', error_reason: reason })
      .where('organization_id', '=', scope.organizationId)
      .where('kind', '=', kind)
      .where((eb) =>
        eb.or([eb('status', '=', 'linked'), eb('error_reason', 'is distinct from', reason)]),
      )
      .returning('user_id')
      .execute();
    return rows.map((row) => row.user_id).sort();
  }

  /** Puts one member's channel of `kind` in `error` (T550: Telegram refused the chat). */
  async markError(
    scope: OrgScope,
    userId: Id<'usr'>,
    kind: UserChannelKind,
    reason: UserChannelErrorReason,
  ): Promise<boolean> {
    const result = await this.executor(scope)
      .updateTable('meta.user_channels')
      .set({ status: 'error', error_reason: reason })
      .where('organization_id', '=', scope.organizationId)
      .where('user_id', '=', userId)
      .where('kind', '=', kind)
      .where('status', '=', 'linked')
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
