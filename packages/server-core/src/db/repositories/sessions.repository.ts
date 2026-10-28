import { newId, type Id } from '@cellhive/contracts';

import { GlobalRepository } from '../repository.js';

import type { Db, Tx } from '../create-db.js';
import type { Session, User } from '../schema.js';

export interface CreateSessionInput {
  readonly id?: Id<'ses'>;
  readonly userId: Id<'usr'>;
  /** SHA-256 of the session token (hex). The token itself is never stored. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** A live session with its (active) user. */
export interface ActiveSession {
  readonly session: Session;
  readonly user: User;
}

/** Longest `user_agent` stored for a session; longer values are cut. */
export const MAX_SESSION_USER_AGENT_LENGTH = 512;

/** `meta.sessions` (global table, SPEC §5.10). */
export class SessionsRepository extends GlobalRepository<'sessions'> {
  constructor(db: Db) {
    super(db, 'sessions');
  }

  async create(input: CreateSessionInput, tx?: Tx): Promise<Session> {
    return this.executor(tx)
      .insertInto('meta.sessions')
      .values({
        id: input.id ?? newId('ses'),
        user_id: input.userId,
        token_hash: input.tokenHash,
        expires_at: input.expiresAt,
        ip: input.ip,
        user_agent:
          input.userAgent === null ? null : input.userAgent.slice(0, MAX_SESSION_USER_AGENT_LENGTH),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * The unexpired session with this token hash, provided its user is active;
   * `undefined` otherwise.
   */
  async findActiveByTokenHash(tokenHash: string, tx?: Tx): Promise<ActiveSession | undefined> {
    const row = await this.executor(tx)
      .selectFrom('meta.sessions as s')
      .innerJoin('meta.users as u', 'u.id', 's.user_id')
      .selectAll('s')
      .select([
        'u.email as u_email',
        'u.display_name as u_display_name',
        'u.avatar_url as u_avatar_url',
        'u.password_hash as u_password_hash',
        'u.status as u_status',
        'u.locale as u_locale',
        'u.timezone as u_timezone',
        'u.created_at as u_created_at',
        'u.updated_at as u_updated_at',
      ])
      .where('s.token_hash', '=', tokenHash)
      .where('s.expires_at', '>', new Date())
      .where('u.status', '=', 'active')
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const {
      u_email: email,
      u_display_name: displayName,
      u_avatar_url: avatarUrl,
      u_password_hash: passwordHash,
      u_status: status,
      u_locale: locale,
      u_timezone: timezone,
      u_created_at: userCreatedAt,
      u_updated_at: userUpdatedAt,
      ...session
    } = row;
    return {
      session,
      user: {
        id: session.user_id,
        email,
        display_name: displayName,
        avatar_url: avatarUrl,
        password_hash: passwordHash,
        status,
        locale,
        timezone,
        created_at: userCreatedAt,
        updated_at: userUpdatedAt,
      },
    };
  }

  /** Records activity and slides the expiry. */
  async touch(id: Id<'ses'>, expiresAt: Date, tx?: Tx): Promise<void> {
    await this.executor(tx)
      .updateTable('meta.sessions')
      .set({ last_seen_at: new Date(), expires_at: expiresAt })
      .where('id', '=', id)
      .execute();
  }

  /** Deletes one session; `true` when it existed. */
  async deleteById(id: Id<'ses'>, tx?: Tx): Promise<boolean> {
    const result = await this.executor(tx)
      .deleteFrom('meta.sessions')
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Revokes every session of a user; returns how many were deleted. */
  async deleteByUserId(userId: Id<'usr'>, tx?: Tx): Promise<number> {
    const result = await this.executor(tx)
      .deleteFrom('meta.sessions')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** Revokes every session of a user but `keep`; returns the ids deleted. */
  async deleteOthersOfUser(userId: Id<'usr'>, keep: Id<'ses'>, tx?: Tx): Promise<Id<'ses'>[]> {
    const rows = await this.executor(tx)
      .deleteFrom('meta.sessions')
      .where('user_id', '=', userId)
      .where('id', '!=', keep)
      .returning('id')
      .execute();
    return rows.map((row) => row.id);
  }

  /** Removes sessions that expired before `before`; returns how many. */
  async deleteExpired(before: Date, tx?: Tx): Promise<number> {
    const result = await this.executor(tx)
      .deleteFrom('meta.sessions')
      .where('expires_at', '<=', before)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
