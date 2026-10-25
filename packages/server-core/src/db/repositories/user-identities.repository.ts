import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';

import { GlobalRepository } from '../repository.js';

import type { Db, Tx } from '../create-db.js';
import type { UserIdentity } from '../schema.js';

export interface CreateUserIdentityInput {
  readonly id?: Id<'idn'>;
  readonly userId: Id<'usr'>;
  /** Provider slug (`OIDC_PROVIDERS`). */
  readonly provider: string;
  /** `sub` claim of the provider. */
  readonly subject: string;
  /** Email reported by the provider (display only); `null` when it sent none. */
  readonly email: string | null;
  /** `true` sets `last_login_at = now()` (the identity is created by a sign-in). */
  readonly signedIn?: boolean;
}

/**
 * `meta.user_identities` (global table, SPEC §5.10): external sign-in
 * identities (OIDC, ADR-36 §3). An identity is `(provider, subject)`; the
 * email is kept for display only and never used to find one.
 */
export class UserIdentitiesRepository extends GlobalRepository<'user_identities'> {
  constructor(db: Db) {
    super(db, 'user_identities');
  }

  async findByProviderSubject(
    provider: string,
    subject: string,
    tx?: Tx,
  ): Promise<UserIdentity | undefined> {
    return this.executor(tx)
      .selectFrom('meta.user_identities')
      .selectAll()
      .where('provider', '=', provider)
      .where('subject', '=', subject)
      .executeTakeFirst();
  }

  /** Identities of a user, oldest first. */
  async listByUser(userId: Id<'usr'>, tx?: Tx): Promise<UserIdentity[]> {
    return this.executor(tx)
      .selectFrom('meta.user_identities')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  async create(input: CreateUserIdentityInput, tx?: Tx): Promise<UserIdentity> {
    return this.executor(tx)
      .insertInto('meta.user_identities')
      .values({
        id: input.id ?? newId('idn'),
        user_id: input.userId,
        provider: input.provider,
        subject: input.subject,
        email: input.email,
        last_login_at: input.signedIn === true ? sql<Date>`now()` : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Records a sign-in through the identity: `last_login_at = now()` and the
   * email the provider reported this time (kept when it sent none).
   */
  async recordLogin(id: Id<'idn'>, email: string | null, tx?: Tx): Promise<void> {
    await this.executor(tx)
      .updateTable('meta.user_identities')
      .set({
        last_login_at: sql<Date>`now()`,
        ...(email === null ? {} : { email }),
      })
      .where('id', '=', id)
      .execute();
  }
  /** One identity of a user; `undefined` when it does not exist or belongs to someone else. */
  async findOfUser(userId: Id<'usr'>, id: Id<'idn'>, tx?: Tx): Promise<UserIdentity | undefined> {
    return this.executor(tx)
      .selectFrom('meta.user_identities')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }

  /** Removes an identity of a user; `false` when it does not exist or belongs to someone else. */
  async deleteOfUser(userId: Id<'usr'>, id: Id<'idn'>, tx?: Tx): Promise<boolean> {
    const result = await this.executor(tx)
      .deleteFrom('meta.user_identities')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** The email the provider reported when the identity was linked again (kept when it sent none). */
  async refreshEmail(id: Id<'idn'>, email: string | null, tx?: Tx): Promise<void> {
    if (email === null) return;
    await this.executor(tx)
      .updateTable('meta.user_identities')
      .set({ email })
      .where('id', '=', id)
      .execute();
  }
}
