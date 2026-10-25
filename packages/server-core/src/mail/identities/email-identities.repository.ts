import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { EmailIdentitiesTable, EmailIdentityRow } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';
import type { Insertable, Updateable } from 'kysely';

export type NewEmailIdentity = Omit<
  Insertable<EmailIdentitiesTable>,
  'organization_id' | 'created_at' | 'updated_at'
>;

export type EmailIdentityPatch = Omit<
  Updateable<EmailIdentitiesTable>,
  'id' | 'organization_id' | 'created_by' | 'created_at' | 'updated_at'
>;

/** Result of counting an authentication failure while sending. */
export interface AuthFailureResult {
  readonly identity: EmailIdentityRow;
  /** The identity has just moved from `verified` to `error`. */
  readonly becameError: boolean;
}

/**
 * `meta.email_identities` and its base scope `meta.email_identity_bases`
 * (T530). Every query is scoped by `organization_id`: an identity of
 * another organization behaves exactly like a missing one.
 */
export class EmailIdentitiesRepository
  extends TenantRepository<'email_identities'>
  implements TenantRepositoryContract<EmailIdentitiesRepository>
{
  constructor(db: Db) {
    super(db, 'email_identities');
  }

  async create(scope: OrgScope, input: NewEmailIdentity): Promise<EmailIdentityRow> {
    return this.executor(scope)
      .insertInto('meta.email_identities')
      .values({ ...input, organization_id: scope.organizationId })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(
    scope: OrgScope,
    id: Id<'eid'>,
    options: { forUpdate?: boolean } = {},
  ): Promise<EmailIdentityRow | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.email_identities')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id);
    if (options.forUpdate === true) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  /** The identity with this (lower-case) address, if any. */
  async findByEmail(scope: OrgScope, email: string): Promise<EmailIdentityRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.email_identities')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('email', '=', email)
      .executeTakeFirst();
  }

  /** Every identity of the organization, by address. */
  async list(scope: OrgScope): Promise<EmailIdentityRow[]> {
    return this.executor(scope)
      .selectFrom('meta.email_identities')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .orderBy('email')
      .execute();
  }

  async count(scope: OrgScope): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.email_identities')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async update(
    scope: OrgScope,
    id: Id<'eid'>,
    patch: EmailIdentityPatch,
  ): Promise<EmailIdentityRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.email_identities')
      .set(patch)
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  async delete(scope: OrgScope, id: Id<'eid'>): Promise<boolean> {
    const result = await this.executor(scope)
      .deleteFrom('meta.email_identities')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Bases of the `selected` scope of each identity (identities without bases are absent). */
  async baseIdsOf(
    scope: OrgScope,
    identityIds: readonly Id<'eid'>[],
  ): Promise<Map<Id<'eid'>, Id<'bse'>[]>> {
    const result = new Map<Id<'eid'>, Id<'bse'>[]>();
    if (identityIds.length === 0) return result;
    const rows = await this.executor(scope)
      .selectFrom('meta.email_identity_bases')
      .select(['identity_id', 'base_id'])
      .where('organization_id', '=', scope.organizationId)
      .where('identity_id', 'in', [...identityIds])
      .orderBy('base_id')
      .execute();
    for (const row of rows) {
      const list = result.get(row.identity_id) ?? [];
      list.push(row.base_id);
      result.set(row.identity_id, list);
    }
    return result;
  }

  /** Replaces the bases of the scope of `identityId`. */
  async replaceBases(
    scope: OrgScope,
    identityId: Id<'eid'>,
    baseIds: readonly Id<'bse'>[],
  ): Promise<void> {
    const executor = this.executor(scope);
    await executor
      .deleteFrom('meta.email_identity_bases')
      .where('organization_id', '=', scope.organizationId)
      .where('identity_id', '=', identityId)
      .execute();
    if (baseIds.length === 0) return;
    await executor
      .insertInto('meta.email_identity_bases')
      .values(
        [...new Set(baseIds)].map((baseId) => ({
          organization_id: scope.organizationId,
          identity_id: identityId,
          base_id: baseId,
        })),
      )
      .execute();
  }

  /** The bases among `baseIds` that exist in the organization outside the trash. */
  async existingBaseIds(scope: OrgScope, baseIds: readonly Id<'bse'>[]): Promise<Set<Id<'bse'>>> {
    if (baseIds.length === 0) return new Set();
    const rows = await this.executor(scope)
      .selectFrom('meta.bases')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...baseIds])
      .where('deleted_at', 'is', null)
      .execute();
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Identities an automation of `baseId` may send as (ADR-33 §1): verified
   * (hence not disabled) and with the base in their scope. By address.
   */
  async listUsableInBase(scope: OrgScope, baseId: Id<'bse'>): Promise<EmailIdentityRow[]> {
    return this.executor(scope)
      .selectFrom('meta.email_identities as i')
      .selectAll('i')
      .where('i.organization_id', '=', scope.organizationId)
      .where('i.status', '=', 'verified')
      .where((eb) =>
        eb.or([
          eb('i.base_scope', '=', 'all'),
          eb.exists(
            eb
              .selectFrom('meta.email_identity_bases as b')
              .select(sql`1`.as('one'))
              .where('b.organization_id', '=', scope.organizationId)
              .whereRef('b.identity_id', '=', 'i.id')
              .where('b.base_id', '=', baseId),
          ),
        ]),
      )
      .orderBy('i.email')
      .execute();
  }

  /** The identity when an automation of `baseId` may send as it, else `undefined`. */
  async findUsable(
    scope: OrgScope,
    id: Id<'eid'>,
    baseId: Id<'bse'>,
  ): Promise<EmailIdentityRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.email_identities as i')
      .selectAll('i')
      .where('i.organization_id', '=', scope.organizationId)
      .where('i.id', '=', id)
      .where('i.status', '=', 'verified')
      .where((eb) =>
        eb.or([
          eb('i.base_scope', '=', 'all'),
          eb.exists(
            eb
              .selectFrom('meta.email_identity_bases as b')
              .select(sql`1`.as('one'))
              .where('b.organization_id', '=', scope.organizationId)
              .whereRef('b.identity_id', '=', 'i.id')
              .where('b.base_id', '=', baseId),
          ),
        ]),
      )
      .executeTakeFirst();
  }

  /**
   * Counts one authentication failure of the SMTP of `id` while sending
   * with configuration `version` (a failure of credentials that were
   * changed since is ignored). At `threshold` consecutive failures a
   * `verified` identity moves to `error` (`auth_failed`) atomically.
   */
  async recordAuthFailure(
    scope: OrgScope,
    id: Id<'eid'>,
    version: number,
    threshold: number,
  ): Promise<AuthFailureResult | undefined> {
    // One statement: concurrent failures each count once and only the one
    // reaching `threshold` sees the transition (an identity only enters
    // `error` here, and leaves it with its counter reset).
    const toError = sql<boolean>`(status = 'verified' AND auth_failures + 1 >= ${threshold})`;
    const identity = await this.executor(scope)
      .updateTable('meta.email_identities')
      .set({
        auth_failures: sql<number>`auth_failures + 1`,
        status: sql<EmailIdentityRow['status']>`CASE WHEN ${toError} THEN 'error' ELSE status END`,
        error_reason: sql<
          EmailIdentityRow['error_reason']
        >`CASE WHEN ${toError} THEN 'auth_failed' ELSE error_reason END`,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('transport', '=', 'smtp')
      .where('smtp_version', '=', version)
      .returningAll()
      .executeTakeFirst();
    if (identity === undefined) return undefined;
    return {
      identity,
      becameError:
        identity.status === 'error' &&
        identity.error_reason === 'auth_failed' &&
        identity.auth_failures === threshold,
    };
  }

  /** A message went through: the consecutive failure count starts again. */
  async resetAuthFailures(scope: OrgScope, id: Id<'eid'>): Promise<void> {
    await this.executor(scope)
      .updateTable('meta.email_identities')
      .set({ auth_failures: 0 })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('auth_failures', '>', 0)
      .execute();
  }
}
