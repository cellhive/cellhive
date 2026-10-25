import { newId, type Id } from '@cellhive/contracts';
import { sql, type ExpressionBuilder } from 'kysely';

import { countOf, type Page, type PageRequest } from '../page.js';
import { TenantRepository, type OrgScope, type TenantRepositoryContract } from '../repository.js';

import type { Db } from '../create-db.js';
import type { Database, Invitation, InvitableOrgRole } from '../schema.js';

export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

/** The state of an invitation at `now`. */
export function invitationStateOf(
  invitation: Pick<Invitation, 'accepted_at' | 'revoked_at' | 'expires_at'>,
  now: Date = new Date(),
): InvitationState {
  if (invitation.accepted_at !== null) return 'accepted';
  if (invitation.revoked_at !== null) return 'revoked';
  if (invitation.expires_at.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

export interface CreateInvitationInput {
  readonly id?: Id<'inv'>;
  readonly email: string;
  readonly inviterId: Id<'usr'>;
  readonly orgRole: InvitableOrgRole;
  readonly workspaceId: Id<'wsp'> | null;
  /** SHA-256 of the token; the token itself is never stored. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

function stateCondition(
  eb: ExpressionBuilder<Database, 'meta.invitations'>,
  state: InvitationState,
) {
  switch (state) {
    case 'accepted':
      return eb('accepted_at', 'is not', null);
    case 'revoked':
      return eb.and([eb('accepted_at', 'is', null), eb('revoked_at', 'is not', null)]);
    case 'expired':
      return eb.and([
        eb('accepted_at', 'is', null),
        eb('revoked_at', 'is', null),
        eb('expires_at', '<=', sql<Date>`now()`),
      ]);
    case 'pending':
      return eb.and([
        eb('accepted_at', 'is', null),
        eb('revoked_at', 'is', null),
        eb('expires_at', '>', sql<Date>`now()`),
      ]);
  }
}

/**
 * `meta.invitations`. Every query is scoped by `organization_id`; an
 * invitation of another organization behaves exactly like a missing one.
 */
export class InvitationsRepository
  extends TenantRepository<'invitations'>
  implements TenantRepositoryContract<InvitationsRepository>
{
  constructor(db: Db) {
    super(db, 'invitations');
  }

  async create(scope: OrgScope, input: CreateInvitationInput): Promise<Invitation> {
    return this.executor(scope)
      .insertInto('meta.invitations')
      .values({
        id: input.id ?? newId('inv'),
        organization_id: scope.organizationId,
        email: input.email,
        inviter_id: input.inviterId,
        org_role: input.orgRole,
        workspace_id: input.workspaceId,
        token_hash: input.tokenHash,
        expires_at: input.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async getById(scope: OrgScope, id: Id<'inv'>): Promise<Invitation | undefined> {
    return this.executor(scope)
      .selectFrom('meta.invitations')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** The invitation with this token hash, locked `FOR UPDATE` when the scope has a transaction. */
  async findByTokenHash(
    scope: OrgScope,
    tokenHash: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<Invitation | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.invitations')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('token_hash', '=', tokenHash);
    if (options.forUpdate === true) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  /** One page of invitations, newest first, optionally in one state. */
  async list(
    scope: OrgScope,
    page: PageRequest,
    state?: InvitationState,
  ): Promise<Page<Invitation>> {
    const filtered = () => {
      let query = this.executor(scope)
        .selectFrom('meta.invitations')
        .where('organization_id', '=', scope.organizationId);
      if (state !== undefined) query = query.where((eb) => stateCondition(eb, state));
      return query;
    };
    const items = await filtered()
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .offset(page.offset)
      .limit(page.limit)
      .execute();
    const total = await filtered()
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirst();
    return { items, total: countOf(total) };
  }

  /** Marks a pending invitation accepted; `undefined` when it is not pending. */
  async markAccepted(scope: OrgScope, id: Id<'inv'>): Promise<Invitation | undefined> {
    return this.executor(scope)
      .updateTable('meta.invitations')
      .set({ accepted_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where((eb) => stateCondition(eb, 'pending'))
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Revokes every pending invitation created by `inviterId` (the inviter
   * left the organization or lost the right to invite). Returns the
   * revoked rows.
   */
  async revokePendingByInviter(scope: OrgScope, inviterId: Id<'usr'>): Promise<Invitation[]> {
    return this.executor(scope)
      .updateTable('meta.invitations')
      .set({ revoked_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('inviter_id', '=', inviterId)
      .where((eb) => stateCondition(eb, 'pending'))
      .returningAll()
      .execute();
  }

  /** Revokes a pending invitation; `undefined` when it is not pending. */
  async revoke(scope: OrgScope, id: Id<'inv'>): Promise<Invitation | undefined> {
    return this.executor(scope)
      .updateTable('meta.invitations')
      .set({ revoked_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where((eb) => stateCondition(eb, 'pending'))
      .returningAll()
      .executeTakeFirst();
  }
}
