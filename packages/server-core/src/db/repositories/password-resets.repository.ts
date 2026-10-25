import { newId, type Id } from '@cellhive/contracts';

import { GlobalRepository } from '../repository.js';

import type { Db, Tx } from '../create-db.js';
import type { PasswordReset, PasswordResetSource } from '../schema.js';

export interface CreatePasswordResetInput {
  readonly id?: Id<'pwr'>;
  readonly userId: Id<'usr'>;
  /** SHA-256 of the reset token (hex). The token itself is never stored. */
  readonly tokenHash: string;
  readonly source: PasswordResetSource;
  /** The admin who created the link (`source = 'admin'`); else `null`. */
  readonly createdBy: Id<'usr'> | null;
  readonly expiresAt: Date;
}

/** `meta.password_resets` (global table, SPEC §5.10, §14.2). */
export class PasswordResetsRepository extends GlobalRepository<'password_resets'> {
  constructor(db: Db) {
    super(db, 'password_resets');
  }

  async create(input: CreatePasswordResetInput, tx?: Tx): Promise<PasswordReset> {
    return this.executor(tx)
      .insertInto('meta.password_resets')
      .values({
        id: input.id ?? newId('pwr'),
        user_id: input.userId,
        token_hash: input.tokenHash,
        created_by: input.createdBy,
        source: input.source,
        expires_at: input.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * The unused, unexpired reset with this token hash, locked `FOR UPDATE`
   * so that two concurrent redemptions cannot both succeed. Must run in `tx`.
   */
  async findUsableForUpdate(tokenHash: string, tx: Tx): Promise<PasswordReset | undefined> {
    return tx
      .selectFrom('meta.password_resets')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .where('used_at', 'is', null)
      .where('expires_at', '>', new Date())
      .forUpdate()
      .executeTakeFirst();
  }

  async markUsed(id: Id<'pwr'>, tx?: Tx): Promise<void> {
    await this.executor(tx)
      .updateTable('meta.password_resets')
      .set({ used_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Deletes the user's links that were never used, so only the newest link
   * works. Used links stay as a record of the reset. With `source`, only
   * the unused links of that source are deleted.
   */
  async deleteUnusedForUser(
    userId: Id<'usr'>,
    tx?: Tx,
    options: { readonly source?: PasswordResetSource } = {},
  ): Promise<number> {
    let query = this.executor(tx)
      .deleteFrom('meta.password_resets')
      .where('user_id', '=', userId)
      .where('used_at', 'is', null);
    if (options.source !== undefined) query = query.where('source', '=', options.source);
    const result = await query.executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
