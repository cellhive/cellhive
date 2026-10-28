import { newId, type Id } from '@cellhive/contracts';

import { GlobalRepository } from '../repository.js';

import type { Db, Tx } from '../create-db.js';
import type { User } from '../schema.js';

export interface CreateUserInput {
  readonly id?: Id<'usr'>;
  readonly email: string;
  readonly displayName: string;
  /** argon2id PHC string; `null` = no password yet (CLI setup) or OIDC only. */
  readonly passwordHash: string | null;
  /** `null` = use the organization default. */
  readonly locale?: string | null;
  /** `null` = use the organization default. */
  readonly timezone?: string | null;
}

/**
 * `meta.users` (global table, SPEC §5.10). Emails are `citext`: lookups and
 * uniqueness ignore case.
 */
export class UsersRepository extends GlobalRepository<'users'> {
  constructor(db: Db) {
    super(db, 'users');
  }

  /** Whether any user exists (first-time setup, SPEC §14.1A). */
  async hasAny(tx?: Tx): Promise<boolean> {
    const row = await this.executor(tx)
      .selectFrom('meta.users')
      .select('id')
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async findById(id: Id<'usr'>, tx?: Tx): Promise<User | undefined> {
    return this.executor(tx)
      .selectFrom('meta.users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /**
   * The user, row-locked until the end of `tx`: serialises changes to the
   * sign-in methods of one account (linking and unlinking identities).
   */
  async lockById(id: Id<'usr'>, tx: Tx): Promise<User | undefined> {
    return tx
      .selectFrom('meta.users')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  async findByEmail(email: string, tx?: Tx): Promise<User | undefined> {
    return this.executor(tx)
      .selectFrom('meta.users')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();
  }

  async create(input: CreateUserInput, tx?: Tx): Promise<User> {
    return this.executor(tx)
      .insertInto('meta.users')
      .values({
        id: input.id ?? newId('usr'),
        email: input.email,
        display_name: input.displayName,
        password_hash: input.passwordHash,
        locale: input.locale ?? null,
        timezone: input.timezone ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Replaces the password hash; `false` when the user does not exist. */
  async setPasswordHash(id: Id<'usr'>, passwordHash: string, tx?: Tx): Promise<boolean> {
    const result = await this.executor(tx)
      .updateTable('meta.users')
      .set({ password_hash: passwordHash })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Sets the given profile keys; `undefined` when the user does not exist. */
  async updateProfile(
    id: Id<'usr'>,
    changes: {
      readonly display_name?: string;
      readonly locale?: string;
      readonly timezone?: string;
    },
    tx?: Tx,
  ): Promise<User | undefined> {
    return this.executor(tx)
      .updateTable('meta.users')
      .set(changes)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /** Whether the user signs in through an external identity provider (OIDC). */
  async hasExternalIdentity(id: Id<'usr'>, tx?: Tx): Promise<boolean> {
    const row = await this.executor(tx)
      .selectFrom('meta.user_identities')
      .select('id')
      .where('user_id', '=', id)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }
}
