import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';

import { requestRunAsRevalidation } from '../../automation/revalidate/request.js';
import { publishPermissionChanged } from '../../realtime/publishers.js';
import { countOf, type Page, type PageRequest } from '../page.js';
import { principalMatches, type PrincipalRef } from '../principal.js';
import { TenantRepository, type OrgScope, type TenantRepositoryContract } from '../repository.js';

import type { Db, DbExecutor } from '../create-db.js';
import type { Base, JsonbInput } from '../schema.js';

/**
 * `id` of the hidden base `baseId` of the organization when `importJobId`
 * is building it (CONTRACTS §12.2), as a subquery: rows of other tables are
 * removed by a purge only through it, so a purge can never reach a base
 * that is not being imported.
 */
export function importingBaseIdQuery(
  executor: DbExecutor,
  scope: OrgScope,
  baseId: Id<'bse'>,
  importJobId: Id<'job'>,
) {
  return executor
    .selectFrom('meta.bases')
    .select('meta.bases.id')
    .where('meta.bases.organization_id', '=', scope.organizationId)
    .where('meta.bases.id', '=', baseId)
    .where('meta.bases.import_job_id', '=', importJobId);
}

export interface CreateBaseInput {
  readonly id?: Id<'bse'>;
  readonly workspaceId: Id<'wsp'>;
  readonly ownerId: Id<'usr'>;
  readonly name: string;
  readonly icon?: string | null;
  readonly description?: string | null;
  readonly settings?: JsonbInput;
  /**
   * A base built by this `base.import` job (CONTRACTS §12.2): created
   * hidden — `deleted_at` set and `import_job_id` naming the job — until
   * {@link BasesRepository.finishImport}.
   */
  readonly importJobId?: Id<'job'>;
}

export interface UpdateBaseInput {
  readonly name?: string;
  readonly icon?: string | null;
  readonly description?: string | null;
  readonly settings?: JsonbInput;
  /** Transfers ownership (SPEC §14.1); also bumps `permission_version`. */
  readonly ownerId?: Id<'usr'>;
}

export interface GetBaseOptions {
  /**
   * Also return a base in the trash (`deleted_at` set). Default `false`. A
   * base being imported (`import_job_id` set) is never returned: it is not
   * in the trash, it does not exist yet.
   */
  readonly includeDeleted?: boolean;
}

export interface ListBasesOptions extends GetBaseOptions {
  /** Only these bases (an API token's `base_ids`, ADR-36 §1); `[]` lists none. */
  readonly onlyIds?: readonly Id<'bse'>[];
}

/**
 * `meta.bases`. Every query is scoped by `organization_id`; a base of another
 * organization behaves exactly like a missing one (`undefined`).
 *
 * Whenever `permission_version` moves (or a base enters or leaves the
 * trash) a `permission.changed` envelope goes to the realtime bus attached
 * to the `Db`, after the transaction commits (SPEC §15).
 */
export class BasesRepository
  extends TenantRepository<'bases'>
  implements TenantRepositoryContract<BasesRepository>
{
  constructor(db: Db) {
    super(db, 'bases');
  }

  async create(scope: OrgScope, input: CreateBaseInput): Promise<Base> {
    return this.executor(scope)
      .insertInto('meta.bases')
      .values({
        id: input.id ?? newId('bse'),
        organization_id: scope.organizationId,
        workspace_id: input.workspaceId,
        owner_id: input.ownerId,
        name: input.name,
        icon: input.icon ?? null,
        description: input.description ?? null,
        ...(input.settings === undefined ? {} : { settings: input.settings }),
        ...(input.importJobId === undefined
          ? {}
          : { import_job_id: input.importJobId, deleted_at: sql<Date>`now()` }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async getById(
    scope: OrgScope,
    id: Id<'bse'>,
    options: GetBaseOptions = {},
  ): Promise<Base | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.bases')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id);
    // A base being imported is always in the trash (`bases_import_hidden_check`).
    query =
      options.includeDeleted === true
        ? query.where('import_job_id', 'is', null)
        : query.where('deleted_at', 'is', null);
    return query.executeTakeFirst();
  }

  /**
   * Locks a base outside the trash (`FOR UPDATE`) until the end of the
   * scope's transaction, serialising changes to its roles; `undefined` when
   * not found in this organization.
   */
  async lockForUpdate(scope: OrgScope, id: Id<'bse'>): Promise<Base | undefined> {
    return this.executor(scope)
      .selectFrom('meta.bases')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Bases of a workspace outside the trash, oldest first. */
  async listByWorkspace(scope: OrgScope, workspaceId: Id<'wsp'>): Promise<Base[]> {
    return this.executor(scope)
      .selectFrom('meta.bases')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('workspace_id', '=', workspaceId)
      .where('deleted_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  /** Updates a base outside the trash; `undefined` when not found in this organization. */
  async update(scope: OrgScope, id: Id<'bse'>, patch: UpdateBaseInput): Promise<Base | undefined> {
    const values = {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.icon === undefined ? {} : { icon: patch.icon }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.settings === undefined ? {} : { settings: patch.settings }),
      ...(patch.ownerId === undefined
        ? {}
        : {
            owner_id: patch.ownerId,
            permission_version: sql<bigint>`permission_version + 1`,
          }),
    };
    if (Object.keys(values).length === 0) return this.getById(scope, id);
    const base = await this.executor(scope)
      .updateTable('meta.bases')
      .set(values)
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (base !== undefined && patch.ownerId !== undefined) {
      await this.permissionChanged(scope, [base.id]);
    }
    return base;
  }

  /**
   * One page of bases of a workspace outside the trash, by name. With
   * `visibleTo`, only bases the principal owns or has a role in (directly or
   * through a group). With `includeDeleted`, bases in the trash are listed
   * too: all of them, or with `visibleTo` only the ones the principal owns.
   */
  async listPage(
    scope: OrgScope,
    workspaceId: Id<'wsp'>,
    page: PageRequest,
    visibleTo?: PrincipalRef,
    options: ListBasesOptions = {},
  ): Promise<Page<Base>> {
    const { onlyIds } = options;
    if (onlyIds?.length === 0) return { items: [], total: 0 };
    const filtered = () =>
      this.executor(scope)
        .selectFrom('meta.bases as b')
        .where('b.organization_id', '=', scope.organizationId)
        .where('b.workspace_id', '=', workspaceId)
        .$if(onlyIds !== undefined, (query) => query.where('b.id', 'in', onlyIds ?? []))
        .where((eb) => {
          const active = eb('b.deleted_at', 'is', null);
          const live =
            visibleTo === undefined
              ? active
              : eb.and([
                  active,
                  eb.or([
                    eb('b.owner_id', '=', visibleTo.userId),
                    eb.exists(
                      eb
                        .selectFrom('meta.base_role_members')
                        .select(sql<number>`1`.as('one'))
                        .where('organization_id', '=', scope.organizationId)
                        .whereRef('base_id', '=', 'b.id')
                        .where(principalMatches('meta.base_role_members', visibleTo)),
                    ),
                  ]),
                ]);
          if (options.includeDeleted !== true) return live;
          // A base being imported is hidden, not in the trash (CONTRACTS §12.2).
          const inTrash = eb.and([
            eb('b.deleted_at', 'is not', null),
            eb('b.import_job_id', 'is', null),
          ]);
          const trashed =
            visibleTo === undefined
              ? inTrash
              : eb.and([inTrash, eb('b.owner_id', '=', visibleTo.userId)]);
          return eb.or([live, trashed]);
        });
    const items = await filtered()
      .selectAll('b')
      .orderBy(sql`lower(b.name)`)
      .orderBy('b.id')
      .offset(page.offset)
      .limit(page.limit)
      .execute();
    const total = await filtered()
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirst();
    return { items, total: countOf(total) };
  }

  /**
   * Moves a base to the trash; `undefined` when not found (or already there).
   * Nobody can open it any more, so realtime subscribers are re-checked.
   */
  async softDelete(scope: OrgScope, id: Id<'bse'>): Promise<Base | undefined> {
    const base = await this.executor(scope)
      .updateTable('meta.bases')
      .set({ deleted_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (base !== undefined) await this.permissionChanged(scope, [base.id]);
    return base;
  }

  /**
   * Takes a base out of the trash and increases its `permission_version`;
   * `undefined` when not found in this organization or not in the trash (a
   * base being imported is not in the trash: only its job unhides it).
   */
  async restore(scope: OrgScope, id: Id<'bse'>): Promise<Base | undefined> {
    const base = await this.executor(scope)
      .updateTable('meta.bases')
      .set({ deleted_at: null, permission_version: sql<bigint>`permission_version + 1` })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is not', null)
      .where('import_job_id', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (base !== undefined) await this.permissionChanged(scope, [base.id]);
    return base;
  }

  /**
   * The hidden base `importJobId` is building (CONTRACTS §12.2), locked
   * `FOR UPDATE` until the end of the scope's transaction when it has one;
   * `undefined` when there is none in this organization. With `id`, only
   * that base.
   */
  async findImporting(
    scope: OrgScope,
    importJobId: Id<'job'>,
    id?: Id<'bse'>,
  ): Promise<Base | undefined> {
    const query = this.executor(scope)
      .selectFrom('meta.bases')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('import_job_id', '=', importJobId)
      .$if(id !== undefined, (q) => q.where('id', '=', id as Id<'bse'>));
    return scope.tx === undefined ? query.executeTakeFirst() : query.forUpdate().executeTakeFirst();
  }

  /**
   * The end of an import: the hidden base of `importJobId` becomes a base
   * like any other (`deleted_at` and `import_job_id` cleared, a new
   * `permission_version`); `undefined` when the job has no such base here.
   */
  async finishImport(
    scope: OrgScope,
    id: Id<'bse'>,
    importJobId: Id<'job'>,
  ): Promise<Base | undefined> {
    const base = await this.executor(scope)
      .updateTable('meta.bases')
      .set({
        deleted_at: null,
        import_job_id: null,
        permission_version: sql<bigint>`permission_version + 1`,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('import_job_id', '=', importJobId)
      .returningAll()
      .executeTakeFirst();
    if (base !== undefined) await this.permissionChanged(scope, [base.id]);
    return base;
  }

  /**
   * Deletes the row of the hidden base of `importJobId` (the last step of a
   * purge: its tables and files are gone by then); `false` when there is
   * none here.
   */
  async deleteImporting(scope: OrgScope, id: Id<'bse'>, importJobId: Id<'job'>): Promise<boolean> {
    const rows = await this.executor(scope)
      .deleteFrom('meta.bases')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('import_job_id', '=', importJobId)
      .returning('id')
      .execute();
    return rows.length > 0;
  }

  /** IDs of bases outside the trash owned by `userId`. */
  async idsOwnedBy(scope: OrgScope, userId: Id<'usr'>): Promise<Id<'bse'>[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.bases')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('owner_id', '=', userId)
      .where('deleted_at', 'is', null)
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * IDs of every base owned by `userId`, the trash included, locked
   * `FOR UPDATE` until the end of the scope's transaction; ordered by ID.
   */
  async lockIdsOwnedBy(scope: OrgScope, userId: Id<'usr'>): Promise<Id<'bse'>[]> {
    const rows = await this.executor(scope)
      .selectFrom('meta.bases')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('owner_id', '=', userId)
      .orderBy('id')
      .forUpdate()
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * Gives every base owned by `fromUserId` (the trash included) to
   * `toUserId` and bumps their `permission_version`. Returns the updated
   * bases, ordered by ID.
   */
  async transferOwnership(
    scope: OrgScope,
    fromUserId: Id<'usr'>,
    toUserId: Id<'usr'>,
  ): Promise<Base[]> {
    const rows = await this.executor(scope)
      .updateTable('meta.bases')
      .set({
        owner_id: toUserId,
        permission_version: sql<bigint>`permission_version + 1`,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('owner_id', '=', fromUserId)
      .returningAll()
      .execute();
    await this.permissionChanged(
      scope,
      rows.map((row) => row.id),
    );
    return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Increments `permission_version` (SPEC §14.1) of the given bases, of every
   * base in the given workspaces, or of every base of the organization
   * (`{ all: true }`). Returns the number of bases changed.
   */
  async bumpPermissionVersion(
    scope: OrgScope,
    target:
      | { readonly baseIds: readonly Id<'bse'>[] }
      | { readonly workspaceIds: readonly Id<'wsp'>[] }
      | { readonly all: true },
  ): Promise<number> {
    let query = this.executor(scope)
      .updateTable('meta.bases')
      .set({ permission_version: sql<bigint>`permission_version + 1` })
      .where('organization_id', '=', scope.organizationId);
    if ('baseIds' in target) {
      if (target.baseIds.length === 0) return 0;
      query = query.where('id', 'in', [...new Set(target.baseIds)]);
    } else if ('workspaceIds' in target) {
      if (target.workspaceIds.length === 0) return 0;
      query = query.where('workspace_id', 'in', [...new Set(target.workspaceIds)]);
    }
    const rows = await query.returning('id').execute();
    await this.permissionChanged(
      scope,
      rows.map((row) => row.id),
    );
    return rows.length;
  }

  /**
   * Realtime subscribers of these bases are re-checked once the change
   * commits (SPEC §15), and the `run_as` of their enabled automations in a
   * job queued in the same transaction (ADR-25 §5, BACKLOG T507).
   */
  private async permissionChanged(scope: OrgScope, baseIds: readonly Id<'bse'>[]): Promise<void> {
    await publishPermissionChanged(this.db, scope.tx, scope.organizationId, baseIds);
    if (baseIds.length === 0) return;
    const { tx } = scope;
    if (tx === undefined) {
      await this.db.withTx((inner) => requestRunAsRevalidation(this.db, inner, scope, baseIds));
    } else {
      await requestRunAsRevalidation(this.db, tx, scope, baseIds);
    }
  }
}
