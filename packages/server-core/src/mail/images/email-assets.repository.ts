import { newId, type EmailAssetKind, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { EmailAssetRow } from '../../db/schema.js';

/** Storage key of an email asset: `{organization_id}/{id}`, like attachments (SPEC §16). */
export function emailAssetObjectKey(organizationId: Id<'org'>, id: Id<'att'>): string {
  return `${organizationId}/${id}`;
}

/**
 * Whether something an email shows still references the asset `a`
 * (`asset:<id>` in its Markdown): for a signature asset, the organization's
 * default signature or the signature of one of its sender identities; for
 * an automation asset, the definition of its automation (deleted ones
 * included: a deleted automation can be restored). The only thing that keeps
 * an asset. Static SQL over the alias `a` of `meta.email_assets`.
 */
export const EMAIL_ASSET_REFERENCED = sql<boolean>`(
  CASE a.kind
    WHEN 'signature' THEN
      strpos(
        coalesce(
          (SELECT o.settings -> 'email' ->> 'default_signature_md'
             FROM meta.organizations o
            WHERE o.id = a.organization_id),
          ''),
        'asset:' || a.id) > 0
      OR EXISTS (
        SELECT 1 FROM meta.email_identities i
         WHERE i.organization_id = a.organization_id
           AND strpos(coalesce(i.signature_md, ''), 'asset:' || a.id) > 0)
    ELSE EXISTS (
      SELECT 1 FROM meta.automations t
       WHERE t.organization_id = a.organization_id
         AND t.id = a.automation_id
         AND strpos(t.definition::text, 'asset:' || a.id) > 0)
  END)`;

export interface CreateEmailAssetInput {
  readonly kind: EmailAssetKind;
  /** The automation of an `automation` asset; `null` for a signature asset. */
  readonly automationId: Id<'aut'> | null;
  readonly createdBy: Id<'usr'>;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
}

/** What `complete` stores once the image is processed. */
export interface ProcessedEmailAsset {
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

/**
 * `meta.email_assets` (migration 0035, BACKLOG T534): images uploaded for
 * automation emails. Every query is scoped by `organization_id`: an asset of
 * another organization behaves exactly like a missing one. Permission
 * checks (organization owner/admin, automation manager) belong to the
 * callers.
 */
export class EmailAssetsRepository
  extends TenantRepository<'email_assets'>
  implements TenantRepositoryContract<EmailAssetsRepository>
{
  constructor(db: Db) {
    super(db, 'email_assets');
  }

  /** A new upload (`pending_upload`) stored under its own key. */
  async create(scope: OrgScope, input: CreateEmailAssetInput): Promise<EmailAssetRow> {
    const id = newId('att');
    return this.executor(scope)
      .insertInto('meta.email_assets')
      .values({
        id,
        organization_id: scope.organizationId,
        kind: input.kind,
        automation_id: input.kind === 'automation' ? input.automationId : null,
        object_key: emailAssetObjectKey(scope.organizationId, id),
        filename: input.filename,
        mime: input.mime,
        size: input.size,
        created_by: input.createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * A `ready` copy of `source` under its own id and key, not attached to any
   * automation yet (`automation_id = NULL`): what duplicating an automation
   * stages before its object is copied (BACKLOG T551). Nothing references a
   * staged copy, so `attachments.cleanup` deletes it — row and object — 24
   * hours later unless `attachCopies` gives it its automation first.
   */
  async insertCopy(
    scope: OrgScope,
    source: EmailAssetRow,
    createdBy: Id<'usr'>,
  ): Promise<EmailAssetRow> {
    const id = newId('att');
    return this.executor(scope)
      .insertInto('meta.email_assets')
      .values({
        id,
        organization_id: scope.organizationId,
        kind: 'automation',
        automation_id: null,
        object_key: emailAssetObjectKey(scope.organizationId, id),
        filename: source.filename,
        mime: source.mime,
        size: Number(source.size),
        width: source.width,
        height: source.height,
        sha256: source.sha256,
        status: 'ready',
        created_by: createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Gives the staged copies `ids` (`insertCopy`: ready automation assets of
   * no automation) to `automationId`; returns how many were attached — fewer
   * than `ids` when one is missing (the cleanup deleted it) or not staged.
   */
  async attachCopies(
    scope: OrgScope,
    ids: readonly Id<'att'>[],
    automationId: Id<'aut'>,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.executor(scope)
      .updateTable('meta.email_assets')
      .set({ automation_id: automationId })
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...ids])
      .where('kind', '=', 'automation')
      .where('automation_id', 'is', null)
      .where('status', '=', 'ready')
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async getById(scope: OrgScope, id: Id<'att'>): Promise<EmailAssetRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.email_assets')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** The `ready` assets among `ids` (others, and other organizations', are absent). */
  async getReady(scope: OrgScope, ids: readonly string[]): Promise<EmailAssetRow[]> {
    if (ids.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.email_assets')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...new Set(ids)] as Id<'att'>[])
      .where('status', '=', 'ready')
      .execute();
  }

  /**
   * `pending_upload` → `ready` with the processed image; `undefined` when
   * the row is missing or not pending (a concurrent call won).
   */
  async markReady(
    scope: OrgScope,
    id: Id<'att'>,
    processed: ProcessedEmailAsset,
  ): Promise<EmailAssetRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.email_assets')
      .set({
        status: 'ready',
        mime: processed.mime,
        size: processed.size,
        sha256: processed.sha256,
        width: processed.width,
        height: processed.height,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('status', '=', 'pending_upload')
      .returningAll()
      .executeTakeFirst();
  }

  /** Whether a signature or automation of the organization references the asset. */
  async isReferenced(scope: OrgScope, id: Id<'att'>): Promise<boolean> {
    const row = await this.executor(scope)
      .selectFrom('meta.email_assets as a')
      .select(EMAIL_ASSET_REFERENCED.as('referenced'))
      .where('a.organization_id', '=', scope.organizationId)
      .where('a.id', '=', id)
      .executeTakeFirst();
    return row?.referenced === true;
  }

  /**
   * Among `ids`, the assets the cleanup may delete, locked `FOR UPDATE`:
   * uploaded before `createdBefore` and referenced by nothing (same rule as
   * `listExpiredEmailAssets`, re-checked under the lock).
   */
  async lockUnreferenced(
    scope: OrgScope,
    ids: readonly Id<'att'>[],
    createdBefore: Date,
  ): Promise<EmailAssetRow[]> {
    if (ids.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.email_assets as a')
      .selectAll('a')
      .where('a.organization_id', '=', scope.organizationId)
      .where('a.id', 'in', [...ids])
      .where('a.created_at', '<', createdBefore)
      .where(sql<boolean>`NOT ${EMAIL_ASSET_REFERENCED}`)
      .orderBy('a.id')
      .forUpdate()
      .execute();
  }

  /** The asset locked `FOR UPDATE` in the scope's transaction (deleting it). */
  async lockById(scope: OrgScope, id: Id<'att'>): Promise<EmailAssetRow | undefined> {
    const query = this.executor(scope)
      .selectFrom('meta.email_assets')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id);
    return scope.tx === undefined ? query.executeTakeFirst() : query.forUpdate().executeTakeFirst();
  }

  async deleteByIds(scope: OrgScope, ids: readonly Id<'att'>[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.executor(scope)
      .deleteFrom('meta.email_assets')
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...ids])
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
