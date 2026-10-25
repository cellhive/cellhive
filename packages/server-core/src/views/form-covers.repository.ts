import { newId, type Id } from '@cellhive/contracts';
import { sql, type ExpressionBuilder } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { Database, FormCoverRow } from '../db/schema.js';

/** Storage key of a cover: `{organization_id}/{attachment_id}`, like attachments (SPEC §16). */
export function formCoverObjectKey(organizationId: Id<'org'>, id: Id<'att'>): string {
  return `${organizationId}/${id}`;
}

export interface CreateFormCoverInput {
  readonly baseId: Id<'bse'>;
  readonly tableId: Id<'tbl'>;
  readonly viewId: Id<'viw'>;
  readonly createdBy: Id<'usr'>;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
}

/**
 * Whether a form view of the cover's organization names it as its cover
 * (`config.form.cover_attachment_id`): the only thing that keeps a cover.
 */
export function namedByAView(eb: ExpressionBuilder<Database, 'meta.form_covers'>) {
  return eb.exists(
    eb
      .selectFrom('meta.views as v')
      .select('v.id')
      .whereRef('v.organization_id', '=', 'meta.form_covers.organization_id')
      .where('v.type', '=', 'form')
      .where(
        sql<string>`v.config -> 'form' ->> 'cover_attachment_id'`,
        '=',
        eb.ref('meta.form_covers.id'),
      ),
  );
}

/**
 * `meta.form_covers` (migration 0019, BACKLOG T419): cover images of form
 * views. Every query is scoped by `organization_id`: a cover of another
 * organization behaves exactly like a missing one. Permission checks belong
 * to the callers (the form cover service).
 */
export class FormCoversRepository
  extends TenantRepository<'form_covers'>
  implements TenantRepositoryContract<FormCoversRepository>
{
  constructor(db: Db) {
    super(db, 'form_covers');
  }

  /** A new upload (`pending_upload`) stored under its own key. */
  async create(scope: OrgScope, input: CreateFormCoverInput): Promise<FormCoverRow> {
    const id = newId('att');
    return this.executor(scope)
      .insertInto('meta.form_covers')
      .values({
        id,
        organization_id: scope.organizationId,
        base_id: input.baseId,
        table_id: input.tableId,
        view_id: input.viewId,
        object_key: formCoverObjectKey(scope.organizationId, id),
        filename: input.filename,
        mime: input.mime,
        size: input.size,
        created_by: input.createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async getById(scope: OrgScope, id: Id<'att'>): Promise<FormCoverRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.form_covers')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** A cover locked `FOR SHARE` in the scope's transaction (a view naming it, T419). */
  async lockShared(scope: OrgScope, id: Id<'att'>): Promise<FormCoverRow | undefined> {
    const query = this.executor(scope)
      .selectFrom('meta.form_covers')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id);
    return scope.tx === undefined ? query.executeTakeFirst() : query.forShare().executeTakeFirst();
  }

  /**
   * `pending_upload` → `ready` with the size and SHA-256 `complete` checked;
   * `undefined` when the row is missing or not pending (a concurrent call won).
   */
  async markReady(
    scope: OrgScope,
    id: Id<'att'>,
    result: { readonly size: number; readonly sha256: string },
  ): Promise<FormCoverRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.form_covers')
      .set({ status: 'ready', size: result.size, sha256: result.sha256 })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('status', '=', 'pending_upload')
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Among `ids`, the covers the cleanup may delete, locked `FOR UPDATE`:
   * uploaded before `createdBefore` and named by no form view of the
   * organization (same rule as `listExpiredFormCovers`, re-checked under the
   * lock).
   */
  async lockUnused(
    scope: OrgScope,
    ids: readonly Id<'att'>[],
    createdBefore: Date,
  ): Promise<FormCoverRow[]> {
    if (ids.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.form_covers')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...ids])
      .where('created_at', '<', createdBefore)
      .where((eb) => eb.not(namedByAView(eb)))
      .orderBy('id')
      .forUpdate()
      .execute();
  }

  async deleteByIds(scope: OrgScope, ids: readonly Id<'att'>[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.executor(scope)
      .deleteFrom('meta.form_covers')
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...ids])
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
