import {
  BASE_SECRET_KINDS,
  type BaseSecretKind,
  type Id,
  type SecretKind,
} from '@cellhive/contracts';
import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { SecretRow, SecretsTable } from '../db/schema.js';
import type { Insertable, Updateable } from 'kysely';

export type NewSecret = Omit<
  Insertable<SecretsTable>,
  'organization_id' | 'created_at' | 'updated_at'
>;

export type SecretPatch = Omit<
  Updateable<SecretsTable>,
  'id' | 'organization_id' | 'kind' | 'created_by' | 'created_at' | 'updated_at'
>;

/** A secret row with the name of who created it (`null` when that account is gone). */
export type SecretListRow = Omit<SecretRow, 'ciphertext' | 'previous_ciphertext'> & {
  readonly created_by_name: string | null;
};

/**
 * `meta.secrets` and its base scope `meta.secret_bases` (BACKLOG T516;
 * HTTP kinds and the previous value of a replaced signing secret, T606).
 * Every query is scoped by `organization_id`: a secret of another
 * organization behaves exactly like a missing one. Reads of the list never
 * select `ciphertext`; only {@link findUsable} (the action at run time)
 * and {@link findById} do.
 */
export class SecretsRepository
  extends TenantRepository<'secrets'>
  implements TenantRepositoryContract<SecretsRepository>
{
  constructor(db: Db) {
    super(db, 'secrets');
  }

  async create(scope: OrgScope, input: NewSecret): Promise<SecretRow> {
    return this.executor(scope)
      .insertInto('meta.secrets')
      .values({ ...input, organization_id: scope.organizationId })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(
    scope: OrgScope,
    id: Id<'sec'>,
    options: { forUpdate?: boolean } = {},
  ): Promise<SecretRow | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.secrets')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id);
    if (options.forUpdate === true) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  /** Every secret of the organization by name, with its creator's name (never the value). */
  async list(scope: OrgScope): Promise<SecretListRow[]> {
    const rows: SecretListRow[] = await this.executor(scope)
      .selectFrom('meta.secrets as s')
      .leftJoin('meta.users as u', 'u.id', 's.created_by')
      .select([
        's.id',
        's.organization_id',
        's.kind',
        's.name',
        's.base_scope',
        's.previous_expires_at',
        's.allowed_hosts',
        's.legacy_hosts_until',
        's.created_by',
        's.created_at',
        's.updated_at',
        'u.display_name as created_by_name',
      ])
      .where('s.organization_id', '=', scope.organizationId)
      .orderBy(sql`lower(s.name)`)
      .orderBy('s.id')
      .execute();
    // Neither `ciphertext` nor `previous_ciphertext` is read: the list carries no value at all.
    return rows;
  }

  async count(scope: OrgScope): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.secrets')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async update(scope: OrgScope, id: Id<'sec'>, patch: SecretPatch): Promise<SecretRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.secrets')
      .set(patch)
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  async delete(scope: OrgScope, id: Id<'sec'>): Promise<boolean> {
    const result = await this.executor(scope)
      .deleteFrom('meta.secrets')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Bases of the `selected` scope of each secret (secrets without bases are absent). */
  async baseIdsOf(
    scope: OrgScope,
    secretIds: readonly Id<'sec'>[],
  ): Promise<Map<Id<'sec'>, Id<'bse'>[]>> {
    const result = new Map<Id<'sec'>, Id<'bse'>[]>();
    if (secretIds.length === 0) return result;
    const rows = await this.executor(scope)
      .selectFrom('meta.secret_bases')
      .select(['secret_id', 'base_id'])
      .where('organization_id', '=', scope.organizationId)
      .where('secret_id', 'in', [...secretIds])
      .orderBy('base_id')
      .execute();
    for (const row of rows) {
      const list = result.get(row.secret_id) ?? [];
      list.push(row.base_id);
      result.set(row.secret_id, list);
    }
    return result;
  }

  /** Replaces the bases of the scope of `secretId`. */
  async replaceBases(
    scope: OrgScope,
    secretId: Id<'sec'>,
    baseIds: readonly Id<'bse'>[],
  ): Promise<void> {
    const executor = this.executor(scope);
    await executor
      .deleteFrom('meta.secret_bases')
      .where('organization_id', '=', scope.organizationId)
      .where('secret_id', '=', secretId)
      .execute();
    if (baseIds.length === 0) return;
    await executor
      .insertInto('meta.secret_bases')
      .values(
        [...new Set(baseIds)].map((baseId) => ({
          organization_id: scope.organizationId,
          secret_id: secretId,
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
   * Secrets an automation of `baseId` may use (scope `all`, or the base
   * selected), by name — never the AI key (T906: the AI settings only).
   */
  async listUsableInBase(
    scope: OrgScope,
    baseId: Id<'bse'>,
    kind?: BaseSecretKind,
  ): Promise<{ id: Id<'sec'>; kind: BaseSecretKind; name: string }[]> {
    let query = this.executor(scope)
      .selectFrom('meta.secrets as s')
      .select(['s.id', 's.kind', 's.name'])
      .where('s.organization_id', '=', scope.organizationId)
      .where('s.kind', 'in', [...BASE_SECRET_KINDS])
      .where((eb) =>
        eb.or([
          eb('s.base_scope', '=', 'all'),
          eb.exists(
            eb
              .selectFrom('meta.secret_bases as b')
              .select(sql`1`.as('one'))
              .where('b.organization_id', '=', scope.organizationId)
              .whereRef('b.secret_id', '=', 's.id')
              .where('b.base_id', '=', baseId),
          ),
        ]),
      );
    if (kind !== undefined) query = query.where('s.kind', '=', kind);
    const rows = await query
      .orderBy(sql`lower(s.name)`)
      .orderBy('s.id')
      .execute();
    return rows as { id: Id<'sec'>; kind: BaseSecretKind; name: string }[];
  }

  /** The secret (with its sealed value) when an automation of `baseId` may use it as `kind`. */
  async findUsable(
    scope: OrgScope,
    id: Id<'sec'>,
    baseId: Id<'bse'>,
    kind: SecretKind,
  ): Promise<SecretRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.secrets as s')
      .selectAll('s')
      .where('s.organization_id', '=', scope.organizationId)
      .where('s.id', '=', id)
      .where('s.kind', '=', kind)
      .where((eb) =>
        eb.or([
          eb('s.base_scope', '=', 'all'),
          eb.exists(
            eb
              .selectFrom('meta.secret_bases as b')
              .select(sql`1`.as('one'))
              .where('b.organization_id', '=', scope.organizationId)
              .whereRef('b.secret_id', '=', 's.id')
              .where('b.base_id', '=', baseId),
          ),
        ]),
      )
      .executeTakeFirst();
  }
}
