import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';

import { listMembershipsOfUser, type UserMembership } from '../cross-tenant-lookups.js';
import { GlobalRepository } from '../repository.js';

import type { Db, Tx } from '../create-db.js';
import type { JsonObject, Organization } from '../schema.js';

export interface CreateOrganizationInput {
  readonly id?: Id<'org'>;
  readonly name: string;
  readonly slug: string;
  readonly settings?: JsonObject;
}

export interface UpdateOrganizationInput {
  readonly name?: string;
  readonly settings?: JsonObject;
}

/** `meta.organizations` (global table, SPEC §5.10). */
export class OrganizationsRepository extends GlobalRepository<'organizations'> {
  constructor(db: Db) {
    super(db, 'organizations');
  }

  async create(input: CreateOrganizationInput, tx?: Tx): Promise<Organization> {
    return this.executor(tx)
      .insertInto('meta.organizations')
      .values({
        id: input.id ?? newId('org'),
        name: input.name,
        slug: input.slug,
        ...(input.settings === undefined ? {} : { settings: input.settings }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(id: Id<'org'>, tx?: Tx): Promise<Organization | undefined> {
    return this.executor(tx)
      .selectFrom('meta.organizations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** By slug (`OIDC_<SLUG>_AUTO_JOIN_ORG`, ADR-36 §3). */
  async findBySlug(slug: string, tx?: Tx): Promise<Organization | undefined> {
    return this.executor(tx)
      .selectFrom('meta.organizations')
      .selectAll()
      .where('slug', '=', slug)
      .executeTakeFirst();
  }

  /** The organization locked `FOR UPDATE` until `tx` ends (read-modify-write of `settings`). */
  async lockById(id: Id<'org'>, tx: Tx): Promise<Organization | undefined> {
    return tx
      .selectFrom('meta.organizations')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Renames or replaces the settings; `undefined` when not found. */
  async update(
    id: Id<'org'>,
    patch: UpdateOrganizationInput,
    tx?: Tx,
  ): Promise<Organization | undefined> {
    const values = {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.settings === undefined ? {} : { settings: patch.settings }),
    };
    if (Object.keys(values).length === 0) return this.findById(id, tx);
    return this.executor(tx)
      .updateTable('meta.organizations')
      .set(values)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  async slugExists(slug: string, tx?: Tx): Promise<boolean> {
    const row = await this.executor(tx)
      .selectFrom('meta.organizations')
      .select('id')
      .where('slug', '=', slug)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Whether an organization other than `exceptId` has the Telegram bot
   * `botId` as its notification bot (`settings.notifications.telegram_bot_id`,
   * ADR-34 §3, QA S5b M3). A yes/no only — never which organization: the
   * caller holds the bot's token, which already proves it may know that the
   * bot is busy.
   */
  async hasOtherWithNotificationBot(botId: number, exceptId: Id<'org'>, tx?: Tx): Promise<boolean> {
    const row = await this.executor(tx)
      .selectFrom('meta.organizations')
      .select('id')
      .where('id', '<>', exceptId)
      .where(sql<string>`settings #>> '{notifications,telegram_bot_id}'`, '=', String(botId))
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Every organization `userId` belongs to, oldest membership first. The
   * query crosses tenants, so it lives in `cross-tenant-lookups.ts` (see
   * the allowed uses there); this method only delegates to it.
   */
  listMembershipsOfUser(userId: Id<'usr'>, tx?: Tx): Promise<UserMembership[]> {
    return listMembershipsOfUser(this.executor(tx), userId);
  }
}
